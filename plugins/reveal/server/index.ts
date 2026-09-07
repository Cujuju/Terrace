// reveal — the flagship example plugin (design doc).
//
// Core knows about per-token unlock (World.unlockChunkForToken, published to
// plugins as WorldApi.unlockChunkForToken — issue #17). Core does NOT know
// *when* territory should unlock for a given player — that policy lives here,
// in a plugin, and nothing in server/src had to change to make this file work
// beyond the WorldApi surface issue #17 added.
//
// ────────────────────────────────────────────────────────────────────────────
// THE POLICY (re-decided 2026-09-06, owner): THE STROKE OPENS WHAT IT COVERS.
//
//   Every chunk a player's brush FOOTPRINT covers unlocks for that player,
//   whether or not the ground inside it moved. The reach is the disc the HUD
//   already draws — r−1 cells past the clicked cell — so what you can see
//   before you click is what you open by clicking.
//
// SUPERSEDES "INSTANT CREEP ON SPILLOVER" (issue #17, 2026-08-19), which
// unlocked a chunk when a CHANGED cell landed in it. That rule was legible on
// paper and unpredictable in the hand, because a cell only changes when the
// terrain math lets it:
//
//   1. Every player stroke is anchored to the clicked cell, and the brushes
//      skip any cell already at or past that target (heightmap.ts's
//      `if (anchored && (raising ? before >= target : before <= target))`).
//      So raising into ground already a band higher wrote nothing and opened
//      nothing — and so did lowering into ground already a band lower. The
//      player could not see which case they were in, because the deciding
//      ground was the ground still under fog.
//   2. The relaxation that used to carry a stroke past its own footprint is
//      band-contained for player strokes (issue #26): where not one unit fits
//      inside the outside cell's own band, `movePair` refuses the pair and
//      nothing changes there either.
//
//   The owner's report was "half the time when I'm clicking, it is not
//   unlocking unless I'm on a specific side of the cell". Both mechanisms
//   above say the same thing: the OLD trigger was the terrain's response to a
//   stroke, and the new one is the stroke.
//
// WHAT IS UNCHANGED, and is why this is a smaller change than it reads:
//   * Aim is still gated by core — the brush CENTRE must be on unlocked
//     ground (server/src/intent/pipeline.ts), so the reach past the frontier
//     is still bounded by the brush and by where the player may point it.
//   * The spillover rule is still here, in onTerrainChanged, unchanged: a
//     relaxation cascade that carries a changed cell BEYOND the footprint
//     still opens the chunk it lands in. Footprint and spill are a union, so
//     this change only ever opens more, never less.
//   * Plugin-initiated edits still open nothing (no sculptor, no intent).
//   * It is still per-token, still monotone, still deterministic: the same
//     stroke by the same sculptor opens the same chunks on any machine.
//
// STILL NOT FARMABLE. A stroke opens at most the chunks its own disc reaches,
// and the widest brush the picker offers reaches seven cells of a sixteen-cell
// chunk — the same ceiling the spillover rule had on its best day. What it no
// longer does is make the player guess which day that is. The mana plugin
// prices the difference (plugins/mana): opening a chunk with a small brush
// costs what opening it with the full brush would have, so the cheap brush is
// not the cheap way to expand.
//
// STATELESS, exactly as before: the per-token masks are core's own.
// ────────────────────────────────────────────────────────────────────────────

import {
  CHUNK_SIZE,
  chunkIndex,
  chunksPerEdge,
  footprintChunkIndices,
  type CellDiff,
  type SculptIntent,
} from '@terrace/shared';
// Type-only import of the plugin contract. It reaches into server/src because
// core publishes no plugin-API entry point yet (see the report accompanying
// this Phase 2 work); `import type` is fully erased, so nothing here depends on
// server code at runtime.
import type { IntentCtx, TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';

/**
 * Unlocks every locked chunk one sculptor's diff touched, FOR THAT SCULPTOR.
 *
 * Deduping by chunk index within one diff avoids calling
 * `unlockChunkForToken` more than once for the same chunk in a single
 * sculpt — a cheap saving, not a correctness requirement, since that call is
 * already idempotent per token on its own (World.unlockChunkForToken).
 */
function creepForSculptor(
  world: WorldApi,
  diff: readonly CellDiff[],
  sculptorToken: string,
): void {
  const worldSize = world.worldSize;
  const touchedChunks = new Set<number>();

  for (const cell of diff) {
    const cx = Math.floor(cell.x / CHUNK_SIZE);
    const cy = Math.floor(cell.y / CHUNK_SIZE);
    // Diff cells always come from the authoritative heightmap, so they are in
    // bounds and chunkIndex cannot throw here.
    const index = chunkIndex(worldSize, cx, cy);
    if (touchedChunks.has(index)) continue;
    touchedChunks.add(index);

    world.unlockChunkForToken(sculptorToken, cx, cy);
  }
}

/**
 * Unlocks every chunk this stroke's footprint covers, for its sculptor.
 *
 * The covered set comes from `footprintChunkIndices` — the brushes' own disc
 * iterator — so it cannot drift from the edit, and the mana plugin prices
 * exactly the same set (see that function's doc comment).
 *
 * `unlockChunkForToken` is idempotent per token and returns false for a chunk
 * the player already had, so the common case (a stroke wholly inside your own
 * territory) is a handful of bit tests and sends nothing.
 */
function openFootprint(world: WorldApi, intent: SculptIntent, token: string): void {
  const cols = chunksPerEdge(world.worldSize);
  for (const index of footprintChunkIndices(
    world.worldSize,
    intent.x,
    intent.y,
    intent.radius,
  )) {
    world.unlockChunkForToken(token, index % cols, Math.floor(index / cols));
  }
}

export const plugin: TerracePlugin = {
  name: 'reveal',

  /**
   * THE STROKE'S OWN REACH (2026-09-06). Fires only for a player intent that
   * every interceptor allowed and core actually applied, which is the whole
   * precondition this policy needs: the player aimed somewhere they were
   * allowed to aim, and the edit happened.
   *
   * `intent` is the EFFECTIVE intent, so a plugin that widened the brush
   * (relics' Titan's Hand) opens the chunks the WIDER disc covered — the same
   * disc core just sculpted with, and the same one mana was billed for.
   */
  onIntentApplied(intent: SculptIntent, ctx: IntentCtx): void {
    openFootprint(ctx.world, intent, ctx.player.token);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[], sculptorToken?: string): void {
    // No sculptor → a plugin-initiated edit (e.g. weather, structures
    // terraforming their own way), not a player's own sculpt. There is no
    // one to creep territory for, so this policy has nothing to do.
    if (sculptorToken === undefined) return;
    creepForSculptor(world, diff, sculptorToken);
  },
};
