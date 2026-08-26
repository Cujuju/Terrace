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
 * Under B3/S23, any cell that is alive after a step survived the S rule,
 * which only keeps a cell alive with EXACTLY 2 or 3 live neighbours — those
 * are the only two values a living cell's own neighbour count can ever take.
 *
 * STILL TRUE UNDER THE BOARD TOPOLOGY (2026-08-25, life.ts's phantom wall
 * neighbours and per-landmass wrap). `neighborCount` is now an EFFECTIVE
 * count — whole live-neighbour equivalents, floor(scaled / WALL_PHANTOM_
 * DENOMINATOR), where a wall contributes a fraction of one and a wrapped-in
 * cell contributes its real live/dead state. The argument below is unchanged
 * because the WINDOW is unchanged: survival is scaled [2D, 4D), so every
 * survivor's effective count is in [2, 4), i.e. exactly 2 or 3, exactly as
 * before. A phantom fraction can move a cell ACROSS the survival threshold —
 * that is the whole point of it — but it can never hand a survivor an
 * effective count of 1 or 4.
 * A threshold of 2 would therefore pass almost every survivor (no
 * differentiation at all), and anything above 3 could never fire (no
 * surviving cell can have 4+ neighbours — it would have died of
 * overpopulation instead). 3 is the ONLY threshold that splits survivors into
 * two meaningfully different groups: dense, mutually-supporting still-life
 * cores (a block's four cells each keep exactly 3 neighbours forever) advance
 * every eligible generation, while sparser oscillator members (a blinker's
 * centre cell has exactly 2, always — see the test suite) never do. That is
 * the "isolated frontier shacks stay shacks; dense stable cores become towns"
 * shape the owner asked for, and it falls out of the CA's own arithmetic
 * rather than a second, independently-tuned number.
 *
 * NOT SCALED WITH TIER, for the same reason: every step beyond this one would
 * ask for a neighbour count no living cell can ever present, which would only
 * look like a design decision while actually being an unreachable tier. If
 * that ever needs revisiting, it is a rule about the CA's neighbourhood
 * (Moore vs. a larger radius) before it is a rule about this constant.
 *
 * SCOPE NARROWED 2026-08-26 (keep-clear rule, see maybeAdvanceTier): this
 * gate now applies ONLY to the teepee→building step (tier 0 → 1). A standing
 * building has no neighbours by construction, so gating later tiers on it
 * would strand every town at tier 1 forever.
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
 * the Moore-neighbour count that generation's step already computed for the
 * B3/S23 rule — free reuse, not a second pass.
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
