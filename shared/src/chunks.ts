import {
  CHUNK_SIZE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  REVEAL_REACH_BASE_CELLS,
  REVEAL_REACH_PER_BRUSH_CELL,
} from './constants.ts';
import { cellIndex, type Heightmap } from './heightmap.ts';
import {
  applyPackedSpans,
  assertSingleSpanChunk,
  resetColumns,
} from './columns.ts';
import type { ChunkLayeredSpans, ChunkPayload } from './protocol.ts';

export function isValidHeight(h: number): boolean {
  return Number.isInteger(h) && h >= MIN_HEIGHT && h <= MAX_HEIGHT;
}

export function chunksPerEdge(worldSize: number): number {
  if (!Number.isInteger(worldSize) || worldSize <= 0 || worldSize % CHUNK_SIZE !== 0) {
    throw new RangeError(
      `world size ${worldSize} must be a positive multiple of CHUNK_SIZE (${CHUNK_SIZE})`,
    );
  }
  return worldSize / CHUNK_SIZE;
}

export function chunkIndex(worldSize: number, cx: number, cy: number): number {
  const n = chunksPerEdge(worldSize);
  if (cx < 0 || cy < 0 || cx >= n || cy >= n) {
    throw new RangeError(`chunk (${cx},${cy}) out of bounds for ${n}×${n} chunks`);
  }
  return cy * n + cx;
}

export function chunkIndexOfCell(worldSize: number, x: number, y: number): number {
  return chunkIndex(
    worldSize,
    Math.floor(x / CHUNK_SIZE),
    Math.floor(y / CHUNK_SIZE),
  );
}

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

export type ChunkHeights = readonly number[] | Int16Array | Uint8Array;

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const BYTES_PER_HEIGHT = 2;

export function chunkHeightsAsCells(heights: ChunkHeights): ArrayLike<number> {
  if (!(heights instanceof Uint8Array)) return heights;
  const cells = Math.floor(heights.byteLength / BYTES_PER_HEIGHT);
  if (!HOST_IS_LITTLE_ENDIAN || heights.byteOffset % BYTES_PER_HEIGHT !== 0) {
    const bytes = new Uint8Array(cells * BYTES_PER_HEIGHT);
    bytes.set(heights.subarray(0, bytes.length));
    if (!HOST_IS_LITTLE_ENDIAN) {
      for (let i = 0; i + 1 < bytes.length; i += BYTES_PER_HEIGHT) {
        const low = bytes[i]!;
        bytes[i] = bytes[i + 1]!;
        bytes[i + 1] = low;
      }
    }
    return new Int16Array(bytes.buffer, 0, cells);
  }
  return new Int16Array(heights.buffer, heights.byteOffset, cells);
}

function chunkHeightsToWire(cells: Int16Array): Uint8Array {
  const bytes = new Uint8Array(cells.buffer, cells.byteOffset, cells.byteLength);
  if (HOST_IS_LITTLE_ENDIAN) return bytes;
  for (let i = 0; i + 1 < bytes.length; i += BYTES_PER_HEIGHT) {
    const low = bytes[i]!;
    bytes[i] = bytes[i + 1]!;
    bytes[i + 1] = low;
  }
  return bytes;
}

export function extractChunkHeights(map: Heightmap, cx: number, cy: number): Int16Array {
  chunkIndex(map.size, cx, cy);
  assertSingleSpanChunk(
    map,
    cx * CHUNK_SIZE,
    cy * CHUNK_SIZE,
    CHUNK_SIZE,
    CHUNK_SIZE,
    'extractChunkHeights',
  );
  return copyChunkHeights(map, cx, cy);
}

function copyChunkHeights(map: Heightmap, cx: number, cy: number): Int16Array {
  const heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
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

export function extractChunkSpans(
  map: Heightmap,
  cx: number,
  cy: number,
): ChunkLayeredSpans | undefined {
  chunkIndex(map.size, cx, cy);
  if (map.columnSpans.size === 0) return undefined;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const at: number[] = [];
  const runs: number[] = [];
  let k = 0;
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++, k++) {
      const packed = map.columnSpans.get(cellIndex(map, x0 + x, y0 + y));
      if (packed === undefined) continue;
      at.push(k);
      runs.push(packed.length / 2);
      for (let n = 0; n < packed.length; n++) runs.push(packed[n]!);
    }
  }
  return at.length === 0 ? undefined : { at, runs };
}

export function extractChunkPayload(map: Heightmap, cx: number, cy: number): ChunkPayload {
  chunkIndex(map.size, cx, cy);
  const layered = extractChunkSpans(map, cx, cy);
  const heights = chunkHeightsToWire(copyChunkHeights(map, cx, cy));
  return layered === undefined ? { cx, cy, heights } : { cx, cy, heights, layered };
}

export function writeChunkHeights(
  map: Heightmap,
  cx: number,
  cy: number,
  wire: ChunkHeights,
): ArrayLike<number> {
  chunkIndex(map.size, cx, cy);
  const heights = chunkHeightsAsCells(wire);
  if (heights.length !== CHUNK_SIZE * CHUNK_SIZE) {
    throw new RangeError(
      `chunk payload has ${heights.length} cells, expected ${CHUNK_SIZE * CHUNK_SIZE}`,
    );
  }
  for (let k = 0; k < heights.length; k++) {
    if (!isValidHeight(heights[k]!)) {
      throw new RangeError(
        `chunk payload cell ${k} has height ${String(heights[k])}, expected an integer in [${MIN_HEIGHT}, ${MAX_HEIGHT}]`,
      );
    }
  }
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  resetColumns(map, x0, y0, CHUNK_SIZE, CHUNK_SIZE);
  let k = 0;
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      map.cells[cellIndex(map, x0 + x, y0 + y)] = heights[k++]!;
    }
  }
  return heights;
}

export function writeChunkPayload(
  map: Heightmap,
  cx: number,
  cy: number,
  wire: ChunkHeights,
  layered?: ChunkLayeredSpans,
): number {
  const heights = writeChunkHeights(map, cx, cy, wire);
  if (layered === undefined) return 0;

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const cellsPerChunk = CHUNK_SIZE * CHUNK_SIZE;
  let rejected = 0;
  let cursor = 0;
  let previousOffset = -1;

  for (let n = 0; n < layered.at.length; n++) {
    const offset = layered.at[n]!;
    if (cursor >= layered.runs.length) {
      rejected += layered.at.length - n;
      break;
    }
    const count = layered.runs[cursor]!;
    if (!Number.isInteger(count) || count < 2 || cursor + 1 + count * 2 > layered.runs.length) {
      rejected += layered.at.length - n;
      break;
    }
    const flat = layered.runs.slice(cursor + 1, cursor + 1 + count * 2);
    cursor += 1 + count * 2;

    if (!Number.isInteger(offset) || offset <= previousOffset || offset >= cellsPerChunk) {
      rejected++;
      continue;
    }
    previousOffset = offset;

    if (flat[flat.length - 1] !== heights[offset]) {
      rejected++;
      continue;
    }

    const x = x0 + (offset % CHUNK_SIZE);
    const y = y0 + Math.floor(offset / CHUNK_SIZE);
    if (!applyPackedSpans(map, x, y, flat)) rejected++;
  }
  return rejected;
}

export function revealReachCells(radius: number): number {
  return REVEAL_REACH_BASE_CELLS + REVEAL_REACH_PER_BRUSH_CELL * radius;
}

export function revealChunkIndices(
  worldSize: number,
  x: number,
  y: number,
  radius: number,
): number[] {
  const n = chunksPerEdge(worldSize);
  const reach = revealReachCells(radius);
  const reachSquared = reach * reach;
  const first = Math.floor((x - reach) / CHUNK_SIZE);
  const last = Math.floor((x + reach) / CHUNK_SIZE);
  const firstRow = Math.floor((y - reach) / CHUNK_SIZE);
  const lastRow = Math.floor((y + reach) / CHUNK_SIZE);
  const reached: number[] = [];

  for (let cy = Math.max(0, firstRow); cy <= Math.min(n - 1, lastRow); cy++) {
    const y0 = cy * CHUNK_SIZE;
    const y1 = y0 + CHUNK_SIZE - 1;
    const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
    const budget = reachSquared - dy * dy;
    if (budget < 0) continue;
    for (let cx = Math.max(0, first); cx <= Math.min(n - 1, last); cx++) {
      const x0 = cx * CHUNK_SIZE;
      const x1 = x0 + CHUNK_SIZE - 1;
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      if (dx * dx <= budget) reached.push(cy * n + cx);
    }
  }
  return reached;
}
