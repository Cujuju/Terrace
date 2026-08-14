// The client's local mirror of the authoritative heightmap.
//
// CRITICAL CODE — this is the client half of the sync path (design doc §3.2).
// Everything the client draws is derived from this mirror, so a mis-applied
// message is a permanently wrong world until the next join. Two invariants
// carry the whole module:
//
//   1. The mirror only ever contains data the SERVER sent. Locked chunks are
//      never on the wire (anti-cheat by omission, §3.4), so "which chunks have
//      we received" IS the client's notion of what exists. `received` is that
//      set; the renderer draws exactly those chunks and nothing else.
//   2. Cells of never-received chunks stay at their allocated zero, which is
//      SEA_LEVEL. That is deliberate: it makes the edge of revealed territory
//      slope down into the sea instead of ending in a floating cliff (see
//      vertexGrid.ts, which samples across chunk borders for seam continuity).
//
// This module is deliberately free of Three.js and DOM references so it can be
// unit-tested headless — see test/mirror.test.ts.

import {
  CHUNK_SIZE,
  cellIndex,
  chunkIndex,
  chunksPerEdge,
  createHeightmap,
  writeChunkHeights,
  type ChunkPayload,
  type ChunkUnlockMessage,
  type Heightmap,
  type JoinSnapshotMessage,
  type TerrainDiffMessage,
} from '@terrace/shared';

export interface TerrainMirror {
  readonly map: Heightmap;
  /** Flat chunk indices the server has sent us. Only these are rendered. */
  readonly received: Set<number>;
}

/**
 * Allocates the mirror up front for the world size the server reported in its
 * join snapshot. 512² Int16 is 512 KB — trivial, and it means no reallocation
 * ever happens as territory is revealed (design doc §3.4).
 */
export function createTerrainMirror(worldSize: number): TerrainMirror {
  chunksPerEdge(worldSize); // throws unless worldSize is a positive multiple of CHUNK_SIZE
  return { map: createHeightmap(worldSize), received: new Set<number>() };
}

/**
 * Reads a cell, clamping the coordinates into the world. Clamping (rather than
 * returning a sentinel) is what lets vertexGrid sample one cell past a chunk's
 * last row without special-casing the world border.
 */
export function sampleHeight(mirror: TerrainMirror, x: number, y: number): number {
  const max = mirror.map.size - 1;
  const cx = x < 0 ? 0 : x > max ? max : x;
  const cy = y < 0 ? 0 : y > max ? max : y;
  return mirror.map.cells[cellIndex(mirror.map, cx, cy)];
}

export function hasChunk(mirror: TerrainMirror, chunkIdx: number): boolean {
  return mirror.received.has(chunkIdx);
}

/**
 * Chunks whose RENDERED geometry depends on cell (x,y).
 *
 * A chunk's mesh has CHUNK_SIZE+1 vertices per edge: it samples one cell past
 * its own last row and column so its border vertices coincide with the
 * neighbour's first ones and the two meshes tile without a crack (see
 * vertexGrid.ts). The consequence for diff application is that a cell on a
 * chunk's FIRST row or column is also read by the chunk before it:
 *
 *   cell x is owned by chunk floor(x / CHUNK_SIZE), and is additionally the
 *   border sample of chunk floor(x / CHUNK_SIZE) - 1 exactly when
 *   x % CHUNK_SIZE === 0.
 *
 * The same holds independently on y, so a corner cell dirties four chunks.
 * Missing this is precisely how seam cracks appear after an edit, which is why
 * it is its own tested function rather than inline arithmetic.
 *
 * Returned indices are all in-bounds, but are NOT filtered against `received`
 * — the caller does that, because a chunk we do not have simply has no mesh.
 */
export function chunksDirtiedByCell(
  worldSize: number,
  x: number,
  y: number,
): number[] {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const alsoLeft = x % CHUNK_SIZE === 0 && cx > 0;
  const alsoUp = y % CHUNK_SIZE === 0 && cy > 0;

  const out = [chunkIndex(worldSize, cx, cy)];
  if (alsoLeft) out.push(chunkIndex(worldSize, cx - 1, cy));
  if (alsoUp) out.push(chunkIndex(worldSize, cx, cy - 1));
  if (alsoLeft && alsoUp) out.push(chunkIndex(worldSize, cx - 1, cy - 1));
  return out;
}

/**
 * Writes one chunk payload into the mirror and marks it received.
 * Returns every chunk index whose mesh is now stale — the chunk itself plus,
 * for the same border-sampling reason as above, the neighbours that sample
 * into it (the chunk to its left, above, and up-left).
 */
function applyChunkPayload(mirror: TerrainMirror, chunk: ChunkPayload): number[] {
  const worldSize = mirror.map.size;
  // writeChunkHeights bounds-checks the chunk coords and the payload length,
  // so a malformed server message throws here rather than corrupting the map.
  writeChunkHeights(mirror.map, chunk.cx, chunk.cy, chunk.heights);

  const idx = chunkIndex(worldSize, chunk.cx, chunk.cy);
  mirror.received.add(idx);

  const dirty = [idx];
  if (chunk.cx > 0) dirty.push(chunkIndex(worldSize, chunk.cx - 1, chunk.cy));
  if (chunk.cy > 0) dirty.push(chunkIndex(worldSize, chunk.cx, chunk.cy - 1));
  if (chunk.cx > 0 && chunk.cy > 0) {
    dirty.push(chunkIndex(worldSize, chunk.cx - 1, chunk.cy - 1));
  }
  return dirty;
}

/**
 * Applies the join snapshot: the world's size plus ONLY the chunks unlocked
 * for this client. Returns the set of chunk indices needing a mesh rebuild.
 *
 * The caller creates the mirror from `msg.worldSize` before calling this, so
 * the size is not re-read here.
 */
export function applySnapshot(
  mirror: TerrainMirror,
  msg: JoinSnapshotMessage,
): Set<number> {
  const dirty = new Set<number>();
  for (const chunk of msg.chunks) {
    for (const idx of applyChunkPayload(mirror, chunk)) dirty.add(idx);
  }
  return dirty;
}

/** Applies newly revealed chunks streaming in mid-session. */
export function applyChunkUnlock(
  mirror: TerrainMirror,
  msg: ChunkUnlockMessage,
): Set<number> {
  const dirty = new Set<number>();
  for (const chunk of msg.chunks) {
    for (const idx of applyChunkPayload(mirror, chunk)) dirty.add(idx);
  }
  return dirty;
}

/**
 * Applies an authoritative cell diff — the hot path: this runs for every
 * sculpt anyone in the world performs.
 *
 * Cells outside the map are dropped defensively rather than thrown on: a diff
 * is a broadcast to every client, and one malformed entry must not take down
 * a client's whole render loop. (The server validates intents before applying
 * them, so this is belt-and-suspenders, not an expected path.)
 *
 * Returns the chunk indices to re-patch. Note it returns chunks regardless of
 * whether we hold them; the renderer ignores indices with no mesh.
 */
export function applyTerrainDiff(
  mirror: TerrainMirror,
  msg: TerrainDiffMessage,
): Set<number> {
  const worldSize = mirror.map.size;
  const dirty = new Set<number>();

  for (const cell of msg.cells) {
    if (
      !Number.isInteger(cell.x) ||
      !Number.isInteger(cell.y) ||
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x >= worldSize ||
      cell.y >= worldSize
    ) {
      continue;
    }
    mirror.map.cells[cellIndex(mirror.map, cell.x, cell.y)] = cell.h;
    for (const idx of chunksDirtiedByCell(worldSize, cell.x, cell.y)) {
      dirty.add(idx);
    }
  }
  return dirty;
}
