// Persistence tests run against a real SQLite file in a temp directory —
// acceptance criterion 6 ("kill the process, restart, the world comes back")
// is about a file on disk, so an in-memory database would test the wrong thing.

import DatabaseConstructor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const WORLD_SIZE = 64;

/** A plugin whose whole state is a counter, so a slice round-trip is visible. */
function counterPlugin(initial: number): TerracePlugin & { value: number } {
  const plugin = {
    name: 'counter',
    value: initial,
    persistence: {
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

    // --- first process ---
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

    // --- second process, same file ---
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
    // The world came back as ITSELF: same name, not a newly minted one.
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
      // Distinct terrain per snapshot so "the newest survived" is checkable.
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

    // The pruned snapshots took their plugin slices with them (cascade).
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

  // The upgrade path for a self-hoster whose world.db predates world names
  // (2026-08-14). It must open, not refuse: the name column is additive, so the
  // schema version is deliberately NOT bumped for it.
  it('migrates a database created before world names, reading its world as unnamed', () => {
    const legacyPath = join(dir, 'legacy.db');
    const legacy = new DatabaseConstructor(legacyPath);
    // The exact pre-2026-08-14 table: no world_name column at all.
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

    // …and the next snapshot this build writes carries a name, in the column
    // the migration added.
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
      // Without this, the snapshot scheduler (which writes only a dirty world)
      // would never persist the new name and every boot would re-draw one.
      expect(restored.dirty).toBe(true);
    }
  });
});
