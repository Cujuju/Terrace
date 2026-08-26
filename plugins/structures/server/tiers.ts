// TIER PROGRESSION — pure maths, so the tests can assert it without a world.
//
// A live cell's tier is no longer a pure function of its age (that was the
// pre-Game-of-Life design; see git history). It needs age, plus a NEIGHBOUR
// condition whose scope the keep-clear rule (2026-08-26, life.ts) narrowed:
//
//   * TIER 0 → TIER 1 (teepee becomes a building): BOTH surviving
//     generations AND live neighbours are required, as before.
//   * TIER ≥ 1: age alone advances a standing building. The density gate no
//     longer applies, because it CANNOT — a building has no neighbours by
//     construction (founding it cleared its own square; nothing may be
//     placed back inside). Leaving the gate on would strand every standing
//     building at tier 1 forever and silently remove four of the six tiers
//     from the game. "Dense cores become towns" still holds where it was
//     meant to: reaching tier 1 in the first place is what required density.
//
// A cell that is old enough but under-neighboured does NOT downgrade — it
// simply stops advancing until a later generation where both hold at once.
// That is why tier is its own piece of persisted state rather than something
// re-derived from age alone: age and tier can and do diverge.

import { MAX_STRUCTURE_TIER } from '../protocol.ts';

/**
 * Generations of continuous survival a cell needs to EARN each tier step.
 *
 * 3: with MAX_STRUCTURE_TIER = 5, a cell that keeps qualifying every single
 * generation reaches the top tier after 15 generations. At
 * CA_GENERATION_INTERVAL_SECONDS = 15 s (life.ts) that is ~3.75 simulated
 * minutes — long enough to read as a settling process, short enough that a
 * demo session actually sees a watchtower stand up.
 */
export const CA_GENERATIONS_PER_TIER = 3;

/**
 * Minimum live Moore neighbours (of 8) a surviving cell must have THIS
 * generation to be allowed to advance a tier.
 *
 * 3 — NOT 2, and this is load-bearing rather than an arbitrary middle value.
 * It was originally derived from hard-walled B3/S23, where a cell that is
 * alive after a step survived the S rule and therefore had EXACTLY 2 or 3 live
 * neighbours: 2 would have passed every survivor and 4 could never fire, so 3
 * was the only threshold that separated them at all. The board topology has
 * since widened that window (below), so the derivation is history rather than
 * proof — but the value it produced is still the right one, for the reason
 * given below.
 *
 * WHAT THE COUNT IS, EXACTLY (corrected 2026-08-25). `neighborCount` is the
 * number of REAL live cells among the eight plain-grid Moore neighbours —
 * life.ts's liveMooreNeighbors. It is NOT the board topology's scaled count,
 * and it is not that count divided by WALL_PHANTOM_DENOMINATOR either. That
 * division was wrong and shipped briefly: three phantom walls come to the same
 * one whole unit a single live neighbour does, so a lone coastal teepee
 * propped up by cliff face read as company it did not have, and a shack on a
 * headland promoted itself on the strength of the sea.
 *
 * SO THE WINDOW ARGUMENT NO LONGER HOLDS, AND IS NOT CLAIMED. Under hard walls
 * every survivor had exactly 2 or 3 live neighbours, because those are the
 * only counts S23 keeps. Under the topology a cell survives on scaled units in
 * [2D, 4D), and phantom walls can make up any part of that — so a SURVIVING
 * teepee's real count can be anything from 0 (all its support was coastline)
 * to 3. The threshold is therefore no longer "the only value that splits the
 * survivors"; it is a floor on REAL density, and cells kept alive by their own
 * shoreline sit below it. That is the same design the constant was chosen for
 * — isolated frontier shacks stay shacks, dense mutually-supporting cores
 * become towns — reached by asking the question directly instead of inferring
 * it from a survival window that the topology has since widened. A block's
 * four cells each keep exactly 3 real neighbours forever and advance every
 * eligible generation; a blinker's centre cell has exactly 2, always, and
 * never does.
 *
 * 4 OR MORE STILL CANNOT FIRE for a teepee: 4 real live neighbours is 4D
 * scaled with no phantom help, which is overpopulation, so such a cell is
 * already dead. 3 remains the top of the usable range.
 *
 * NOT SCALED WITH TIER, for the same reason: every step beyond this one would
 * ask for a real live-neighbour count no living cell can ever present, which
 * would only look like a design decision while actually being an unreachable
 * tier. If
 * that ever needs revisiting, it is a rule about the CA's neighbourhood
 * (Moore vs. a larger radius) before it is a rule about this constant.
 *
 * SCOPE NARROWED 2026-08-26 (keep-clear rule, see maybeAdvanceTier): this
 * gate now applies ONLY to the teepee→building step (tier 0 → 1). THIS IS THE
 * CURRENT CONTRACT, stated plainly rather than argued around: a standing
 * building's entire Moore ring lies inside its own keep-clear square, which
 * founding it emptied and nothing may re-enter, so its real live count is 0
 * and stays 0. If the gate applied to tier >= 1, no building could ever
 * advance except a blessed one — every town would stand at tier 1 forever and
 * four of the six tiers would be unreachable. So the gate discriminates among
 * TEEPEES and nothing else. "Dense cores become towns" is decided entirely at
 * the 0 -> 1 step; past it, tier is a function of age alone.
 */
export const STRUCTURE_UPGRADE_MIN_NEIGHBORS = 3;

/**
 * The generation-age threshold a cell must reach to be ELIGIBLE for
 * `tier + 1`. Pure restatement of CA_GENERATIONS_PER_TIER as a schedule, kept
 * as its own function so the eligibility rule has exactly one definition.
 */
function ageThresholdFor(nextTier: number): number {
  return nextTier * CA_GENERATIONS_PER_TIER;
}

/**
 * Advances a cell by AT MOST ONE tier for this generation. Called once per
 * surviving cell, per completed generation (life.ts), with `neighborCount`
 * the number of REAL live cells among the cell's eight plain-grid Moore
 * neighbours (life.ts's liveMooreNeighbors) — its own small pass, NOT the
 * topology-scaled count the B3/S23 rule is applied to. See
 * STRUCTURE_UPGRADE_MIN_NEIGHBORS above for why the two cannot be the same
 * number.
 *
 * THE DENSITY GATE APPLIES ONLY TO THE 0→1 STEP (forced by life.ts's
 * keep-clear rules): once `tier >= 1` the STRUCTURE_UPGRADE_MIN_NEIGHBORS
 * test is skipped entirely. A standing building has no neighbours BY
 * CONSTRUCTION — founding it demolished its keep-clear square, and nothing
 * may be born or placed back inside — so requiring density of it would make
 * tiers 2–5 unreachable and quietly delete four of the six tiers. Age alone
 * advances what already stands; the density requirement did its work at the
 * moment of founding, deciding which teepee clusters earn their first
 * building at all.
 *
 * `blessed` (pilgrim routes, owner decision 2026-08-19) waives ONLY the
 * neighbour gate — the age schedule stands, and only for the step it ever
 * gated (0→1). The neighbour rule exists to split dense cores from sparse
 * frontier cells (see its comment above), and a pilgrim route is precisely a
 * reason for a sparse frontier cell to prosper anyway: the road brings what
 * the neighbourhood lacks. Waiving age too would make blessing an instant
 * promotion, which is a different (and rejected) mechanic — prosperity is
 * still earned in survived generations.
 */
export function maybeAdvanceTier(
  age: number,
  tier: number,
  neighborCount: number,
  blessed = false,
): number {
  if (tier >= MAX_STRUCTURE_TIER) return tier;
  if (age < ageThresholdFor(tier + 1)) return tier;
  if (tier >= 1) return tier + 1;
  if (!blessed && neighborCount < STRUCTURE_UPGRADE_MIN_NEIGHBORS) return tier;
  return tier + 1;
}
