import DatabaseConstructor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import { decodeHeights, encodeHeights } from '../src/persistence/codec.ts';
import {
  SNAPSHOT_RETENTION,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotStore,
} from '../src/persistence/snapshot-store.ts';
import { PluginHost } from '../src/plugins/host.ts';
import type { TerracePlugin } from '../src/plugins/types.ts';
import { World } from '../src/world/world.ts';
import { asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;

function counterPlugin(initial: number): TerracePlugin & { value: number } {
  const plugin = {
    name: 'counter',
    value: initial,
    persistence: {
      version: 1,
      save(): unknown {
        return { value: plugin.value };
      },
      load(data: unknown): void {
        plugin.value = (data as { value: number }).value;
      },
    },
  };
  return plugin;
}

describe('heightmap codec', () => {
  it('round-trips negative and positive heights', () => {
    const cells = new Int16Array([0, 1, -1, 1024, -1024, 32767, -32768]);
    const decoded = decodeHeights(encodeHeights(cells), cells.length);
    expect(Array.from(decoded)).toEqual(Array.from(cells));
  });

  it('rejects a blob whose length does not match the world', () => {
    const blob = encodeHeights(new Int16Array(10));
    expect(() => decodeHeights(blob, 11)).toThrow(RangeError);
  });
});

describe('SnapshotStore', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'terrace-test-'));
    dbPath = join(dir, 'nested', 'world.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips heightmap, mask and plugin slices across a restart', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.applySculpt(8, 8, 3, 128);
    world.unlockChunk(2, 2);
    const plugin = counterPlugin(7);

    const store = SnapshotStore.open(dbPath);
    const host = new PluginHost(world, [asLoadedPlugin(plugin)]);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: host.collectPersistence(),
    });
    world.markSnapshotted();
    expect(world.dirty).toBe(false);
    store.close();

    const reopened = SnapshotStore.open(dbPath);
    const snapshot = reopened.loadLatest();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(snapshot.worldSize).toBe(WORLD_SIZE);
    const restored = World.restore(
      snapshot.worldSize,
      snapshot.cells,
      snapshot.mask,
      undefined,
      snapshot.name,
    );
    expect(snapshot.name).toBe(world.name);
    expect(restored.name).toBe(world.name);
    expect(Array.from(restored.map.cells)).toEqual(Array.from(world.map.cells));
    expect(Array.from(restored.mask)).toEqual(Array.from(world.mask));
    expect(restored.isChunkUnlocked(0, 0)).toBe(true);
    expect(restored.isChunkUnlocked(2, 2)).toBe(true);
    expect(restored.isChunkUnlocked(3, 3)).toBe(false);

    const restoredPlugin = counterPlugin(0);
    new PluginHost(restored, [asLoadedPlugin(restoredPlugin)]).restorePersistence(
      snapshot.pluginSlices,
    );
    expect(restoredPlugin.value).toBe(7);

    reopened.close();
  });

  it('round-trips per-token unlock masks across a restart', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.addPlayer({ id: 'session-a', token: 'token-a', name: 'A' });
    world.unlockChunkForToken('token-a', 2, 2);

    const store = SnapshotStore.open(dbPath);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
      tokenMasks: world.tokenMasks(),
    });
    store.close();

    const reopened = SnapshotStore.open(dbPath);
    const snapshot = reopened.loadLatest();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(Array.from(snapshot.tokenMasks.keys())).toEqual(['token-a']);
    const restored = World.restore(
      snapshot.worldSize,
      snapshot.cells,
      snapshot.mask,
      undefined,
      snapshot.name,
      snapshot.tokenMasks,
    );
    expect(restored.isChunkUnlockedForToken('token-a', 2, 2)).toBe(true);
    reopened.close();
  });

  it('a snapshot saved WITHOUT tokenMasks reads back with an empty map, not undefined', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const store = SnapshotStore.open(dbPath);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
    });

    const snapshot = store.loadLatest();
    expect(snapshot?.tokenMasks).toBeInstanceOf(Map);
    expect(snapshot?.tokenMasks.size).toBe(0);
    store.close();
  });

  it('returns null for a fresh database', () => {
    const store = SnapshotStore.open(dbPath);
    expect(store.loadLatest()).toBeNull();
    store.close();
  });

  it(`keeps a rolling history of ${SNAPSHOT_RETENTION} snapshots`, () => {
    const store = SnapshotStore.open(dbPath);
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const extra = 5;

    const ids: number[] = [];
    for (let i = 0; i < SNAPSHOT_RETENTION + extra; i++) {
      world.applySculpt(8, 8, 1, 1);
      ids.push(
        store.saveSnapshot({
          worldSize: world.size,
          name: world.name,
          cells: world.map.cells,
          mask: world.mask,
          pluginSlices: { counter: { value: i } },
        }),
      );
    }

    expect(store.countSnapshots()).toBe(SNAPSHOT_RETENTION);

    const latest = store.loadLatest();
    expect(latest?.id).toBe(ids[ids.length - 1]);
    expect(latest?.pluginSlices).toEqual({ counter: { value: SNAPSHOT_RETENTION + extra - 1 } });

    const raw = new DatabaseConstructor(dbPath);
    const orphans = raw
      .prepare(
        'SELECT COUNT(*) AS n FROM plugin_slices WHERE snapshot_id NOT IN (SELECT id FROM snapshots)',
      )
      .get() as { n: number };
    raw.close();
    expect(orphans.n).toBe(0);

    store.close();
  });

  it('refuses a snapshot with an in-Int16, out-of-height-range cell', () => {
    const store = SnapshotStore.open(dbPath);
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const corruptCells = new Int16Array(world.map.cells);
    const CORRUPT_INDEX = 42;
    const CORRUPT_VALUE = 5000;
    corruptCells[CORRUPT_INDEX] = CORRUPT_VALUE;

    const id = store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: corruptCells,
      mask: world.mask,
      pluginSlices: {},
    });
    store.close();

    const reopened = SnapshotStore.open(dbPath);
    expect(() => reopened.loadLatest()).toThrow(
      new RegExp(`snapshot #${id}.*cell ${CORRUPT_INDEX}.*${CORRUPT_VALUE}`),
    );
    reopened.close();
  });

  it('refuses a snapshot written by an incompatible schema version', () => {
    const store = SnapshotStore.open(dbPath);
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
    });
    store.close();

    const raw = new DatabaseConstructor(dbPath);
    raw.prepare('UPDATE snapshots SET schema_version = ?').run(SNAPSHOT_SCHEMA_VERSION + 1);
    raw.close();

    const reopened = SnapshotStore.open(dbPath);
    expect(() => reopened.loadLatest()).toThrow(/schema version/);
    reopened.close();
  });

  it('rejects restoring a snapshot into a differently sized world', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    expect(() => World.restore(WORLD_SIZE * 2, world.map.cells, world.mask)).toThrow(RangeError);
  });

  it('migrates a database created before world names, reading its world as unnamed', () => {
    const legacyPath = join(dir, 'legacy.db');
    const legacy = new DatabaseConstructor(legacyPath);
    legacy.exec(`
      CREATE TABLE snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        created_at     INTEGER NOT NULL,
        world_size     INTEGER NOT NULL,
        heightmap      BLOB    NOT NULL,
        mask           BLOB    NOT NULL
      );
      CREATE TABLE plugin_slices (
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        plugin      TEXT    NOT NULL,
        data        TEXT    NOT NULL,
        PRIMARY KEY (snapshot_id, plugin)
      );
    `);
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    legacy
      .prepare(
        `INSERT INTO snapshots (schema_version, created_at, world_size, heightmap, mask)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        SNAPSHOT_SCHEMA_VERSION,
        Date.now(),
        world.size,
        encodeHeights(world.map.cells),
        Buffer.copyBytesFrom(world.mask),
      );
    legacy.close();

    const store = SnapshotStore.open(legacyPath);
    const snapshot = store.loadLatest();
    expect(snapshot?.name).toBeNull();
    expect(snapshot?.tokenMasks.size).toBe(0);
    expect(Array.from(snapshot?.mask ?? [])).toEqual(Array.from(world.mask));

    store.saveSnapshot({
      worldSize: world.size,
      name: 'The Sundered Reach',
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
    });
    expect(store.loadLatest()?.name).toBe('The Sundered Reach');
    store.close();
  });
});

describe('World naming', () => {
  it('names a fresh world', () => {
    expect(World.createFresh(WORLD_SIZE).name.length).toBeGreaterThan(0);
  });

  it('restores a stored name verbatim, without dirtying the world', () => {
    const source = World.createFresh(WORLD_SIZE);
    const restored = World.restore(
      WORLD_SIZE,
      source.map.cells,
      source.mask,
      undefined,
      'Gloamwatch Fells',
    );
    expect(restored.name).toBe('Gloamwatch Fells');
    expect(restored.dirty).toBe(false);
  });

  it('mints a name for an unnamed world AND marks it dirty so the name reaches disk', () => {
    const source = World.createFresh(WORLD_SIZE);
    for (const stored of [null, '   ']) {
      const restored = World.restore(WORLD_SIZE, source.map.cells, source.mask, undefined, stored);
      expect(restored.name.length).toBeGreaterThan(0);
      expect(restored.dirty).toBe(true);
    }
  });
});
