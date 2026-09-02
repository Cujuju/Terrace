// Initial unlock policy for a FRESH world.
//
// PROVISIONAL AND TEMPORARY. Design doc is explicit that "the reveal mechanic
// ships as the flagship example plugin, not core: core knows about the mask, a
// plugin decides *when* territory unlocks." This file is the minimum that makes
// a brand-new world usable before any plugin exists — without it every chunk is
// locked, so nothing is visible and nothing is sculptable, and the server looks
// broken to a self-hoster who has not installed a reveal plugin.
//
// In Phase 2 the reveal plugin owns unlock policy. When it does, this stays only
// as the "no plugins installed" fallback; it must never grow progression rules.

import { CHUNK_SIZE, NEIGHBOURHOOD_CELLS, chunksPerEdge } from '@terrace/shared';
import type { World } from './world.ts';

/**
 * Edge length, in chunks, of the square unlocked at the centre of a fresh
 * world. Owner decision 2026-08-19: 80×80 WORLD UNITS, ~39% of the old
 * full-Populous-map start. Deliberately small: what genesis puts inside it
 * stops mattering once most of the world is earned by sculpting (per-player
 * creep, #17). Eighty, not sixty-four, because five neighbourhoods was the
 * smallest span the fixed shelf/slope profile of the day divided cleanly.
 *
 * THE SPAN OUTLIVED THAT PROFILE (2026-08-25) and is now load-bearing for a
 * different reason: its AREA is the entire habitat budget of day one, and the
 * guarantees genesis makes inside it — two islands, the fish schools' shallow
 * water, the whale pair's deep water — only just fit in 102 400 cells. See
 * GENESIS_MIN_STARTER_ISLANDS in genesis.ts for that arithmetic before
 * changing this number in either direction.
 *
 * COUNTED IN CHUNKS AND DERIVED SINCE 2026-08-21, because the unlock square is
 * a size on the GROUND and a chunk stopped being one: the re-sample took a
 * chunk from 16 world units to 4 (see shared's CHUNK_SPAN), so five chunks
 * would have started a player on a twentieth of the land the owner chose.
 */
export const INITIAL_UNLOCK_CHUNK_SPAN =
  (5 * NEIGHBOURHOOD_CELLS) / CHUNK_SIZE;

/** The centred square of chunks a fresh world starts with unlocked. */
export interface InitialUnlockFootprint {
  /** Chunk coordinate of the first unlocked chunk, on both axes. */
  readonly startChunk: number;
  /** Edge length of the square, in chunks. */
  readonly spanChunks: number;
}

/**
 * The starter region's geometry, as one function.
 *
 * Exported because world genesis makes every one of its day-one guarantees
 * INSIDE this square (see genesis.ts), and a second copy of "centred by
 * flooring, clamped to the world" is exactly the kind of duplicated contract
 * that agrees today and drifts tomorrow. The unlock loop below reads it too, so
 * there is one definition and no derived restatement of it anywhere.
 *
 * The square is centred by flooring, so on an odd chunk count the extra chunk
 * sits on the high side — arbitrary but deterministic. Worlds smaller than the
 * span unlock entirely (the clamp), never partially.
 */
export function initialUnlockFootprint(size: number): InitialUnlockFootprint {
  const edge = chunksPerEdge(size);
  const spanChunks = Math.min(INITIAL_UNLOCK_CHUNK_SPAN, edge);
  return { startChunk: Math.floor((edge - spanChunks) / 2), spanChunks };
}

/** Unlocks the centred square of INITIAL_UNLOCK_CHUNK_SPAN² chunks. */
export function applyInitialUnlock(world: World): void {
  const edge = chunksPerEdge(world.size);
  const { startChunk: start, spanChunks: span } = initialUnlockFootprint(world.size);

  for (let cy = start; cy < start + span; cy++) {
    for (let cx = start; cx < start + span; cx++) {
      world.unlockChunk(cx, cy);
    }
  }

  // Sanity: the centre cell of the world must be sculptable on a fresh boot.
  // If this ever fails, the world shipped unusable — fail loudly at boot rather
  // than leaving players with an inert map.
  const centreChunk = Math.floor(edge / 2);
  if (!world.isChunkUnlocked(Math.min(centreChunk, edge - 1), Math.min(centreChunk, edge - 1))) {
    throw new Error(
      `initial unlock left the world centre locked (chunk edge=${edge}, span=${span}) — unlock geometry bug`,
    );
  }
}

/**
 * Grants the SAME centred starter square to one TOKEN's own unlock mask
 * (issue #17 — per-player territory). Every player starts in the same home
 * square, so the join path calls this for every joining token BEFORE the join
 * snapshot is built (see terrace-room.ts's onJoin): a new token's snapshot
 * then simply already contains these chunks, rather than needing a follow-up
 * chunkUnlock message the client is not yet sized to receive.
 *
 * SILENT by construction — World.seedChunkForToken never sends anything — and
 * idempotent per token, so calling this on every join (not just the first) is
 * correct and cheap: a returning token's bits are already set, and the loop
 * below is CHUNK_SPAN² no-op checks.
 *
 * Unlike applyInitialUnlock above, this never touches the union mask's own
 * "did genesis succeed" sanity check — that check is genesis's job and runs
 * exactly once, at world creation; a per-token seed at join time has nothing
 * new to verify (the union mask already proved the square is unlockable).
 */
export function applyInitialUnlockForToken(world: World, token: string): void {
  const { startChunk: start, spanChunks: span } = initialUnlockFootprint(world.size);

  for (let cy = start; cy < start + span; cy++) {
    for (let cx = start; cx < start + span; cx++) {
      world.seedChunkForToken(token, cx, cy);
    }
  }
}
