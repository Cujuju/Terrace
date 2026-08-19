import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
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
} from '../src/index.ts';

describe('chunk geometry', () => {
  it('512² world is 32×32 chunks of 16', () => {
    expect(CHUNK_SIZE).toBe(16);
    expect(chunksPerEdge(512)).toBe(32);
    expect(chunksPerEdge(128)).toBe(8);
  });

  it('rejects world sizes that are not chunk multiples', () => {
    expect(() => chunksPerEdge(100)).toThrow(RangeError);
    expect(() => chunksPerEdge(0)).toThrow(RangeError);
  });

  it('maps cells to chunks', () => {
    expect(chunkIndexOfCell(128, 0, 0)).toBe(0);
    expect(chunkIndexOfCell(128, 15, 15)).toBe(0);
    expect(chunkIndexOfCell(128, 16, 0)).toBe(1);
    expect(chunkIndexOfCell(128, 0, 16)).toBe(8); // second chunk row
    expect(chunkIndexOfCell(128, 127, 127)).toBe(63);
  });

  it('bounds-checks chunk coordinates', () => {
    expect(() => chunkIndex(128, 8, 0)).toThrow(RangeError);
    expect(() => chunkIndex(128, -1, 0)).toThrow(RangeError);
  });
});

describe('unlock mask', () => {
  it('starts fully locked; unlock flips exactly one chunk', () => {
    const mask = createChunkMask(128);
    const total = 8 * 8;
    for (let i = 0; i < total; i++) expect(isChunkUnlocked(mask, i)).toBe(false);
    unlockChunk(mask, 37);
    for (let i = 0; i < total; i++) {
      expect(isChunkUnlocked(mask, i)).toBe(i === 37);
    }
  });

  it('unlock is idempotent', () => {
    const mask = createChunkMask(128);
    unlockChunk(mask, 5);
    unlockChunk(mask, 5);
    expect(isChunkUnlocked(mask, 5)).toBe(true);
  });
});

describe('chunk height streaming', () => {
  it('extract → write round-trips exactly', () => {
    const src = createHeightmap(64);
    // Distinct deterministic pattern.
    for (let i = 0; i < src.cells.length; i++) src.cells[i] = (i * 7) % 500 - 250;

    const dst = createHeightmap(64);
    for (let cy = 0; cy < 4; cy++) {
      for (let cx = 0; cx < 4; cx++) {
        writeChunkHeights(dst, cx, cy, extractChunkHeights(src, cx, cy));
      }
    }
    expect(dst.cells).toEqual(src.cells);
  });

  it('extracts row-major within the chunk', () => {
    const map = createHeightmap(32);
    map.cells[17 * 32 + 18] = 99; // cell (18,17) → chunk (1,1), local (2,1)
    const heights = extractChunkHeights(map, 1, 1);
    expect(heights[1 * CHUNK_SIZE + 2]).toBe(99);
  });

  it('rejects wrong-length payloads', () => {
    const map = createHeightmap(32);
    expect(() => writeChunkHeights(map, 0, 0, [1, 2, 3])).toThrow(RangeError);
  });

  it('write places heights at the right world position', () => {
    const map = createHeightmap(32);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[0] = 42; // local (0,0) of chunk (1,0) → world (16,0)
    writeChunkHeights(map, 1, 0, heights);
    expect(heightAt(map, 16, 0)).toBe(42);
  });

  it('rejects a non-integer height, naming the offending index and value', () => {
    const map = createHeightmap(32);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[5] = 1.5;
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(/cell 5.*1\.5/);
  });

  it('rejects a NaN height, naming the offending index', () => {
    const map = createHeightmap(32);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[9] = NaN;
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(/cell 9/);
  });

  it('rejects a height outside [MIN_HEIGHT, MAX_HEIGHT], naming the offending index', () => {
    const map = createHeightmap(32);
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    heights[3] = MAX_HEIGHT + 1;
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(/cell 3/);
  });

  it('rejects heights that overflow past Int16 magnitude, naming the offending index', () => {
    const map = createHeightmap(32);
    const tooHigh = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    tooHigh[0] = 40000; // would wrap to -25536 in a raw Int16Array assignment
    expect(() => writeChunkHeights(map, 0, 0, tooHigh)).toThrow(/cell 0.*40000/);

    const tooLow = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
    tooLow[1] = -50000;
    expect(() => writeChunkHeights(map, 0, 0, tooLow)).toThrow(/cell 1.*-50000/);
  });

  it('leaves the map untouched when a payload is rejected', () => {
    const map = createHeightmap(32);
    map.cells[0] = 77; // pre-existing value at chunk (0,0) local (0,0)
    const heights = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(200);
    heights[10] = NaN; // invalid entry comes after several valid-looking ones
    expect(() => writeChunkHeights(map, 0, 0, heights)).toThrow(RangeError);
    // Not overwritten by any of the valid entries preceding index 10:
    // validation runs to completion before the write loop starts.
    expect(map.cells[0]).toBe(77);
  });

  it('still writes a fully valid payload', () => {
    const map = createHeightmap(32);
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
