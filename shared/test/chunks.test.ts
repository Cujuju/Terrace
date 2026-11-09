import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  BEDROCK_BAND,
  bandLevelHeight,
  DEFAULT_WORLD_SIZE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  extractChunkHeights,
  heightAt,
  isChunkUnlocked,
  isValidHeight,
  unlockChunk,
  writeChunkHeights,
  writeChunkPayload,
  setColumn,
  spanCount,
  type ChunkHeights,
  type ChunkLayeredSpans,
} from '../src/index.ts';

describe('chunk geometry', () => {
  it('a chunk is 16 cells, and the default world is 128×128 of them', () => {
    expect(CHUNK_SIZE).toBe(16);
    expect(chunksPerEdge(DEFAULT_WORLD_SIZE)).toBe(128);
    expect(chunksPerEdge(CHUNK_SIZE * 8)).toBe(8);
  });

  it('rejects world sizes that are not chunk multiples', () => {
    expect(() => chunksPerEdge(CHUNK_SIZE + 1)).toThrow(RangeError);
    expect(() => chunksPerEdge(0)).toThrow(RangeError);
  });

  it('maps cells to chunks', () => {
    const size = CHUNK_SIZE * 8;
    expect(chunkIndexOfCell(size, 0, 0)).toBe(0);
    expect(chunkIndexOfCell(size, CHUNK_SIZE - 1, CHUNK_SIZE - 1)).toBe(0);
    expect(chunkIndexOfCell(size, CHUNK_SIZE, 0)).toBe(1);
    expect(chunkIndexOfCell(size, 0, CHUNK_SIZE)).toBe(8);
    expect(chunkIndexOfCell(size, size - 1, size - 1)).toBe(63);
  });

  it('bounds-checks chunk coordinates', () => {
    expect(() => chunkIndex(CHUNK_SIZE * 8, 8, 0)).toThrow(RangeError);
    expect(() => chunkIndex(CHUNK_SIZE * 8, -1, 0)).toThrow(RangeError);
  });
});

describe('chunk envelope admission', () => {
  const ceiling = bandLevelHeight(12);
  const heights = (): Int16Array => new Int16Array(CHUNK_SIZE * CHUNK_SIZE).fill(ceiling);
  const existing = () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    map.cells.fill(bandLevelHeight(2));
    setColumn(map, 4, 4, [
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(2) },
      { floorBand: 5, ceiling: bandLevelHeight(6) },
    ]);
    return map;
  };

  it.each([
    null, [], {}, { at: null, runs: [] }, { at: [], runs: null },
    { at: {}, runs: [] }, { at: [], runs: { length: 0 } },
  ])('rejects malformed layered envelopes atomically: %j', (layered) => {
    const map = existing();
    const cells = map.cells.slice();
    const spans = new Map(map.columnSpans);
    expect(() => writeChunkPayload(map, 0, 0, heights(), layered as unknown as ChunkLayeredSpans)).toThrow(RangeError);
    expect(map.cells).toEqual(cells);
    expect(map.columnSpans).toEqual(spans);
  });

  it.each([0.5, NaN, Infinity, -1])('rejects malformed chunk coordinates atomically: %s', (cx) => {
    const map = existing();
    const cells = map.cells.slice();
    const spans = new Map(map.columnSpans);
    expect(() => writeChunkPayload(map, cx, 0, heights())).toThrow(RangeError);
    expect(map.cells).toEqual(cells);
    expect(map.columnSpans).toEqual(spans);
  });

  it('validates the complete height envelope before replacing columns', () => {
    const invalid: unknown[] = [null, {}, new Float64Array(CHUNK_SIZE * CHUNK_SIZE),
      new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * Int16Array.BYTES_PER_ELEMENT + 1),
      [...heights().slice(0, -1), MAX_HEIGHT + 1]];
    for (const wire of invalid) {
      const map = existing();
      const cells = map.cells.slice();
      const spans = new Map(map.columnSpans);
      expect(() => writeChunkPayload(map, 0, 0, wire as ChunkHeights)).toThrow(RangeError);
      expect(map.cells).toEqual(cells);
      expect(map.columnSpans).toEqual(spans);
    }
  });

  it('retains height fallback and rejection counts for malformed individual columns', () => {
    const map = existing();
    const layered = { at: [0, 1], runs: [
      2, BEDROCK_BAND, bandLevelHeight(2), 5, ceiling,
      2, BEDROCK_BAND, bandLevelHeight(2), 1, ceiling,
    ] };
    expect(writeChunkPayload(map, 0, 0, heights(), layered)).toBe(1);
    expect(spanCount(map, 0, 0)).toBe(2);
    expect(spanCount(map, 1, 0)).toBe(1);
    expect(map.cells[0]).toBe(ceiling);
    expect(map.cells[1]).toBe(ceiling);
  });
});

describe('unlock mask', () => {
  it('starts fully locked; unlock flips exactly one chunk', () => {
    const mask = createChunkMask(CHUNK_SIZE * 8);
    const total = 8 * 8;
    for (let i = 0; i < total; i++) expect(isChunkUnlocked(mask, i)).toBe(false);
    unlockChunk(mask, 37);
    for (let i = 0; i < total; i++) {
      expect(isChunkUnlocked(mask, i)).toBe(i === 37);
    }
  });

  it('unlock is idempotent', () => {
    const mask = createChunkMask(CHUNK_SIZE * 8);
    unlockChunk(mask, 5);
    unlockChunk(mask, 5);
    expect(isChunkUnlocked(mask, 5)).toBe(true);
  });
});

describe('chunk height streaming', () => {
  it('extract → write round-trips exactly', () => {
    const src = createHeightmap(CHUNK_SIZE * 4);
    for (let i = 0; i < src.cells.length; i++) src.cells[i] = (i * 7) % 500 - 250;

    const dst = createHeightmap(CHUNK_SIZE * 4);
    for (let cy = 0; cy < 4; cy++) {
      for (let cx = 0; cx < 4; cx++) {
        writeChunkHeights(dst, cx, cy, extractChunkHeights(src, cx, cy));
      }
    }
    expect(dst.cells).toEqual(src.cells);
  });

  it('extracts row-major within the chunk', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    map.cells[(CHUNK_SIZE + 1) * CHUNK_SIZE * 2 + CHUNK_SIZE + 2] = 99;
    const heights = extractChunkHeights(map, 1, 1);
    expect(heights[1 * CHUNK_SIZE + 2]).toBe(99);
  });

  it('rejects wrong-length payloads', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    expect(() => writeChunkHeights(map, 0, 0, [1, 2, 3])).toThrow(RangeError);
  });

  it('write places heights at the right world position', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[0] = 42;
    writeChunkHeights(map, 1, 0, heights);
    expect(heightAt(map, CHUNK_SIZE, 0)).toBe(42);
  });

  it('rejects a non-integer height, naming the offending index and value', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[5] = 1.5;
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(/cell 5.*1\.5/);
  });

  it('rejects a NaN height, naming the offending index', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[9] = NaN;
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(/cell 9/);
  });

  it('rejects a height outside [MIN_HEIGHT, MAX_HEIGHT], naming the offending index', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[3] = MAX_HEIGHT + 1;
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(/cell 3/);
  });

  it('rejects heights that overflow past Int16 magnitude, naming the offending index', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    const tooHigh = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    tooHigh[0] = 40000;
    expect(() => writeChunkHeights(map, 0, 0, tooHigh)).toThrow(/cell 0.*40000/);

    const tooLow = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    tooLow[1] = -50000;
    expect(() => writeChunkHeights(map, 0, 0, tooLow)).toThrow(/cell 1.*-50000/);
  });

  it('leaves the map untouched when a payload is rejected', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    map.cells[0] = 77;
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(200);
    heights[10] = NaN;
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(RangeError);
    expect(map.cells[0]).toBe(77);
  });

  it('still writes a fully valid payload', () => {
    const map = createHeightmap(CHUNK_SIZE * 2);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(MAX_HEIGHT);
    writeChunkHeights(map, 0, 0, heights);
    expect(heightAt(map, 0, 0)).toBe(MAX_HEIGHT);
    expect(heightAt(map, CHUNK_SIZE - 1, CHUNK_SIZE - 1)).toBe(MAX_HEIGHT);
  });
});

describe('isValidHeight', () => {
  it('accepts integers within [MIN_HEIGHT, MAX_HEIGHT], including the boundaries', () => {
    expect(isValidHeight(MIN_HEIGHT)).toBe(true);
    expect(isValidHeight(MAX_HEIGHT)).toBe(true);
    expect(isValidHeight(0)).toBe(true);
  });

  it('rejects out-of-range, non-integer, NaN, and overflow-magnitude values', () => {
    expect(isValidHeight(MIN_HEIGHT - 1)).toBe(false);
    expect(isValidHeight(MAX_HEIGHT + 1)).toBe(false);
    expect(isValidHeight(1.5)).toBe(false);
    expect(isValidHeight(NaN)).toBe(false);
    expect(isValidHeight(40000)).toBe(false);
    expect(isValidHeight(-50000)).toBe(false);
  });
});
