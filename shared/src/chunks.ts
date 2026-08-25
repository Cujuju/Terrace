// Chunk geometry, the unlocked-region mask, and chunk height extraction.
//
// CRITICAL CODE — the mask is the anti-cheat boundary (design §3.4): locked
// chunks are NEVER sent to clients, and sculpt intents on locked cells are
// rejected server-side. The mask itself lives only on the server; this module
// is in shared/ because the client needs the same chunk geometry to place
// streamed chunks, and the server needs extraction/writing for snapshots.

import { CHUNK_SIZE, MAX_HEIGHT, MIN_HEIGHT } from './constants.ts';
import { cellIndex, type Heightmap } from './heightmap.ts';
import {
  applyPackedSpans,
  assertSingleSpanChunk,
  resetColumns,
} from './columns.ts';
// Type-only, and so erased: chunks.ts is the lower-level module, and a value
// import back from protocol.ts would put a cycle where there is none today.
import type { ChunkLayeredSpans, ChunkPayload } from './protocol.ts';

/**
 * True for a height that is safe to store: a whole number within
 * [MIN_HEIGHT, MAX_HEIGHT]. This is the Int16 wire/storage contract — the
 * heightmap backing store is an `Int16Array` (design doc §3.3), and a plain
 * `number` assigned into it is silently coerced: non-integers truncate,
 * out-of-Int16-range values wrap (`40000` -> `-25536`), and `NaN` becomes
 * `0`. Every height that reaches an `Int16Array` write MUST pass this check
 * first, or the corruption is silent.
 */
export function isValidHeight(h: number): boolean {
  return Number.isInteger(h) && h >= MIN_HEIGHT && h <= MAX_HEIGHT;
}

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
  // One height per cell is all THIS function can say, so a layered column in
  // this chunk would be silently flattened by whoever called it. Refuse
  // instead, and name the chunk: `extractChunkPayload` below is the span-aware
  // form, and the guard is what keeps a caller from reaching past it by
  // accident. Free in a world nobody has carved (the side table is empty).
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

/** The heights themselves, with no opinion about spans. */
function copyChunkHeights(map: Heightmap, cx: number, cy: number): number[] {
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

/**
 * Every layered column in one chunk, in wire shape — or `undefined` when the
 * chunk has none, which is the overwhelmingly common case and the one that
 * must cost nothing.
 *
 * Walks the chunk in ROW-MAJOR ORDER rather than iterating `map.columnSpans`,
 * so `at` comes out ascending and identical on two replicas that agree on the
 * world. (`Map` iterates in insertion order; two servers that carved the same
 * cells in a different order would emit the same columns in a different
 * sequence. See columns.ts's determinism note.)
 */
export function extractChunkSpans(
  map: Heightmap,
  cx: number,
  cy: number,
): ChunkLayeredSpans | undefined {
  chunkIndex(map.size, cx, cy); // bounds check
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

/**
 * One chunk's terrain in wire shape — heights plus, only if there are any, the
 * chunk's layered columns.
 *
 * THE ONLY WAY TO BUILD A `ChunkPayload`, and that is the point: a payload
 * assembled by hand from `extractChunkHeights` is a payload that flattens a
 * carved chunk, and the whole failure mode is invisible until a player joins
 * and the arch is gone. One function that cannot forget beats a rule every
 * call site has to remember.
 */
export function extractChunkPayload(map: Heightmap, cx: number, cy: number): ChunkPayload {
  chunkIndex(map.size, cx, cy); // bounds check
  const layered = extractChunkSpans(map, cx, cy);
  const heights = copyChunkHeights(map, cx, cy);
  return layered === undefined ? { cx, cy, heights } : { cx, cy, heights, layered };
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
  // Validate every height BEFORE writing any of them. Writing as we go and
  // throwing on the first bad entry would leave the map holding half of a
  // rejected payload — worse than the payload never having arrived, and
  // silent until something reads the wrong half.
  for (let k = 0; k < heights.length; k++) {
    if (!isValidHeight(heights[k])) {
      throw new RangeError(
        `chunk payload cell ${k} has height ${heights[k]}, expected an integer in [${MIN_HEIGHT}, ${MAX_HEIGHT}]`,
      );
    }
  }
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  // The payload defines these columns completely, so whatever spans they held
  // locally are stale the moment it lands.
  resetColumns(map, x0, y0, CHUNK_SIZE, CHUNK_SIZE);
  let k = 0;
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      map.cells[cellIndex(map, x0 + x, y0 + y)] = heights[k++];
    }
  }
}

/**
 * Applies a whole streamed chunk — heights first, then the layered columns
 * that ride alongside them.
 *
 * THE ORDER IS LOAD-BEARING. `writeChunkHeights` calls `resetColumns`, which
 * returns every column in the chunk to the one-span case; the spans are then
 * laid back on top of only the cells the payload actually names. That is
 * exactly "absent means one span" enforced by construction, and it is why
 * applying the two halves in the other order — or applying only the heights of
 * a payload that carried spans — cannot leave a stale split behind.
 *
 * A malformed `layered` entry costs THAT COLUMN and nothing else: the cell
 * keeps the height the payload gave it and stays one span. A chunk payload is
 * a broadcast, and one bad entry must not cost a client the other 4,095 cells
 * or take down its render loop. `writeChunkHeights` still throws on a bad
 * height, because a truncated or out-of-range height array is not one bad
 * entry — it is a payload that does not describe this world at all.
 *
 * Returns the number of layered columns that were REJECTED, so a caller with
 * somewhere to log can say so; 0 on the ordinary path.
 */
export function writeChunkPayload(
  map: Heightmap,
  cx: number,
  cy: number,
  heights: readonly number[],
  layered?: ChunkLayeredSpans,
): number {
  writeChunkHeights(map, cx, cy, heights);
  if (layered === undefined) return 0;

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const cellsPerChunk = CHUNK_SIZE * CHUNK_SIZE;
  let rejected = 0;
  let cursor = 0;
  let previousOffset = -1;

  for (let n = 0; n < layered.at.length; n++) {
    const offset = layered.at[n]!;
    // `runs` is walked with a cursor, so a bad COUNT desynchronises every
    // entry after it — there is no way to resynchronise, and guessing would
    // apply one column's spans to another's cell. Stop reading the side
    // channel entirely and let the rest of the chunk stand as one-span.
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

    // Ascending, in range, and no repeats — `at` is a position in the chunk,
    // and two entries for one cell would mean the payload disagrees with
    // itself about that column.
    if (!Number.isInteger(offset) || offset <= previousOffset || offset >= cellsPerChunk) {
      rejected++;
      continue;
    }
    previousOffset = offset;

    // The topmost ceiling IS the height. `setColumn` would otherwise write the
    // ceiling over `heights[offset]` and the client would render a column at a
    // height the server never sent — a tear between the two halves of one
    // payload, which is precisely what carrying them in one message is for.
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
