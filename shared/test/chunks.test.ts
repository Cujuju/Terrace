import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  extractChunkHeights,
  heightAt,
  isChunkUnlocked,
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
});
