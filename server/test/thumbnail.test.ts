// World thumbnails (2026-08-22).
//
// The contract worth pinning is not "it produces bytes" — it is that the
// picture is a faithful, cheap reduction of the world, and that a world
// without one is never broken by that.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL, WORLD_THUMBNAIL_SIZE, bandOf } from '@terrace/shared';
import { SnapshotStore } from '../src/persistence/snapshot-store.ts';
import { THUMBNAIL_BYTES, buildThumbnail } from '../src/persistence/thumbnail.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';
import { World } from '../src/world/world.ts';

const WORLD_SIZE = CHUNK_SIZE * 8;

let root: string;
let registry: WorldRegistry;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terrace-thumb-'));
  registry = new WorldRegistry(join(root, 'worlds'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A heightmap whose left half is deep sea and right half is high ground. */
function splitWorld(size: number, low: number, high: number): Int16Array {
  const cells = new Int16Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) cells[y * size + x] = x < size / 2 ? low : high;
  }
  return cells;
}

describe('buildThumbnail', () => {
  it('is always the same size, whatever the world', () => {
    for (const size of [CHUNK_SIZE, 128, 512, 2048]) {
      const cells = new Int16Array(size * size);
      expect(buildThumbnail(cells, size)).toHaveLength(THUMBNAIL_BYTES);
    }
  });

  it('keeps left-right structure, so a coastline is recognisable', () => {
    // The whole point of the picture: shape survives the reduction.
    const low = -8 * BAND_HEIGHT;
    const high = 10 * BAND_HEIGHT;
    const thumb = buildThumbnail(splitWorld(512, low, high), 512);

    const row = WORLD_THUMBNAIL_SIZE >> 1;
    expect(thumb.readInt8(row * WORLD_THUMBNAIL_SIZE + 2)).toBe(bandOf(low));
    expect(thumb.readInt8(row * WORLD_THUMBNAIL_SIZE + WORLD_THUMBNAIL_SIZE - 3)).toBe(
      bandOf(high),
    );
  });

  it('AVERAGES its block rather than sampling one cell from it', () => {
    // The moiré guard. A checkerboard alternating every cell averages to its
    // mean everywhere; a stride sampler would return one extreme or the other
    // and paint a grid that exists nowhere in the world.
    const size = 512;
    const cells = new Int16Array(size * size);
    const low = 0;
    const high = 8 * BAND_HEIGHT;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) cells[y * size + x] = (x + y) % 2 === 0 ? low : high;
    }

    const thumb = buildThumbnail(cells, size);
    const expected = bandOf((low + high) / 2);
    const values = new Set<number>();
    for (let i = 0; i < THUMBNAIL_BYTES; i++) values.add(thumb.readInt8(i));

    expect([...values]).toEqual([expected]);
  });

  it('keeps below-sea-level ground negative through the round trip', () => {
    // Buffer bytes are unsigned; a seabed that came back positive would paint
    // every ocean as highland.
    const deep = -20 * BAND_HEIGHT;
    const thumb = buildThumbnail(splitWorld(256, deep, deep), 256);
    expect(thumb.readInt8(0)).toBe(bandOf(deep));
    expect(thumb.readInt8(0)).toBeLessThan(0);
  });

  it('refuses a heightmap whose length does not match its world', () => {
    expect(() => buildThumbnail(new Int16Array(10), 512)).toThrow(RangeError);
  });

  it('handles a world smaller than the thumbnail grid', () => {
    const size = CHUNK_SIZE; // 16 cells across, drawn at 64px
    const thumb = buildThumbnail(splitWorld(size, SEA_LEVEL, 4 * BAND_HEIGHT), size);
    expect(thumb).toHaveLength(THUMBNAIL_BYTES);
    expect(thumb.readInt8(0)).toBe(bandOf(SEA_LEVEL));
  });
});

describe('storage and the lazy backfill', () => {
  /** Writes a world file, optionally without a thumbnail (the legacy case). */
  function makeWorld(name: string, withThumbnail: boolean): string {
    const id = registry.uniqueIdFor(name) as string;
    const store = registry.createStore(id, 5);
    const world = World.createFresh(WORLD_SIZE, 50, name);
    store.saveSnapshot({
      worldSize: world.size,
      name: world.name,
      cells: world.map.cells,
      mask: world.mask,
      pluginSlices: {},
      ...(withThumbnail ? { thumbnail: buildThumbnail(world.map.cells, world.size) } : {}),
    });
    store.close();
    return id;
  }

  it('round-trips a stored thumbnail', () => {
    const id = makeWorld('Frostwick Hollows', true);
    const store = registry.openStore(id, 5);
    try {
      expect(store.latestThumbnail()).toHaveLength(THUMBNAIL_BYTES);
    } finally {
      store.close();
    }
  });

  it('lists a legacy world WITHOUT a thumbnail rather than failing', () => {
    // Absent is a placeholder, never an error: the row must still load,
    // rename and archive.
    const id = makeWorld('Moonreach', false);
    const store = registry.openStore(id, 5);
    try {
      expect(store.latestThumbnail()).toBeNull();
    } finally {
      store.close();
    }
    // summaryFor bypasses list()'s backfill, so it sees the undrawn state.
    expect(registry.summaryFor(id, null)?.thumbnail).toBeUndefined();
  });

  it('draws one lazily, once, and serves it from then on', () => {
    const id = makeWorld('Moonreach', false);

    expect(registry.ensureThumbnail(id, null)).toBe(true);
    // Second call is a no-op: the decode is paid once, ever.
    expect(registry.ensureThumbnail(id, null)).toBe(false);

    const summary = registry.summaryFor(id, null);
    expect(summary?.thumbnail).toBeTypeOf('string');
    expect(Buffer.from(summary?.thumbnail as string, 'base64')).toHaveLength(THUMBNAIL_BYTES);
  });

  it('leaves the LOADED world alone, so it is not raced for a staler picture', () => {
    const id = makeWorld('Frostwick Hollows', false);
    expect(registry.ensureThumbnail(id, id)).toBe(false);
    expect(registry.summaryFor(id, id)?.thumbnail).toBeUndefined();
  });

  it('backfills every listed world as a side effect of listing', () => {
    const a = makeWorld('Moonreach', false);
    const b = makeWorld('Galewick Downs', false);

    const listed = registry.list(null);

    expect(listed).toHaveLength(2);
    for (const world of listed) expect(world.thumbnail).toBeTypeOf('string');
    // ...and it persisted, rather than being computed for the listing alone.
    for (const id of [a, b]) {
      const store = registry.openStore(id, 5);
      try {
        expect(store.latestThumbnail()).not.toBeNull();
      } finally {
        store.close();
      }
    }
  });

  it('survives a world file it cannot draw', () => {
    const id = registry.uniqueIdFor('Broken') as string;
    SnapshotStore.open(registry.pathFor(id)).close(); // a file with no snapshot
    expect(registry.ensureThumbnail(id, null)).toBe(false);
    expect(registry.list(null).some((world) => world.id === id)).toBe(true);
  });
});
