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
  sampleRenderHeight,
} from '../src/terrain/mirror.ts';

const WORLD = CHUNK_SIZE * 4;
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
    expect(sampleHeight(mirror, 0, 0)).toBe(300);
    expect(sampleHeight(mirror, -5, -5)).toBe(300);
    expect(sampleHeight(mirror, WORLD + 10, WORLD + 10)).toBe(0);
  });
});

describe('sampleRenderHeight', () => {
  function chunkPayloadFrom(
    cx: number,
    cy: number,
    height: (x: number, y: number) => number,
  ): ChunkPayload {
    const heights: number[] = [];
    for (let j = 0; j < CHUNK_SIZE; j++) {
      for (let i = 0; i < CHUNK_SIZE; i++) {
        heights.push(height(cx * CHUNK_SIZE + i, cy * CHUNK_SIZE + j));
      }
    }
    return { cx, cy, heights };
  }

  const coordHeight = (x: number, y: number): number => x * 10 + y;

  function mirrorWithCoordChunks(chunks: Array<[number, number]>) {
    const mirror = createTerrainMirror(WORLD);
    applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: chunks.map(([cx, cy]) => chunkPayloadFrom(cx, cy, coordHeight)),
    });
    return mirror;
  }

  it('returns received cells untouched, exactly like sampleHeight', () => {
    const mirror = mirrorWithCoordChunks([[0, 0]]);
    expect(sampleRenderHeight(mirror, 5, 5)).toBe(sampleHeight(mirror, 5, 5));
    expect(sampleRenderHeight(mirror, 15, 15)).toBe(coordHeight(15, 15));
  });

  it('pulls a column-seam sample in an unreceived chunk back one cell west', () => {
    const mirror = mirrorWithCoordChunks([[0, 0]]);
    expect(sampleHeight(mirror, CHUNK_SIZE, 5)).toBe(0);
    expect(sampleRenderHeight(mirror, CHUNK_SIZE, 5)).toBe(coordHeight(CHUNK_SIZE - 1, 5));
  });

  it('pulls a row-seam sample back one cell north', () => {
    const mirror = mirrorWithCoordChunks([[0, 0]]);
    expect(sampleRenderHeight(mirror, 5, CHUNK_SIZE)).toBe(coordHeight(5, CHUNK_SIZE - 1));
  });

  it('resolves a chunk-corner sample in one fixed order every reader agrees on', () => {
    const corner = CHUNK_SIZE;
    expect(
      sampleRenderHeight(mirrorWithCoordChunks([[0, 0]]), corner, corner),
    ).toBe(coordHeight(CHUNK_SIZE - 1, CHUNK_SIZE - 1));
    expect(
      sampleRenderHeight(mirrorWithCoordChunks([[0, 0], [1, 0]]), corner, corner),
    ).toBe(coordHeight(corner, CHUNK_SIZE - 1));
    expect(
      sampleRenderHeight(mirrorWithCoordChunks([[0, 0], [0, 1]]), corner, corner),
    ).toBe(coordHeight(CHUNK_SIZE - 1, corner));
    expect(
      sampleRenderHeight(mirrorWithCoordChunks([[1, 1]]), corner, corner),
    ).toBe(coordHeight(corner, corner));
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

    expect(heightAt(mirror.map, CHUNK_SIZE, CHUNK_SIZE)).toBe(128);
    expect(heightAt(mirror.map, CHUNK_SIZE * 2 - 1, CHUNK_SIZE * 2 - 1)).toBe(128);
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

    const badHeights = new Array<number>(CELLS_PER_CHUNK).fill(0);
    badHeights[3] = 1.5;
    const badChunk: ChunkPayload = { cx: 0, cy: 0, heights: badHeights };

    let dirty: Set<number> | undefined;
    expect(() => {
      dirty = applySnapshot(mirror, {
        type: 'snapshot',
        worldSize: WORLD,
        chunks: [badChunk],
      });
    }).not.toThrow();

    expect(hasChunk(mirror, chunkIndex(WORLD, 0, 0))).toBe(false);
    expect(dirty?.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('applies the other chunks in the same message when one is malformed', () => {
    const mirror = createTerrainMirror(WORLD);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const badHeights = new Array<number>(CELLS_PER_CHUNK).fill(0);
    badHeights[0] = NaN;
    const badChunk: ChunkPayload = { cx: 0, cy: 0, heights: badHeights };
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
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
  });
});

describe('chunksDirtiedByCell', () => {
  const wholeWorld = (): ReturnType<typeof createTerrainMirror> => {
    const mirror = createTerrainMirror(WORLD);
    for (let cy = 0; cy < CHUNKS_PER_EDGE; cy++) {
      for (let cx = 0; cx < CHUNKS_PER_EDGE; cx++) mirror.received.add(chunkIndex(WORLD, cx, cy));
    }
    return mirror;
  };

  it('dirties one chunk for an interior cell', () => {
    expect(chunksDirtiedByCell(wholeWorld(), 5, 5)).toEqual([chunkIndex(WORLD, 0, 0)]);
    expect(chunksDirtiedByCell(wholeWorld(), CHUNK_SIZE + 5, CHUNK_SIZE + 5)).toEqual([
      chunkIndex(WORLD, 1, 1),
    ]);
  });

  it('dirties the left neighbour for a cell on a chunk first column', () => {
    const dirty = chunksDirtiedByCell(wholeWorld(), CHUNK_SIZE, 5);
    expect(dirty.sort((a, b) => a - b)).toEqual(
      [chunkIndex(WORLD, 1, 0), chunkIndex(WORLD, 0, 0)].sort((a, b) => a - b),
    );
  });

  it('dirties the upper neighbour for a cell on a chunk first row', () => {
    const dirty = chunksDirtiedByCell(wholeWorld(), 5, CHUNK_SIZE);
    expect(dirty.sort((a, b) => a - b)).toEqual(
      [chunkIndex(WORLD, 0, 1), chunkIndex(WORLD, 0, 0)].sort((a, b) => a - b),
    );
  });

  it('dirties all four chunks meeting at a corner cell', () => {
    const dirty = chunksDirtiedByCell(wholeWorld(), CHUNK_SIZE, CHUNK_SIZE);
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
      for (const idx of chunksDirtiedByCell(wholeWorld(), x, y)) {
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
        { x: 1, y: 1, h: 1.5 },
        { x: 2, y: 2, h: 42 },
      ],
    });
    expect(heightAt(mirror.map, 1, 1)).toBe(0);
    expect(heightAt(mirror.map, 2, 2)).toBe(42);
    expect(dirty.size).toBe(1);
  });

  it('applies diffs to chunks we do not hold without marking them received', () => {
    const mirror = createTerrainMirror(WORLD);
    applyTerrainDiff(mirror, {
      type: 'terrainDiff',
      cells: [{ x: 40, y: 40, h: 500 }],
    });
    expect(mirror.received.size).toBe(0);
  });
});
