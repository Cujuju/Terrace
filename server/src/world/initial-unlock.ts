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
 * world. 8 chunks = 128×128 cells — exactly a full Populous map, which is the
 * proven-playable starting area (design §2), and ~128 KB of Int16 on a join
 * snapshot. On a 128² world (8×8 chunks) this unlocks everything, which is the
 * intended behaviour for the small-VPS configuration.
 */
export const INITIAL_UNLOCK_CHUNK_SPAN = 8;

/**
 * Unlocks a centred square of INITIAL_UNLOCK_CHUNK_SPAN² chunks.
 *
 * The square is centred by flooring, so on an odd chunk count the extra chunk
 * sits on the high side — arbitrary but deterministic. Worlds smaller than the
 * span unlock entirely (the clamp below), never partially.
 */
export function applyInitialUnlock(world: World): void {
  const edge = chunksPerEdge(world.size);
  const span = Math.min(INITIAL_UNLOCK_CHUNK_SPAN, edge);
  const start = Math.floor((edge - span) / 2);

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
