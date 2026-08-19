// reveal — the flagship example plugin (design §3.5, MVP criterion 5).
//
// Core knows about per-token unlock (World.unlockChunkForToken, published to
// plugins as WorldApi.unlockChunkForToken — issue #17). Core does NOT know
// *when* territory should unlock for a given player — that policy lives here,
// in a plugin, and nothing in server/src had to change to make this file work
// beyond the WorldApi surface issue #17 added.
//
// ────────────────────────────────────────────────────────────────────────────
// THE POLICY (re-decided 2026-08-19, issue #17): INSTANT PER-PLAYER CREEP.
//
//   Sculpting near the edge of YOUR territory physically reshapes the locked
//   land behind it — the brush footprint and the gradient-limit relaxation
//   that follows it do not stop at a chunk border. The instant that spill
//   lands a changed cell in a chunk YOU personally have not unlocked, that
//   chunk unlocks FOR YOU, immediately. No threshold, no counter: one cell is
//   enough, because a cell only changes at all when your own edit reached it.
//
// SUPERSEDES the original "frontier pressure" policy — a per-chunk counter
// that required CHUNK_SIZE² cumulative cell-changes, against a single
// world-wide mask everyone shared, before a chunk unlocked for everyone at
// once. Two owner-settled facts (issue #17) forced the change:
//
//   1. Per-player masks. Once unlocking happens FOR A TOKEN rather than for
//      the whole world, "pressure accrued against a chunk" has no single
//      owner to accrue toward — the counter's premise (one shared frontier)
//      stopped existing the moment two players could each unlock the SAME
//      chunk independently.
//   2. Instant beats counted, now that there is one sculptor per creep event.
//      The old counter's whole reason to exist was resisting a single
//      griefer hammering one border, over and over, to open a chunk EVERY
//      OTHER PLAYER would then see for free. That griefer now only ever
//      unlocks the chunk for themselves — there is no one left to protect
//      the counter from.
//
// WHY THIS IS STILL NOT FARMABLE, restated for the new mechanics:
//   * It is a property of the terrain, not of the message stream — a sculpt
//     that hits the height clamp produces an empty diff and unlocks nothing.
//   * It needs no post-apply intent hook: a diff exists only because it was
//     already applied, which means it already survived every other plugin's
//     onIntent (mana, cooldowns, …) — a denied intent contributes nothing.
//   * It is directional and legible in-game: the land you are already
//     pushing into is the land that opens for you. Sculpting in the middle
//     of your own territory reveals nothing (there is no locked chunk left
//     to touch there).
//   * It is monotone and deterministic per token: the same edits by the same
//     sculptor in the same order → the same unlocks for that sculptor, on
//     any machine, on a restored world as much as a fresh one.
//
// STATELESS. Every bit this plugin used to own (pressureByChunk, and the
// persistence slice that carried it across a restart) is GONE. The per-token
// unlock masks that replace it are core's own, on World — not because this
// plugin lost a privilege, but because unlockChunkForToken had to be a
// WorldApi primitive other plugins (and the planned fog-of-war follow-up) can
// also reach, and a capability core owns keeps its state in core, in the same
// binary shape the union mask already uses (see snapshot-store.ts's
// TOKEN_MASKS TABLE comment for the persistence-home decision). This file
// only ever decided WHEN unlockChunkForToken should fire; it never actually
// needed to remember anything to do that.
// ────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE, chunkIndex, type CellDiff } from '@terrace/shared';
// Type-only import of the plugin contract. It reaches into server/src because
// core publishes no plugin-API entry point yet (see the report accompanying
// this Phase 2 work); `import type` is fully erased, so nothing here depends on
// server code at runtime.
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';

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

export const plugin: TerracePlugin = {
  name: 'reveal',

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[], sculptorToken?: string): void {
    // No sculptor → a plugin-initiated edit (e.g. weather, structures
    // terraforming their own way), not a player's own sculpt. There is no
    // one to creep territory for, so this policy has nothing to do.
    if (sculptorToken === undefined) return;
    creepForSculptor(world, diff, sculptorToken);
  },
};
