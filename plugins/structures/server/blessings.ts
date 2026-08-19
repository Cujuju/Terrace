// ROUTE BLESSINGS — the structures-side half of the pilgrim-routes contract
// (owner decision 2026-08-19; the pilgrims plugin is the caller).
//
// A blessed cell's ONLY privilege is at the tier gate: maybeAdvanceTier
// (tiers.ts) waives the STRUCTURE_UPGRADE_MIN_NEIGHBORS requirement for it.
// The CA itself is untouched — B3/S23 births and deaths never consult this
// set, so a blessing cannot keep a dying settlement alive or found one; it
// lets the sparse, under-neighboured survivors that a pilgrim route passes
// through EARN tiers they could otherwise never reach (see tiers.ts's own
// comment on why 3 neighbours is the only meaningful unblessed threshold).
//
// REPLACE SEMANTICS, TOTAL STATE — the same contract shape relics' perk
// bridge settled on (mana-bridge.ts): the caller re-asserts the COMPLETE
// blessed set whenever its routes change, and an empty call clears every
// blessing. No per-key add/remove, no durations, no clock: the caller is the
// one entity that knows which routes are active, so any bookkeeping here
// would be a second copy of its state, drifting.
//
// DELIBERATELY NOT PERSISTED. Blessings are a live-route effect: after a
// restart the pilgrims plugin re-derives its routes from monster and
// settlement state within seconds and re-asserts the set. Persisting it would
// only preserve a stale copy across exactly the window in which it is being
// recomputed anyway.

import { STRUCTURES_CAP } from '../protocol.ts';

let blessedKeys: ReadonlySet<number> = new Set();

/**
 * Replaces the blessed-cell set. Keys are packed cell keys (structureKey).
 *
 * Defensive on the caller's behalf (it is a duck-typed cross-plugin bridge,
 * so a version-skewed caller is an ordinary event, not a programming error):
 * non-integer entries are dropped, and the set is capped at STRUCTURES_CAP —
 * there can never be more standing structures than that, so any excess is
 * noise by construction.
 */
export function setBlessedStructureCells(keys: readonly number[]): void {
  const next = new Set<number>();
  for (const key of keys) {
    if (!Number.isInteger(key) || key < 0) continue;
    if (next.size >= STRUCTURES_CAP) break;
    next.add(key);
  }
  blessedKeys = next;
}

/** Whether the cell with this packed key is currently on an active route. */
export function isBlessedStructureCell(key: number): boolean {
  return blessedKeys.has(key);
}

/** How many cells are currently blessed — diagnostics and tests. */
export function blessedStructureCellCount(): number {
  return blessedKeys.size;
}

/** Test seam: drops every blessing, matching resetStructuresState's shape. */
export function resetBlessings(): void {
  blessedKeys = new Set();
}
