import DatabaseConstructor from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_BAND,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  bandLevelHeight,
  drawnBandOfSample,
  floorBandOfHeight,
  isGapDrawn,
  readSpans,
  spanCapBand,
} from '@terrace/shared';
import { decodeHeights, encodeHeights } from '../src/persistence/codec.ts';
import {
  OLDEST_READABLE_SCHEMA_VERSION,
  SNAPSHOT_RETENTION,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotStore,
} from '../src/persistence/snapshot-store.ts';
import { PluginHost } from '../src/plugins/host.ts';
import type { TerracePlugin } from '../src/plugins/types.ts';
import { World } from '../src/world/world.ts';
import {
  asLoadedPlugin,
  packRawFloorColumnSpans,
  worldWithUnlockedChunks,
  type RawFloorSpan,
} from './support/harness.ts';

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

  it('round-trips the layered columns a carve leaves, remnant included', () => {
    const CLIFF_BAND = 4;
    const GROUND_BAND = 1;
    const CARVE_BAND = 2;
    const CLIFF_EDGE = CHUNK_SIZE / 2;

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    for (let y = 0; y < world.size; y++) {
      for (let x = 0; x < world.size; x++) {
        world.map.cells[y * world.size + x] =
          x >= CLIFF_EDGE ? bandLevelHeight(CLIFF_BAND) : bandLevelHeight(GROUND_BAND);
      }
    }
    // A cut at the cliff's lowest lip opens a tunnel mouth: floor, gap, roof.
    const diff = world.applySculpt(CLIFF_EDGE, 8, 2, -BAND_HEIGHT, {
      tool: 'carve',
      spanBand: CARVE_BAND,
    });
    expect(diff.length).toBeGreaterThan(0);
    const spans = world.spansForPersistence();
    expect(spans.size).toBeGreaterThan(0);
    const carved = diff.find((cell) => cell.spans !== undefined);
    expect(carved).toBeDefined();
    const cut = readSpans(world.map, carved!.x, carved!.y);
    expect(cut.length).toBe(2);
    expect(cut[0]!.floorBand).toBe(BEDROCK_BAND);
    expect(cut[1]!.floorBand).toBeGreaterThan(spanCapBand(cut[0]!) + 1);

    const store = SnapshotStore.open(dbPath);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
      columnSpans: spans,
    });
    store.close();

    const reopened = SnapshotStore.open(dbPath);
    const snapshot = reopened.loadLatest();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    const restored = World.restore(
      snapshot.worldSize,
      snapshot.cells,
      snapshot.mask,
      undefined,
      snapshot.name,
      snapshot.tokenMasks,
      0,
      null,
      snapshot.columnSpans,
    );

    expect(Array.from(restored.map.cells)).toEqual(Array.from(world.map.cells));
    expect(restored.spansForPersistence().size).toBe(spans.size);
    for (const [cell, packed] of spans) {
      expect(Array.from(restored.spansForPersistence().get(cell) ?? [])).toEqual(
        Array.from(packed),
      );
    }
    reopened.close();
  });

  it('a column cut down to the bedrock band alone rides back as a plain height', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    world.map.cells[8 * world.size + 8] = BEDROCK_FLOOR;

    const store = SnapshotStore.open(dbPath);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
      columnSpans: world.spansForPersistence(),
    });

    const snapshot = store.loadLatest();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.columnSpans.size).toBe(0);

    const restored = World.restore(
      snapshot.worldSize,
      snapshot.cells,
      snapshot.mask,
      undefined,
      snapshot.name,
      snapshot.tokenMasks,
      0,
      null,
      snapshot.columnSpans,
    );
    expect(readSpans(restored.map, 8, 8)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
    ]);
    store.close();
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

describe('reading a schema 1 world under the band-floor rule', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'terrace-v1-'));
    dbPath = join(dir, 'world.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A roof whose raw floor sits exactly on a band level converts losslessly; one
  // that sits inside a band rises to the band above, deepening the opening.
  const FLOOR_CEILING_BAND = 1;
  const ROOF_CEILING_BAND = 8;
  const EXACT_FLOOR_BAND = 4;
  const EXACT_CELL = 8 * WORLD_SIZE + 8;
  const RAISED_CELL = 9 * WORLD_SIZE + 9;

  const ROOF_CEILING = bandLevelHeight(ROOF_CEILING_BAND);
  const FLOOR_CEILING = bandLevelHeight(FLOOR_CEILING_BAND);
  const EXACT_RAW_FLOOR = bandLevelHeight(EXACT_FLOOR_BAND);
  const RAISED_RAW_FLOOR = EXACT_RAW_FLOOR + 1;

  function v1Column(rawFloor: number): readonly RawFloorSpan[] {
    return [
      { floor: BEDROCK_FLOOR, ceiling: FLOOR_CEILING },
      { floor: rawFloor, ceiling: ROOF_CEILING },
    ];
  }

  /** Overwrites the stored span table with `columns`, packed the way schema 1 wrote it. */
  function writeSpanTable(
    columns: ReadonlyMap<number, readonly RawFloorSpan[]>,
    schemaVersion: number,
  ): void {
    const raw = new DatabaseConstructor(dbPath);
    raw
      .prepare('UPDATE snapshots SET schema_version = ?, column_spans = ?')
      .run(schemaVersion, packRawFloorColumnSpans(columns));
    raw.close();
  }

  /** Plants a genuine schema 1 row: raw span floors, version 1 on the row. */
  function plantV1Columns(columns: ReadonlyMap<number, readonly RawFloorSpan[]>): void {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    for (const [cellIndex, spans] of columns) {
      world.map.cells[cellIndex] = spans[spans.length - 1]!.ceiling;
    }

    const store = SnapshotStore.open(dbPath);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
    });
    store.close();

    writeSpanTable(columns, OLDEST_READABLE_SCHEMA_VERSION);
  }

  function plantV1Snapshot(): void {
    plantV1Columns(
      new Map([
        [EXACT_CELL, v1Column(EXACT_RAW_FLOOR)],
        [RAISED_CELL, v1Column(RAISED_RAW_FLOOR)],
      ]),
    );
  }

  function schemaVersionsOnDisk(): number[] {
    const raw = new DatabaseConstructor(dbPath, { readonly: true });
    const rows = raw
      .prepare('SELECT schema_version AS v FROM snapshots ORDER BY id')
      .all() as { v: number }[];
    raw.close();
    return rows.map((row) => row.v);
  }

  it('floors each schema 1 span in the lowest band whose level clears its raw floor', () => {
    plantV1Snapshot();

    const store = SnapshotStore.open(dbPath);
    const snapshot = store.loadLatest();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(snapshot.columnSpans.get(EXACT_CELL)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: FLOOR_CEILING },
      { floorBand: EXACT_FLOOR_BAND, ceiling: ROOF_CEILING },
    ]);
    // A floor inside band 4 starts the slab at band 5, so band 4 becomes air:
    // the saved opening is a band deeper under the new rule.
    expect(snapshot.columnSpans.get(RAISED_CELL)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: FLOOR_CEILING },
      { floorBand: EXACT_FLOOR_BAND + 1, ceiling: ROOF_CEILING },
    ]);
    expect(drawnBandOfSample(RAISED_RAW_FLOOR)).toBe(EXACT_FLOOR_BAND);
    store.close();
  });

  it('rewrites a schema 1 world as schema 2, and reloads it identically', () => {
    plantV1Snapshot();

    const store = SnapshotStore.open(dbPath);
    const loaded = store.loadLatest();
    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    expect(schemaVersionsOnDisk()).toEqual([OLDEST_READABLE_SCHEMA_VERSION]);

    const restored = World.restore(
      loaded.worldSize,
      loaded.cells,
      loaded.mask,
      undefined,
      loaded.name,
      loaded.tokenMasks,
      0,
      null,
      loaded.columnSpans,
    );
    store.saveSnapshot({
      worldSize: restored.size,
      name: restored.name,
      cells: restored.map.cells,
      mask: restored.mask,
      pluginSlices: {},
      columnSpans: restored.spansForPersistence(),
    });
    store.close();

    expect(schemaVersionsOnDisk()).toEqual([
      OLDEST_READABLE_SCHEMA_VERSION,
      SNAPSHOT_SCHEMA_VERSION,
    ]);

    const reopened = SnapshotStore.open(dbPath);
    const reloaded = reopened.loadLatest();
    expect(reloaded?.columnSpans).toEqual(loaded.columnSpans);
    expect(Array.from(reloaded?.cells ?? [])).toEqual(Array.from(loaded.cells));
    reopened.close();
  });

  it('refuses a schema older than the oldest it can reinterpret', () => {
    plantV1Snapshot();
    const raw = new DatabaseConstructor(dbPath);
    raw
      .prepare('UPDATE snapshots SET schema_version = ?')
      .run(OLDEST_READABLE_SCHEMA_VERSION - 1);
    raw.close();

    const store = SnapshotStore.open(dbPath);
    expect(() => store.loadLatest()).toThrow(/schema version/);
    store.close();
  });

  // The v1 overhang slab was one band tall less a unit, so a fill at band 0
  // over ground capping in band -1 left a pair with no drawn gap.
  const V1_OVERHANG_SLAB_DEPTH = BAND_HEIGHT - 1;
  const NO_GAP_SLAB_CEILING = bandLevelHeight(0);
  const NO_GAP_GROUND_CEILING = bandLevelHeight(-1);
  const NO_GAP_SLAB_RAW_FLOOR = NO_GAP_SLAB_CEILING - V1_OVERHANG_SLAB_DEPTH;
  const MERGED_CELL = 4 * WORLD_SIZE + 4;

  const NO_GAP_COLUMN: readonly RawFloorSpan[] = [
    { floor: BEDROCK_FLOOR, ceiling: NO_GAP_GROUND_CEILING },
    { floor: NO_GAP_SLAB_RAW_FLOOR, ceiling: NO_GAP_SLAB_CEILING },
  ];

  it('states the premise: the v1 pair converts to bands 0 over -1, which is no drawn gap', () => {
    expect(floorBandOfHeight(NO_GAP_SLAB_RAW_FLOOR)).toBe(0);
    expect(drawnBandOfSample(NO_GAP_GROUND_CEILING)).toBe(-1);
    expect(
      isGapDrawn(
        { floorBand: BEDROCK_BAND, ceiling: NO_GAP_GROUND_CEILING },
        { floorBand: 0, ceiling: NO_GAP_SLAB_CEILING },
      ),
    ).toBe(false);
  });

  it('merges a schema 1 pair with no drawn gap and drops the column that leaves', () => {
    plantV1Columns(
      new Map([
        [MERGED_CELL, NO_GAP_COLUMN],
        [EXACT_CELL, v1Column(EXACT_RAW_FLOOR)],
      ]),
    );

    const store = SnapshotStore.open(dbPath);
    const snapshot = store.loadLatest();
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(snapshot.columnSpans.has(MERGED_CELL)).toBe(false);
    expect(snapshot.cells[MERGED_CELL]).toBe(NO_GAP_SLAB_CEILING);
    // A column that still has a drawn gap is untouched by the repair.
    expect(snapshot.columnSpans.get(EXACT_CELL)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: FLOOR_CEILING },
      { floorBand: EXACT_FLOOR_BAND, ceiling: ROOF_CEILING },
    ]);
    store.close();
  });

  it('keeps schema 2 strict: the same column refuses in raw-floor and in band form', () => {
    plantV1Columns(new Map([[MERGED_CELL, NO_GAP_COLUMN]]));

    for (const bytes of [
      NO_GAP_COLUMN,
      [
        { floor: BEDROCK_BAND, ceiling: NO_GAP_GROUND_CEILING },
        { floor: 0, ceiling: NO_GAP_SLAB_CEILING },
      ],
    ]) {
      writeSpanTable(new Map([[MERGED_CELL, bytes]]), SNAPSHOT_SCHEMA_VERSION);
      const store = SnapshotStore.open(dbPath);
      expect(() => store.loadLatest()).toThrow(/malformed 2-span list for cell/);
      store.close();
    }
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
