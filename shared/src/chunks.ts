// Chunk geometry, the unlocked-region mask, and chunk height extraction.
//
// CRITICAL CODE — the mask is the anti-cheat boundary (design §3.4): locked
// chunks are NEVER sent to clients, and sculpt intents on locked cells are
// rejected server-side. The mask itself lives only on the server; this module
// is in shared/ because the client needs the same chunk geometry to place
// streamed chunks, and the server needs extraction/writing for snapshots.

import { CHUNK_SIZE } from './constants.ts';
import { cellIndex, type Heightmap } from './heightmap.ts';

/** Chunks per world edge. World size must divide evenly into chunks. */
export function chunksPerEdge(worldSize: number): number {
  if (!Number.isInteger(worldSize) || worldSize <= 0 || worldSize % CHUNK_SIZE !== 0) {
    throw new RangeError(
      `world size ${worldSize} must be a positive multiple of CHUNK_SIZE (${CHUNK_SIZE})`,
    );
  }
  return worldSize / CHUNK_SIZE;
}

/** Flat chunk index from chunk coordinates (row-major, like cells). */
export function chunkIndex(worldSize: number, cx: number, cy: number): number {
  const n = chunksPerEdge(worldSize);
  if (cx < 0 || cy < 0 || cx >= n || cy >= n) {
    throw new RangeError(`chunk (${cx},${cy}) out of bounds for ${n}×${n} chunks`);
  }
  return cy * n + cx;
}

/** Which chunk a cell belongs to. */
export function chunkIndexOfCell(worldSize: number, x: number, y: number): number {
  return chunkIndex(
    worldSize,
    Math.floor(x / CHUNK_SIZE),
    Math.floor(y / CHUNK_SIZE),
  );
}

/**
 * Fresh mask with every chunk locked. One bit per chunk. SERVER-SIDE ONLY —
 * never serialize this to a client; clients infer unlocked-ness from which
 * chunks they have received (anti-cheat by omission).
 */
export function createChunkMask(worldSize: number): Uint8Array {
  const n = chunksPerEdge(worldSize);
  return new Uint8Array(Math.ceil((n * n) / 8));
}

export function isChunkUnlocked(mask: Uint8Array, chunkIdx: number): boolean {
  return (mask[chunkIdx >> 3] & (1 << (chunkIdx & 7))) !== 0;
}

export function unlockChunk(mask: Uint8Array, chunkIdx: number): void {
  mask[chunkIdx >> 3] |= 1 << (chunkIdx & 7);
}

/**
 * Copies one chunk's heights out of the world, row-major within the chunk
 * (CHUNK_SIZE² entries). Plain number[] is the v1 wire shape — open question
 * 7 (schema vs binary encoding) defers leaner encodings until measured.
 */
export function extractChunkHeights(map: Heightmap, cx: number, cy: number): number[] {
  chunkIndex(map.size, cx, cy); // bounds check
  const heights: number[] = new Array(CHUNK_SIZE * CHUNK_SIZE);
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  let k = 0;
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      heights[k++] = map.cells[cellIndex(map, x0 + x, y0 + y)];
    }
  }
  return heights;
}

/** Writes a streamed chunk into a local map (client join / chunk unlock). */
export function writeChunkHeights(
  map: Heightmap,
  cx: number,
  cy: number,
  heights: readonly number[],
): void {
  chunkIndex(map.size, cx, cy); // bounds check
  if (heights.length !== CHUNK_SIZE * CHUNK_SIZE) {
    throw new RangeError(
      `chunk payload has ${heights.length} cells, expected ${CHUNK_SIZE * CHUNK_SIZE}`,
    );
  }
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  let k = 0;
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      map.cells[cellIndex(map, x0 + x, y0 + y)] = heights[k++];
    }
  }
}
