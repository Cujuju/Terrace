// RESERVED GROUND — cells another plugin has claimed, on which the CA may not
// build (owner-reported, 2026-08-24: a house grew inside the temple's own
// footprint).
//
// WHY IT IS A SET HERE RATHER THAN A QUESTION ASKED OUTWARD. The CA's wall
// test runs over every buildable cell of the board every generation, so the
// answer has to be a lookup, not a call into another plugin's predicate; and
// the claimant — one building, placed by hand, moved rarely — knows exactly
// when its claim changes. So the claimant PUSHES, the way pilgrims pushes
// blessings (blessings.ts, whose contract this file copies deliberately):
// replace semantics, total state, an empty call clears everything, no
// per-key bookkeeping and no clock.
//
// WHAT A RESERVATION MEANS: the cell is not buildable ground, exactly as if
// it were water or a terrace edge (suitability.ts's isBuildableCell). That is
// the whole mechanism, and putting it THERE rather than in the CA's birth
// rule is what makes it true for every path at once — the generation sweep,
// the Monday seeder, the stir, a settler's founding, and the boot-time prune
// of a restored board. "Buildable" has to mean one thing.
//
// A HOUSE ALREADY STANDING ON RESERVED GROUND DIES AT THE NEXT GENERATION,
// within CA_GENERATION_INTERVAL_SECONDS — the same bounded, self-correcting
// lag life.ts already names for a cell whose neighbour was sculpted, and for
// the same reason: every generation recomputes buildability for the whole
// board from scratch, so nothing extra has to remember to clean up.
//
// DELIBERATELY NOT PERSISTED, like blessings: the claimant re-asserts its
// claim from its own persisted state when the world is created.

import { structureKey } from '../protocol.ts';

let reservedKeys: ReadonlySet<number> = new Set();

/**
 * How many cells one claim may reserve.
 *
 * A temple surveys a 13×13 square of ground and is the only claimant there
 * is, so 4096 is roughly twenty-four times what the shipping game asks for —
 * a bound against a version-skewed or malformed caller, not a budget anyone
 * is meant to spend. Reservations cost one Set entry each and are read at
 * most once per buildable cell per generation.
 */
export const RESERVED_CELLS_CAP = 4096;

/**
 * Replaces the reserved-cell set. `cells` is a FLAT x, y, x, y… list — the
 * same packing every wire message in this repo uses for a list of cells, and
 * chosen here for a reason particular to a bridge: blessings takes packed
 * keys, which obliges its caller to know this plugin's key stride, and that
 * obligation is a copy of an internal fact travelling across a plugin
 * boundary. A claimant should say WHICH GROUND it wants, in coordinates, and
 * let this plugin pack it the one way this plugin packs things.
 *
 * Defensive on the caller's behalf, blessings.ts's reasoning verbatim: this
 * is a duck-typed cross-plugin bridge, so a version-skewed caller is an
 * ordinary event rather than a programming error — a trailing half pair,
 * non-integers and negatives are dropped, and the total is capped.
 */
export function setReservedStructureCells(cells: readonly number[]): void {
  const next = new Set<number>();
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const x = cells[i];
    const y = cells[i + 1];
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) continue;
    if (next.size >= RESERVED_CELLS_CAP) break;
    next.add(structureKey(x, y));
  }
  reservedKeys = next;
}

/**
 * Is anything reserved at all? The hot-path guard: with no claim standing —
 * every world that has no temple in it — isBuildableCell skips the lookup
 * entirely rather than hashing a key per cell per generation.
 */
export function hasReservedStructureCells(): boolean {
  return reservedKeys.size > 0;
}

/** Whether the cell with this packed key has been claimed by another plugin. */
export function isReservedStructureCell(key: number): boolean {
  return reservedKeys.has(key);
}

/** Test seam: drops every reservation, matching resetStructuresState's shape. */
export function resetReservations(): void {
  reservedKeys = new Set();
}
