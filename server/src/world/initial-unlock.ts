// Initial unlock policy for a FRESH world.
//
// PROVISIONAL AND TEMPORARY. Design §3.5 is explicit that "the reveal mechanic
// ships as the flagship example plugin, not core: core knows about the mask, a
// plugin decides *when* territory unlocks." This file is the minimum that makes
// a brand-new world usable before any plugin exists — without it every chunk is
// locked, so nothing is visible and nothing is sculptable, and the server looks
// broken to a self-hoster who has not installed a reveal plugin.
//
// In Phase 2 the reveal plugin owns unlock policy. When it does, this stays only
// as the "no plugins installed" fallback; it must never grow progression rules.

import { chunksPerEdge } from '@terrace/shared';
import type { World } from './world.ts';

/**
 * Edge length, in chunks, of the square unlocked at the centre of a fresh
 * world. Owner decision 2026-08-19: 5 chunks = 80×80 cells, ~39% of the old
 * full-Populous-map start. Deliberately small: the static genesis profile
 * inside it stops mattering once most of the world is earned by sculpting
 * (per-player creep, #17). Five, not four, because it is the smallest span
 * whose genesis geometry stays clean: shelf 1 chunk (span/4, floored),
 * remainder 4 splits symmetrically, and the 16-cell slope ring sits strictly
 * inside with a uniform one-chunk deep frame around it. Span 4 leaves an
 * off-centre shelf and a ring touching the square's edge. Known consequence:
 * the deep frame (4 096 cells) is below a whale's 5 000-cell habitat need, so
 * whales first appear once territory creeps outward, not on day one.
 */
export const INITIAL_UNLOCK_CHUNK_SPAN = 5;

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
 * Exported because world genesis has to place its shallow shelf CONCENTRIC with
 * this square (see World.createFresh), and a second copy of "centred by
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
