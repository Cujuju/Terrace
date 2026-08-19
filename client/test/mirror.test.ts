import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_SIZE,
  chunkIndex,
  heightAt,
  type ChunkPayload,
} from '@terrace/shared';
import {
  applyChunkUnlock,
  applySnapshot,
  applyTerrainDiff,
  chunksDirtiedByCell,
  createTerrainMirror,
  hasChunk,
  sampleHeight,
} from '../src/terrain/mirror.ts';

/** 64 cells = 4×4 chunks: small enough to reason about, big enough for corners. */
const WORLD = 64;
const CHUNKS_PER_EDGE = WORLD / CHUNK_SIZE;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

describe('createTerrainMirror', () => {
  it('allocates a flat world with nothing received', () => {
    const mirror = createTerrainMirror(WORLD);
    expect(mirror.map.size).toBe(WORLD);
    expect(mirror.received.size).toBe(0);
    expect(heightAt(mirror.map, 0, 0)).toBe(0);
  });

  it('rejects a world size that is not a whole number of chunks', () => {
    expect(() => createTerrainMirror(WORLD + 1)).toThrow(RangeError);
  });
});

describe('sampleHeight', () => {
  it('clamps out-of-bounds reads to the edge cell', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 300)],
    });
    // (0,0) is inside chunk (0,0); the clamped reads must land on it too.
    expect(sampleHeight(mirror, 0, 0)).toBe(300);
    expect(sampleHeight(mirror, -5, -5)).toBe(300);
    // Past the far edge clamps onto the last cell, which is unreceived → 0.
    expect(sampleHeight(mirror, WORLD + 10, WORLD + 10)).toBe(0);
  });
});

describe('applySnapshot', () => {
  it('writes only the chunks the server sent and marks them received', () => {
    const mirror = createTerrainMirror(WORLD);
    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 1, 128)],
    });

    const idx = chunkIndex(WORLD, 1, 1);
    expect(hasChunk(mirror, idx)).toBe(true);
    expect(dirty.has(idx)).toBe(true);

    // Every cell of the sent chunk carries the payload value...
    expect(heightAt(mirror.map, CHUNK_SIZE, CHUNK_SIZE)).toBe(128);
    expect(heightAt(mirror.map, CHUNK_SIZE * 2 - 1, CHUNK_SIZE * 2 - 1)).toBe(128);
    // ...and nothing outside it was touched: locked chunks stay at sea level.
    expect(heightAt(mirror.map, 0, 0)).toBe(0);
    expect(hasChunk(mirror, chunkIndex(WORLD, 0, 0))).toBe(false);
  });

  it('dirties the neighbours that sample across the new chunk border', () => {
    const mirror = createTerrainMirror(WORLD);
    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(2, 2, 64)],
    });

    // The chunk itself plus left, up, and up-left — those meshes each have a
    // border row/column sampling into chunk (2,2).
    expect([...dirty].sort((a, b) => a - b)).toEqual(
      [
        chunkIndex(WORLD, 2, 2),
        chunkIndex(WORLD, 1, 2),
        chunkIndex(WORLD, 2, 1),
        chunkIndex(WORLD, 1, 1),
      ].sort((a, b) => a - b),
    );
  });

  it('does not dirty non-existent neighbours at the world origin', () => {
    const mirror = createTerrainMirror(WORLD);
    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 64)],
    });
    expect([...dirty]).toEqual([chunkIndex(WORLD, 0, 0)]);
  });

  it('drops a chunk payload of the wrong length instead of throwing', () => {
    // writeChunkHeights still throws a RangeError on a wrong-length payload —
    // applyChunkPayload's boundary catch is what turns that into a drop, same
    // policy as an invalid-height payload (see "malformed chunk payloads"
    // below).
    const mirror = createTerrainMirror(WORLD);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      applySnapshot(mirror, {
        type: 'snapshot',
        worldSize: WORLD,
        chunks: [{ cx: 0, cy: 0, heights: [1, 2, 3] }],
      }),
    ).not.toThrow();
    expect(hasChunk(mirror, chunkIndex(WORLD, 0, 0))).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe('malformed chunk payloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a chunk with an invalid height instead of throwing out of the handler', () => {
    const mirror = createTerrainMirror(WORLD);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const badChunk: ChunkPayload = {
      cx: 0,
      cy: 0,
      heights: new Array<number>(CELLS_PER_CHUNK).fill(0),
    };
    badChunk.heights[3] = 1.5; // non-integer: invalid height

    let dirty: Set<number> | undefined;
    expect(() => {
      dirty = applySnapshot(mirror, {
        type: 'snapshot',
        worldSize: WORLD,
        chunks: [badChunk],
      });
    }).not.toThrow();

    // The malformed chunk is dropped, not applied: it is never marked
    // received, and it contributes nothing to the dirty set.
    expect(hasChunk(mirror, chunkIndex(WORLD, 0, 0))).toBe(false);
    expect(dirty?.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('applies the other chunks in the same message when one is malformed', () => {
    const mirror = createTerrainMirror(WORLD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const badChunk: ChunkPayload = {
      cx: 0,
      cy: 0,
      heights: new Array<number>(CELLS_PER_CHUNK).fill(0),
    };
    badChunk.heights[0] = NaN;
    const goodChunk = chunkPayload(1, 1, 50);

    const dirty = applyChunkUnlock(mirror, {
      type: 'chunkUnlock',
      chunks: [badChunk, goodChunk],
    });

    expect(hasChunk(mirror, chunkIndex(WORLD, 0, 0))).toBe(false);
    expect(hasChunk(mirror, chunkIndex(WORLD, 1, 1))).toBe(true);
    expect(heightAt(mirror.map, CHUNK_SIZE, CHUNK_SIZE)).toBe(50);
    expect(dirty.has(chunkIndex(WORLD, 1, 1))).toBe(true);
  });
});

describe('applyChunkUnlock', () => {
  it('streams a chunk in mid-session', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 10)],
    });

    const dirty = applyChunkUnlock(mirror, {
      type: 'chunkUnlock',
      chunks: [chunkPayload(1, 0, 200)],
    });

    expect(hasChunk(mirror, chunkIndex(WORLD, 1, 0))).toBe(true);
    expect(heightAt(mirror.map, CHUNK_SIZE, 0)).toBe(200);
    // The already-drawn chunk to its left must be re-patched or the seam
    // between them would still show the old (sea level) border heights.
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
  });
});

describe('chunksDirtiedByCell', () => {
  it('dirties one chunk for an interior cell', () => {
    expect(chunksDirtiedByCell(WORLD, 5, 5)).toEqual([chunkIndex(WORLD, 0, 0)]);
    expect(chunksDirtiedByCell(WORLD, CHUNK_SIZE + 5, CHUNK_SIZE + 5)).toEqual([
      chunkIndex(WORLD, 1, 1),
    ]);
  });

  it('dirties the left neighbour for a cell on a chunk first column', () => {
    const dirty = chunksDirtiedByCell(WORLD, CHUNK_SIZE, 5);
    expect(dirty.sort((a, b) => a - b)).toEqual(
      [chunkIndex(WORLD, 1, 0), chunkIndex(WORLD, 0, 0)].sort((a, b) => a - b),
    );
  });

  it('dirties the upper neighbour for a cell on a chunk first row', () => {
    const dirty = chunksDirtiedByCell(WORLD, 5, CHUNK_SIZE);
    expect(dirty.sort((a, b) => a - b)).toEqual(
      [chunkIndex(WORLD, 0, 1), chunkIndex(WORLD, 0, 0)].sort((a, b) => a - b),
    );
  });

  it('dirties all four chunks meeting at a corner cell', () => {
    const dirty = chunksDirtiedByCell(WORLD, CHUNK_SIZE, CHUNK_SIZE);
    expect(dirty.sort((a, b) => a - b)).toEqual(
      [
        chunkIndex(WORLD, 1, 1),
        chunkIndex(WORLD, 0, 1),
        chunkIndex(WORLD, 1, 0),
        chunkIndex(WORLD, 0, 0),
      ].sort((a, b) => a - b),
    );
  });

  it('never names a chunk outside the world', () => {
    for (const [x, y] of [
      [0, 0],
      [0, WORLD - 1],
      [WORLD - 1, 0],
      [WORLD - 1, WORLD - 1],
    ]) {
      for (const idx of chunksDirtiedByCell(WORLD, x, y)) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(CHUNKS_PER_EDGE * CHUNKS_PER_EDGE);
      }
    }
  });
});

describe('applyTerrainDiff', () => {
  it('writes cells and reports the chunk meshes to re-patch', () => {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 0)],
    });

    const dirty = applyTerrainDiff(mirror, {
      type: 'terrainDiff',
      cells: [
        { x: 3, y: 4, h: 128 },
        { x: 5, y: 6, h: -64 },
      ],
    });

    expect(heightAt(mirror.map, 3, 4)).toBe(128);
    expect(heightAt(mirror.map, 5, 6)).toBe(-64);
    expect([...dirty]).toEqual([chunkIndex(WORLD, 0, 0)]);
  });

  it('reports every chunk a border cell affects, so no seam is left stale', () => {
    const mirror = createTerrainMirror(WORLD);
    const dirty = applyTerrainDiff(mirror, {
      type: 'terrainDiff',
      cells: [{ x: CHUNK_SIZE, y: CHUNK_SIZE, h: 256 }],
    });
    expect(dirty.size).toBe(4);
  });

  it('drops out-of-bounds and malformed cells instead of throwing', () => {
    const mirror = createTerrainMirror(WORLD);
    const dirty = applyTerrainDiff(mirror, {
      type: 'terrainDiff',
      cells: [
        { x: -1, y: 0, h: 100 },
        { x: WORLD, y: 0, h: 100 },
        { x: 0, y: WORLD, h: 100 },
        { x: 1.5, y: 0, h: 100 },
        { x: 2, y: 2, h: 42 },
      ],
    });
    expect(heightAt(mirror.map, 2, 2)).toBe(42);
    expect(dirty.size).toBe(1);
  });

  it('drops a cell with an invalid height while still applying the good cells in the same diff', () => {
    const mirror = createTerrainMirror(WORLD);
    const dirty = applyTerrainDiff(mirror, {
      type: 'terrainDiff',
      cells: [
        { x: 1, y: 1, h: 1.5 }, // invalid: not an integer
        { x: 2, y: 2, h: 42 }, // valid
      ],
    });
    expect(heightAt(mirror.map, 1, 1)).toBe(0); // untouched, still sea level
    expect(heightAt(mirror.map, 2, 2)).toBe(42);
    expect(dirty.size).toBe(1);
  });

  it('applies diffs to chunks we do not hold without marking them received', () => {
    // The server should never send these, but a diff must not be able to
    // fabricate territory the client was never granted.
    const mirror = createTerrainMirror(WORLD);
    applyTerrainDiff(mirror, {
      type: 'terrainDiff',
      cells: [{ x: 40, y: 40, h: 500 }],
    });
    expect(mirror.received.size).toBe(0);
  });
});
