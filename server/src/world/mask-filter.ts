// THE ANTI-CHEAT BOUNDARY. Read this before touching anything that sends
// terrain to a client.
//
// Design §3.4: the unlocked-chunk mask is server-side only, and locked terrain
// is protected "by omission" — a hacked client cannot render or peek at terrain
// it never received. Two facts make filtering mandatory rather than optional:
//
//   1. The gradient-limit relaxation in shared/heightmap.ts legitimately spills
//      into neighbouring cells, and that spill does NOT stop at chunk borders.
//      A sculpt on the last unlocked column WILL change heights inside locked
//      chunks server-side. That is correct simulation — but those cells must
//      never appear in an outgoing diff.
//   2. A join snapshot must contain unlocked chunks only, for the same reason.
//
// Every server → client terrain payload is produced by one of the functions in
// this file. If you add a new one, it filters here too — no exceptions, no
// "this path is internal" shortcuts.

import {
  chunkIndexOfCell,
  chunksPerEdge,
  chunkIndex,
  extractChunkHeights,
  isChunkUnlocked,
  type CellDiff,
  type ChunkPayload,
  type Heightmap,
} from '@terrace/shared';

/**
 * The minimum a value must expose to be filtered: the terrain and the mask.
 * Structural (not `World`) so this module has no dependency on the World class
 * and cannot participate in an import cycle.
 */
export interface MaskedTerrain {
  readonly map: Heightmap;
  readonly mask: Uint8Array;
}

/** True when the chunk containing cell (x,y) is unlocked. */
export function isCellUnlocked(terrain: MaskedTerrain, x: number, y: number): boolean {
  return isChunkUnlocked(terrain.mask, chunkIndexOfCell(terrain.map.size, x, y));
}

/**
 * ANTI-CHEAT FILTER — drops every cell whose chunk is locked.
 *
 * Called on the authoritative diff before it goes on the wire. The server keeps
 * the full diff for its own state and for plugins (which are trusted,
 * server-side code); only clients get the filtered view.
 *
 * Returns a new array; the input is never mutated, because the caller still
 * needs the unfiltered diff.
 */
export function filterDiffToUnlocked(
  terrain: MaskedTerrain,
  diff: readonly CellDiff[],
): CellDiff[] {
  const visible: CellDiff[] = [];
  for (const cell of diff) {
    if (isCellUnlocked(terrain, cell.x, cell.y)) visible.push(cell);
  }
  return visible;
}

/** One chunk's heights in wire shape. Callers must check the mask first. */
export function chunkPayloadOf(terrain: MaskedTerrain, cx: number, cy: number): ChunkPayload {
  return { cx, cy, heights: extractChunkHeights(terrain.map, cx, cy) };
}

/**
 * ANTI-CHEAT FILTER — every unlocked chunk, and nothing else. This is the
 * entire terrain content of a join snapshot: an early-game world sends a
 * handful of chunks (tens of KB) rather than the whole 512 KB map, which is
 * both the bandwidth win (design §3.2) and the security property.
 *
 * Iteration is row-major over chunk coordinates so the payload order is
 * deterministic (useful for tests and for client-side progressive upload).
 */
export function collectUnlockedChunkPayloads(terrain: MaskedTerrain): ChunkPayload[] {
  const edge = chunksPerEdge(terrain.map.size);
  const payloads: ChunkPayload[] = [];
  for (let cy = 0; cy < edge; cy++) {
    for (let cx = 0; cx < edge; cx++) {
      if (!isChunkUnlocked(terrain.mask, chunkIndex(terrain.map.size, cx, cy))) continue;
      payloads.push(chunkPayloadOf(terrain, cx, cy));
    }
  }
  return payloads;
}
