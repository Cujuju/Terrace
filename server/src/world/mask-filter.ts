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
  extractChunkPayload,
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

/**
 * What a per-viewer filter needs: who is connected, and which cells each of
 * them may see. Structural, like MaskedTerrain, for the same no-cycle reason.
 * World satisfies it directly (players / isCellVisibleTo, both from issue #17).
 */
export interface ViewedTerrain {
  players(): readonly { readonly id: string }[];
  isCellVisibleTo(playerId: string, x: number, y: number): boolean;
}

/** One connected player's share of a diff — only the cells their own mask holds. */
export interface ViewerDiff {
  readonly playerId: string;
  readonly cells: CellDiff[];
}

/**
 * THE PER-PLAYER OUTGOING FILTER (issue #280). Splits one authoritative diff
 * into what each connected player may see, judged against THAT player's own
 * token mask — never the union. Players who may see none of it are omitted,
 * so a caller sending each entry sends nothing to them at all (an empty
 * message would still confirm that something happened somewhere).
 *
 * Why not the union (filterDiffToUnlocked above): the union is the SIMULATION
 * mask — a chunk any one player has earned. Streaming a diff filtered by it
 * to everyone hands a modified client the heights of chunks it was never
 * sent, which is exactly the "protected by omission" guarantee this file
 * exists to keep. The join snapshot and chunkUnlock have been per-token since
 * issue #17 and entity broadcasts since #18; this closes the last stream.
 *
 * Nothing is lost by the narrowing: when a chunk is later unlocked for a
 * token, unlockChunkForToken sends that token's sessions the chunk's CURRENT
 * heights, so cells withheld here arrive then.
 *
 * Per cell rather than per chunk on purpose: a diff is at most a few hundred
 * cells and a mask read is an index into a byte array, so this is a rounding
 * error beside the sculpt that produced the diff — and one loop with no
 * grouping step is the version whose correctness is visible at a glance.
 * Iteration order is the players() snapshot order, then diff order, so the
 * per-player payload is deterministic for a given world state.
 */
export function partitionDiffByViewer(
  terrain: ViewedTerrain,
  diff: readonly CellDiff[],
): ViewerDiff[] {
  const shares: ViewerDiff[] = [];
  for (const player of terrain.players()) {
    const cells: CellDiff[] = [];
    for (const cell of diff) {
      if (terrain.isCellVisibleTo(player.id, cell.x, cell.y)) cells.push(cell);
    }
    if (cells.length > 0) shares.push({ playerId: player.id, cells });
  }
  return shares;
}

/**
 * One chunk's terrain in wire shape — heights plus any layered columns.
 * Callers must check the mask first.
 */
export function chunkPayloadOf(terrain: MaskedTerrain, cx: number, cy: number): ChunkPayload {
  return extractChunkPayload(terrain.map, cx, cy);
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
