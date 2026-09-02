// Movement: ambient wander, habitat-aware steering, and the reactive flee.
//
// The steering contract, in one sentence: a creature only ever commits to a step
// whose DESTINATION LOOK-AHEAD is inside its own habitat, inside unlocked
// territory, reachable along a slope its species can climb, and clear of every
// other creature — so locked chunks, the wrong terrain, a terrace riser too
// steep to walk and another animal's body are all impassable walls rather than
// places it can be pushed out of afterwards.
//
// THE SWEEP ITSELF IS SHARED'S (2026-08-21). This file was the FOURTH copy of
// the same steer-and-veto loop, and the last one still outstanding after
// pilgrims, boats and monsters moved (shared/src/steering.ts's header names all
// four). Its own copy was the one the other three cited as the original — and
// it was the copy that never gained separation, which is why a school of fish
// could swim through itself. `steerToValidHeading` below is now a thin adapter
// over `steerAvoiding`: what stays local is what is genuinely wildlife's — the
// species → archetype resolution, the unlocked-habitat veto, body size, the
// school terms, and the two-stage contour retry.
//
// Everything is scaled by the host's `dt`. There is no wall clock in this file.

import {
  AVOID_TURN_ATTEMPTS as SHARED_AVOID_TURN_ATTEMPTS,
  AVOID_TURN_STEP_RADIANS as SHARED_AVOID_TURN_STEP_RADIANS,
  CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR as SHARED_CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR,
  WORLD_UNIT_CELLS,
  cellsAcross,
  limitTurn as sharedLimitTurn,
  normalizeAngle as sharedNormalizeAngle,
  steerAvoiding,
  steerWithShorteningProbe,
  turnToward as sharedTurnToward,
  withoutSelf,
  type Occupant,
} from '@terrace/shared';
import { WILDLIFE_SIZE_MODEL_SCALE, type WildlifeHabitatSpecies } from '../protocol.ts';
import { type HabitatWorld, canTraverse, isValidCellFor, walkerProfileOf } from './census.ts';
import { type WildlifeEntity, livingEntities } from './population.ts';
import { randomSigned, rollEvent } from './rng.ts';
import {
  SCHOOL_LOOSENESS_BY_SIZE,
  SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS,
  TURN_RADIUS_BODY_LENGTHS,
  profileOf,
} from './species.ts';

/**
 * How far ahead a creature checks, expressed in seconds of its own travel. It
 * looks at where it will be in 0.6 s and refuses to go there if that is not
 * habitat — so a fleeing fish at triple speed automatically looks three times
 * further ahead than a cruising one, which is exactly when it needs to.
 *
 * 0.6 s is six ticks at TICK_HZ 10: enough warning to complete a turn before the
 * shoreline, short enough that a creature still uses a narrow inlet instead of
 * treating it as a wall.
 */
export const LOOKAHEAD_SECONDS = 0.6;

/**
 * Candidate headings tried when the way ahead is blocked, and the angle between
 * them — now shared's, not this file's own copy (2026-08-21).
 *
 * The values and the reasoning are unchanged: eight × 45° sweeps the full
 * circle, so "there is a way out of this cell" and "the search found it" are the
 * same statement — no creature can be trapped by the search being too coarse —
 * and candidates alternate left/right of the desired heading, so the creature
 * takes the SMALLEST turn that works and a shoreline reads as a deflection
 * rather than a bounce. What changed is where they live: three other plugins
 * cited THIS file's copy when they wrote their own, so this is the copy that had
 * to go for the citation chain to end. Re-exported under the old names so this
 * plugin's own call sites and tests do not have to move.
 */
export const AVOID_TURN_ATTEMPTS = SHARED_AVOID_TURN_ATTEMPTS;
export const AVOID_TURN_STEP_RADIANS = SHARED_AVOID_TURN_STEP_RADIANS;

/**
 * Divides the ordinary look-ahead distance for the CONTOUR-FOLLOWING rung of
 * the steer ladder. SHARED'S, re-exported — the value and the reasoning behind
 * it live with the ladder in shared/src/steering.ts since 2026-08-24.
 *
 * Owner, 2026-08-19: "anything traveling across the map … attempts to go
 * around obstacles instead of over or through them."
 */
export const CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR = SHARED_CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR;

/**
 * The tightest arc a creature will turn through, as a fraction of its own body
 * length — SPECIES/PROFILE.TS'S NOW, re-exported.
 *
 * It stopped being a global on 2026-09-02: it is the value every row but the
 * ray's states for its own `turnRadiusBodyLengths`, and a value a row declares
 * has to live where the rows can read it (./species/profile.ts). The reasoning
 * — why half a body length, and why the look-ahead floor is what stops it
 * rising — travelled with it. Re-exported under the old name because it is the
 * figure boats' own turning circle cites (plugins/boats/server/fleet.ts).
 */
export { TURN_RADIUS_BODY_LENGTHS };

/**
 * Multiplier on cruise speed while fleeing, and how long the panic lasts.
 * ×3 is the difference between "swimming" and "bolting" at a glance; 2.5 s is
 * long enough for a fish to clear the ~12-cell disturbance radius (3 cells/s × 3
 * × 2.5 s = 22 cells) and short enough that the scene settles back to ambient
 * before the player has finished their next sculpt.
 */
export const FLEE_SPEED_MULTIPLIER = 3;
export const FLEE_DURATION_SECONDS = 2.5;

// ── Cohesion: the boids-lite school ──────────────────────────────────────────
//
// Owner, 2026-08-14: "I see individual fish but I haven't seen any schools of
// fish." A group spawned together but every member wandered independently, so a
// school existed only at the instant it appeared and was gone inside a minute.
//
// The fix is two extra terms in the steering blend — attraction to the school's
// centroid and alignment with its mean heading — and NOTHING ELSE changes. In
// particular the two behaviours that already had authority keep it absolutely:
//
//   * HABITAT / UNLOCK STEERING WINS. Cohesion only ever proposes a DESIRED
//     heading; steerToValidHeading vetoes it against the world exactly as it
//     vetoes a wander, and the destination re-check downstream is untouched. A
//     school straddling a new island is deflected member by member — the ones
//     over land turn along the shore rather than being pulled onto it — which is
//     what makes "the terrain always wins" true by construction rather than by a
//     priority number somewhere.
//   * FLEE WINS. A startled creature skips cohesion entirely, so a school hit by
//     a sculpt scatters outright and re-forms afterwards, which is both correct
//     and the best-reading thing this behaviour does.
//
// There is no separation term. Fish are 0.7 cells long and the comfort radius is
// several times that, so members never converge to a point: the attraction
// switches off before they are close enough to overlap, which is the job
// separation would otherwise do at the cost of a third term to tune.

/**
 * Distance from the rest of its school, in cells, inside which a creature feels
 * no pull at all.
 *
 * This is the visible size of a school, and it is the number the "4–6 cell blob
 * that drifts as one" brief turns into: 2.5 cells of radius is a 5-cell blob.
 * Measured over 60 × 5-minute runs, a small school's radius averages 1.5 cells
 * and peaks at 6.5 — the comfort radius is an upper bound on ordinary drift, not
 * the radius itself, because members inside it are steered by nothing but their
 * own wander.
 *
 * Stated in WORLD UNITS and converted, like every distance a creature is
 * measured against. It also comfortably contains the ±1.4-unit scatter a group
 * is born with (GROUP_SCATTER_BODY_LENGTHS × a fish's 0.7-unit body), so a newborn school
 * does not clench inward the moment it appears.
 *
 * Scaled per creature by schoolLoosenessOf: this is the SMALL-fish figure, and
 * a larger class — or a larger species — holds proportionally more space.
 */
export const SCHOOL_COMFORT_RADIUS_CELLS = cellsAcross(2.5);

/**
 * Distance at which the pull reaches SCHOOL_MAX_PULL_RADIANS_PER_SECOND; it
 * ramps linearly from zero at the comfort radius to full here, and stays there
 * beyond.
 *
 * 5 world units is a little under two seconds of cruise swimming (3 units/s) away from
 * the school — the point past which a member is not "at the edge of the group"
 * but "leaving", and should be turning as hard as it can. A ramp rather than a
 * step because a step produces a visible flinch as a fish crosses the boundary;
 * the linear region is what makes the edge of a school look soft.
 */
export const SCHOOL_FULL_PULL_RADIUS_CELLS = cellsAcross(5);

/**
 * Maximum cohesion turn rate, radians per second, at or beyond the full-pull
 * radius.
 *
 * Sized against the thing it has to beat: a fish's own wander noise is ±1.4
 * rad/s (turnNoiseRadiansPerSecond), so at 3 rad/s cohesion can out-turn the
 * meander that disperses a school even at the noise's extreme, with margin. It
 * also turns a fish that is swimming directly away (π radians of correction)
 * back toward the group in ~1 s, during which it covers ~3 cells — which is why
 * the full-pull radius sits at 5 and not at 10: a fish must start correcting
 * early enough that the overshoot still lands inside a readable blob.
 *
 * Divided per creature by schoolLoosenessOf (a larger animal is slower to close
 * a gap it was more relaxed about in the first place).
 */
export const SCHOOL_MAX_PULL_RADIANS_PER_SECOND = 3;

/**
 * Turn rate, radians per second, toward the school's mean heading.
 *
 * Mild on purpose — a fifth of the maximum cohesion pull. Alignment is what
 * turns a cluster that happens to stay together into a school that DRIFTS as one
 * body; it is not what holds the school together, and if it were strong enough
 * to matter next to cohesion it would fight it (a member behind the group would
 * be pulled forward by one term and told to face the same way by the other,
 * which reads as milling). At 0.6 rad/s a school converges on a common heading
 * over a handful of seconds, which looks like a shoal turning.
 */
export const SCHOOL_ALIGNMENT_RADIANS_PER_SECOND = 0.6;

/**
 * How coherent a school's headings must be before its mean heading is used at
 * all, as the length of the mean of its members' unit heading vectors (1 = all
 * swimming the same way, 0 = perfectly cancelling).
 *
 * Below 0.1 there is no meaningful mean: that is a school that has just been
 * scattered by a sculpt, and `atan2` of a near-zero vector turns floating-point
 * dust into a confident direction. Skipping alignment there is what lets
 * cohesion alone pull a scattered school back together instead of every member
 * chasing the same piece of noise.
 */
export const SCHOOL_MIN_HEADING_COHERENCE = 0.1;

/** Normalises an angle to (-π, π]. Shared's, re-exported — see above. */
export const normalizeAngle = sharedNormalizeAngle;

/** Current speed in cells/second: cruise, or burst while fleeing. */
export function speedOf(entity: WildlifeEntity): number {
  const cruise = profileOf(entity.species).cruiseSpeedCellsPerSecond;
  return entity.fleeSecondsRemaining > 0 ? cruise * FLEE_SPEED_MULTIPLIER : cruise;
}

/**
 * This creature's school-spacing multiplier: how much more room than a small
 * fish it keeps from its schoolmates, and how much more slowly it closes a gap.
 *
 * Two independent terms, because a creature is bigger in two independent ways:
 *
 *   * its SIZE CLASS within the species (SCHOOL_LOOSENESS_BY_SIZE) — a large
 *     fish keeps a body length or two more space than a small one;
 *   * its SPECIES' body length against the fish these radii were calibrated for
 *     (SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS) — a whale is seven times a
 *     fish and holds seven times the distance.
 *
 * The species term is exactly 1 for the fish by construction, so this cannot
 * move the only school the constants above were ever tuned against.
 */
export function schoolLoosenessOf(entity: WildlifeEntity): number {
  const species = profileOf(entity.species).bodyLengthCells
    / SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS;
  return SCHOOL_LOOSENESS_BY_SIZE[entity.size] * species;
}

/** This creature's actual length in cells: the species' figure, scaled by size. */
export function bodyLengthCellsOf(entity: WildlifeEntity): number {
  return profileOf(entity.species).bodyLengthCells * WILDLIFE_SIZE_MODEL_SCALE[entity.size];
}

/**
 * Personal space around one creature, in cells — how close another body may
 * come before a candidate heading is refused (shared's `steerAvoiding`).
 *
 * HALF ITS OWN BODY LENGTH, so it is a derived half-extent rather than a tuning
 * dial: two creatures hold their two half-lengths apart, which is one body
 * length centre to centre for a matched pair. That is the same shape pilgrims'
 * WALKER_PERSONAL_SPACE_CELLS has (a measured half-extent), stated as a
 * function here because wildlife has no single body: a small fish is 0.42 cells
 * long and a whale is 5, and one constant for both would either let whales
 * overlap or hold fish a whale's length apart.
 *
 * IT DOES NOT FIGHT THE SCHOOL. Cohesion only starts pulling outside
 * SCHOOL_COMFORT_RADIUS_CELLS (2.5 cells for a small fish, scaled up per
 * creature by schoolLoosenessOf), and the separation floor for two small fish is
 * 0.42 cells — a sixth of that. The two terms therefore act on disjoint distance
 * ranges: separation keeps bodies from interpenetrating, cohesion keeps the
 * group together, and neither is ever the thing overruling the other.
 *
 * THAT DISJOINTNESS IS WHY LOOSENESS SCALES WITH SPECIES BODY LENGTH. Both terms
 * here are proportional to the body — separation is half of it, cohesion's
 * radii are a multiple of the fish it was calibrated against — so as long as the
 * second scales the same way the first does, the gap between them holds for any
 * size of animal. When whales started podding (2026-08-21) an unscaled comfort
 * radius of 2.5 cells would have sat INSIDE the 2.5-cell personal space of a
 * five-unit body, and the two terms would have met for the first time.
 */
export function personalSpaceCellsOf(entity: WildlifeEntity): number {
  return bodyLengthCellsOf(entity) / 2;
}

/**
 * How fast this creature may swing its heading, radians per second: its speed
 * divided by the radius of its turning circle (TURN_RADIUS_BODY_LENGTHS).
 *
 * BOTH INPUTS ARE THE LIVE ONES, and that is what makes this a turning CIRCLE
 * rather than a turn-rate dial:
 *
 *   * body length is the SIZE-SCALED one, so a large whale comes about more
 *     slowly than a calf — because it is longer, not because a table says so;
 *   * speed is the CURRENT one, so a fleeing creature at FLEE_SPEED_MULTIPLIER
 *     turns three times as fast in radians and traces the SAME arc through the
 *     water. Panic makes an animal cover its turn quicker; it does not let it
 *     pivot on the spot.
 *
 * Comfortably above every wander in the table (a whale's own turn noise is
 * 0.25 rad/s against the ~0.32 this gives it, a fish's 1.4 against ~8.6), so
 * this bounds the habitat veto's candidate — which had no bound at all — and
 * does not quietly become a second, tighter noise limit.
 */
export function maxTurnRadiansPerSecondOf(entity: WildlifeEntity): number {
  // The RADIUS is the species' own since 2026-09-02 — TURN_RADIUS_BODY_LENGTHS
  // is what every row but the ray's declares, and the ray banks three times as
  // wide (./species/ray.ts). The two inputs beside it are unchanged and are
  // still the live ones.
  const radiusBodyLengths = profileOf(entity.species).turnRadiusBodyLengths;
  return speedOf(entity) / (radiusBodyLengths * bodyLengthCellsOf(entity));
}

/**
 * The moving population a creature must keep clear of, as shared's `Occupant`
 * rows, in the population's own fixed order (shared/src/steering.ts's
 * determinism note).
 *
 * WILDLIFE ONLY, deliberately. Boats keep clear of boats and walkers of
 * walkers; nothing in the shipped game shares an occupant list across plugins,
 * because no plugin can see another's population and inventing a cross-plugin
 * registry is a bigger decision than "fish should not swim through each other".
 * The residual is named rather than hidden: a grazer and a pilgrim on the same
 * hillside still pass through one another.
 *
 * COST: one row per living creature per tick, and `steerAvoiding` scans the
 * whole list per candidate heading — at WILDLIFE_POPULATION_CAP (850) that is
 * at most 850 × 9 × 850 ≈ 6.5 M squared-distance compares per tick, ~65 M/s at
 * TICK_HZ 10.
 *
 * THE TRIGGER THIS COMMENT NAMED HAS FIRED (2026-08-23). It used to read "at
 * 150 … ≈ 200 k per tick, ~2 M/s … a spatial index is the answer if the cap
 * ever moves by an order of magnitude, not before". The cap then moved 150 →
 * 850 to pay for the grazer density cut (census.ts), and because this is
 * QUADRATIC in the cap the cost went up 32-fold, not 5.7-fold. At 65 M compares
 * a second this is no longer uninteresting beside the habitat census, and a
 * spatial index (or a coarse occupancy grid, which is the cheaper half-step) is
 * now genuinely owed.
 *
 * WHAT STOPS IT BEING URGENT, stated so nobody reads the paragraph above as a
 * live fire: the quadratic is in the LIVING population, not the cap, and the
 * living population only approaches 850 on a fully-revealed half-land world.
 * Every world that exists is ocean with an island and carries a handful of
 * creatures, where this is the same few thousand compares it always was. The
 * work is owed the day a world with real land exists, and should be MEASURED
 * then rather than guessed at now.
 */
export function creatureOccupants(entities: Iterable<WildlifeEntity>): Occupant[] {
  const rows: Occupant[] = [];
  for (const entity of entities) {
    rows.push({ x: entity.x, y: entity.y, radiusCells: personalSpaceCellsOf(entity) });
  }
  return rows;
}

/**
 * How far ahead this creature probes, in cells. Never less than its own body
 * length: a 5-cell whale that only looked 0.5 cells ahead would have its head in
 * open water and its tail through a cliff.
 *
 * The body length is the SIZE-SCALED one, so the size class the client draws and
 * the size the sim reasons about are the same number rather than two that agree
 * by luck.
 */
export function lookaheadCellsFor(entity: WildlifeEntity): number {
  return Math.max(bodyLengthCellsOf(entity), speedOf(entity) * LOOKAHEAD_SECONDS);
}

// ── School aggregates ────────────────────────────────────────────────────────

/**
 * The minimum a thing must be for the cohesion maths to steer it: a position and
 * a facing.
 *
 * STRUCTURAL ON PURPOSE. The steering below is geometry — "turn toward where the
 * rest of your group is, and toward the way it is facing" — and nothing in it
 * depends on habitat, size class or species. Typing it against this interface
 * rather than against WildlifeEntity is what lets the bird flocks in ./flocks.ts
 * reuse the SAME cohesion and alignment terms as the fish schools instead of
 * growing a second copy that drifts from this one.
 */
export interface SchoolMember {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/**
 * Everything the cohesion terms need about one school, as running sums so a
 * member can subtract ITSELF out (see `steerWithSchool`).
 *
 * Computed once per tick, from the population as it stood BEFORE anything moved.
 * That is what makes a tick's steering independent of the order members happen
 * to sit in the array: every member of a school reacts to the same centroid,
 * rather than the last member reacting to a centroid the first four already
 * moved.
 */
export interface SchoolSummary {
  readonly count: number;
  readonly sumX: number;
  readonly sumY: number;
  /** Sums of the members' unit heading vectors — a circular mean, not an angle mean. */
  readonly sumCos: number;
  readonly sumSin: number;
}

/**
 * Aggregates one already-grouped body of members. Callers that hold their groups
 * directly (a bird flock owns its birds) use this; callers holding a flat
 * population use `summarizeSchools`, which is written in terms of it so the sums
 * exist exactly once.
 */
export function summarizeSchool(members: readonly SchoolMember[]): SchoolSummary {
  let sumX = 0;
  let sumY = 0;
  let sumCos = 0;
  let sumSin = 0;
  for (const member of members) {
    sumX += member.x;
    sumY += member.y;
    sumCos += Math.cos(member.heading);
    sumSin += Math.sin(member.heading);
  }
  return { count: members.length, sumX, sumY, sumCos, sumSin };
}

/** Groups a population by school id. */
export function summarizeSchools(
  population: readonly (SchoolMember & { readonly schoolId: number })[],
): Map<number, SchoolSummary> {
  const grouped = new Map<number, SchoolMember[]>();

  for (const entity of population) {
    const members = grouped.get(entity.schoolId);
    if (members === undefined) grouped.set(entity.schoolId, [entity]);
    else members.push(entity);
  }

  const schools = new Map<number, SchoolSummary>();
  for (const [schoolId, members] of grouped) schools.set(schoolId, summarizeSchool(members));
  return schools;
}

/**
 * Cohesion turn rate, radians per second, for a member `distanceCells` from the
 * rest of its school: zero inside the comfort radius, ramping linearly to the
 * maximum at the full-pull radius, flat beyond it.
 *
 * `looseness` is the caller's spacing multiplier (schoolLoosenessOf for a
 * swimmer): it widens both radii and softens the maximum, which is the whole of
 * "a bigger animal schools more loosely".
 */
export function cohesionPullRadiansPerSecond(distanceCells: number, looseness: number): number {
  const comfort = SCHOOL_COMFORT_RADIUS_CELLS * looseness;
  if (distanceCells <= comfort) return 0;

  const full = SCHOOL_FULL_PULL_RADIUS_CELLS * looseness;
  const ramp = Math.min(1, (distanceCells - comfort) / (full - comfort));
  return (ramp * SCHOOL_MAX_PULL_RADIANS_PER_SECOND) / looseness;
}

/** Clamps a turn to `limit` radians while keeping its direction. Shared's. */
export const limitTurn = sharedLimitTurn;

/**
 * Turns `heading` toward `target` by at most `radiansPerSecond × dt`, and never
 * past it. SHARED'S, re-exported — it moved to shared/src/steering.ts on
 * 2026-08-24 when boats needed the same turning circle these creatures got.
 *
 * The shape every steering term in this plugin has: clamped by a rate AND by the
 * angle actually remaining, so terms compose additively without any of them
 * being able to overshoot. The flock course-hold in ./flocks.ts is precisely
 * this and nothing else.
 */
export const turnToward = sharedTurnToward;

/**
 * THE STEERING BLEND. Takes the heading the creature's own wander wants and
 * returns the heading its school wants it to have, as
 *
 *     wander  +  cohesion toward the centroid  +  alignment to the mean heading
 *
 * Both school terms are TURN LIMITS applied to the wander result, never
 * replacements for it: each is clamped both by its own rate × dt and by the
 * angle actually remaining to its target, so neither can overshoot, the two can
 * be added without a stability argument, and a creature whose school is already
 * where it wants to be simply keeps wandering. This is composition, not
 * priority — the priority in this file belongs to the habitat veto that runs
 * after all of it.
 *
 * SELF IS EXCLUDED from both aggregates. A member steers toward where the REST
 * of its school is, not toward an average that includes its own position: with
 * two members, including self would halve the perceived offset and make the
 * smallest, most fragile schools the loosest ones.
 *
 * `looseness` is the caller's spacing multiplier — schoolLoosenessOf for a fish
 * or a whale, BIRD_FLOCK_LOOSENESS for a bird. It is a parameter rather than a
 * lookup inside this function so the steering stays pure geometry and works for
 * any group of any species (see SchoolMember).
 */
export function steerWithSchool(
  member: SchoolMember,
  school: SchoolSummary,
  looseness: number,
  wanderHeading: number,
  dt: number,
): number {
  const others = school.count - 1;
  // A school of one is a creature on its own: it wanders exactly as it always
  // did. This is also the "a school that has shrunk to its last member" case.
  if (others < 1) return wanderHeading;

  let heading = wanderHeading;

  // (b) COHESION — toward the centroid of the other members.
  const centroidX = (school.sumX - member.x) / others;
  const centroidY = (school.sumY - member.y) / others;
  const dx = centroidX - member.x;
  const dy = centroidY - member.y;
  const distance = Math.hypot(dx, dy);
  const pull = cohesionPullRadiansPerSecond(distance, looseness);
  if (pull > 0) {
    const toCentroid = normalizeAngle(Math.atan2(dy, dx) - heading);
    heading = normalizeAngle(heading + limitTurn(toCentroid, pull * dt));
  }

  // (c) ALIGNMENT — toward the mean heading of the other members, if they agree
  // on one at all (see SCHOOL_MIN_HEADING_COHERENCE).
  const meanCos = (school.sumCos - Math.cos(member.heading)) / others;
  const meanSin = (school.sumSin - Math.sin(member.heading)) / others;
  if (Math.hypot(meanCos, meanSin) >= SCHOOL_MIN_HEADING_COHERENCE) {
    const toMean = normalizeAngle(Math.atan2(meanSin, meanCos) - heading);
    heading = normalizeAngle(
      heading + limitTurn(toMean, SCHOOL_ALIGNMENT_RADIANS_PER_SECOND * dt),
    );
  }

  return heading;
}

/**
 * Picks a heading whose look-ahead cell is valid habitat, reachable from where
 * the creature stands right now without crossing a slope steeper than its
 * species can climb (sampled along the whole probe segment, not just its far
 * end), and clear of every other creature — preferring `desired` and then the
 * smallest deviation from it. Returns null when the creature is boxed in on
 * every candidate; the caller then holds position.
 *
 * A THIN ADAPTER over shared's `steerAvoiding` since 2026-08-21. What this
 * function adds to the shared loop is the two things shared cannot know:
 *
 *   - the species → traversal archetype resolution (census.ts's
 *     `walkerProfileOf`), and
 *   - the `permits` veto, which is `isValidCellFor` — the SAME predicate
 *     spawning and the habitat-loss sweep use. It re-tests the ground class
 *     that `steerAvoiding` has already tested, and that redundancy is bought
 *     on purpose: `isValidCellFor` is the one place "somewhere this species
 *     may be" is defined (census.ts's own doc), and re-deriving the unlocked
 *     half of it here would be a fourth caller free to disagree with the other
 *     three. The extra cost is a mask lookup and a height compare per
 *     candidate.
 *
 * SEPARATION IS OPTIONAL AND OFF BY DEFAULT here, because two of this
 * function's three callers are single-creature probes with no population in
 * hand (the contour retries in `advanceEntity`). `advanceMovement` supplies
 * the list; a caller that does not simply gets the pre-2026-08-21 behaviour.
 *
 * This runs for a FLEEING creature too (advanceEntity calls it with the panic
 * heading as `desired`): a startled grazer looks up to FLEE_SPEED_MULTIPLIER
 * further ahead, but every veto still applies to every candidate, so panic can
 * make it run further, never make it run up a cliff it could not otherwise
 * climb.
 */
export function steerToValidHeading(
  world: HabitatWorld,
  entity: WildlifeEntity,
  desired: number,
  lookahead: number,
  stepCells: number,
  occupants: readonly Occupant[] = [],
): number | null {
  return steerAvoiding(world, walkerProfileOf(entity.species), entity, desired, lookahead, {
    stepCells,
    occupants,
    selfRadiusCells: personalSpaceCellsOf(entity),
    permits: (x, y) => isValidCellFor(world, entity.species, x, y),
  });
}

/**
 * The whole steer for one tick. SHARED'S LADDER (`steerWithShorteningProbe`),
 * with this plugin's two additions bolted on: the species → traversal archetype
 * resolution and the `isValidCellFor` veto that `steerToValidHeading` supplies
 * — see that function for why the veto is worth its redundancy.
 *
 * The three shortening rungs and the reasoning behind each of them moved to
 * `shared/` on 2026-08-24, when boats needed exactly the same ladder for
 * exactly the same reason ("constantly getting stuck"). Read the contract
 * there; nothing about it is wildlife-specific.
 */
function steerThisTick(
  world: HabitatWorld,
  entity: WildlifeEntity,
  desired: number,
  lookahead: number,
  stepCells: number,
  occupants: readonly Occupant[],
): number | null {
  return steerWithShorteningProbe(
    world,
    walkerProfileOf(entity.species),
    entity,
    desired,
    lookahead,
    {
      stepCells,
      occupants,
      selfRadiusCells: personalSpaceCellsOf(entity),
      permits: (x, y) => isValidCellFor(world, entity.species, x, y),
    },
  );
}

/**
 * Flips this creature's idle bout on or off for this step, and cancels one
 * outright while it is fleeing.
 *
 * A TWO-STATE POISSON PROCESS (the rates live on the species' `idle`, see
 * IdleBouts in ./species/profile.ts): while moving it may stall, while stalled
 * it may resume, and both are memoryless — there is no countdown to store and
 * no phase for a player to learn. The shape is the one monsters' `lurk.ts`
 * settled on; nothing is imported from that plugin.
 *
 * FLEEING CANCELS IT, and cancels it rather than merely masking it. A startled
 * animal has stopped grazing by definition, and if the flag were only ignored
 * during the panic the animal would drop straight back into a bout the instant
 * it calmed — which reads as an animal that ran ten cells and then froze. The
 * bout it is in is over; it may start a new one on any tick after the panic
 * ends, at the ordinary onset rate.
 *
 * A SPECIES WITH NO `idle` NEVER ENTERS ONE. The field is absent rather than a
 * pair of zeroes, so this is a shape test and not an arithmetic one — and the
 * flag on such a creature is false from spawn and can never be written.
 *
 * Exported for the same reason monsters export theirs: it is the whole of the
 * behaviour, and the alternative is asserting it through a full tick.
 */
export function advanceIdleState(entity: WildlifeEntity, dt: number): void {
  if (entity.fleeSecondsRemaining > 0) {
    entity.idle = false;
    return;
  }
  const idle = profileOf(entity.species).idle;
  if (idle === undefined) return;
  const rate = entity.idle ? idle.endPerSecond : idle.onsetPerSecond;
  if (rollEvent(rate, dt)) entity.idle = !entity.idle;
}

/**
 * Advances one creature by `dt`.
 *
 * Order matters, and it is the order the priorities are stated in:
 *
 *   1. the flee timer decays (so a creature that just calmed down moves at
 *      cruise speed this very tick), and the idle bout resolves — a creature in
 *      one returns here and does nothing else: it neither translates NOR turns,
 *      which is the difference between an animal that has stopped to graze and
 *      one treading water on the spot (see `advanceIdleState`);
 *   2. turn noise perturbs the heading — the creature's own wander;
 *   3. its school pulls on that, UNLESS it is fleeing, in which case panic
 *      overrides the school entirely and the group scatters;
 *   4. steering vetoes the result against the world — habitat and unlocked
 *      territory beat everything above, always — and the heading it commits to
 *      is bounded by the creature's turning circle (maxTurnRadiansPerSecondOf),
 *      which is the one rate limit the veto used not to have;
 *   5. the position moves, and is re-checked.
 *
 * A creature that cannot find any valid heading holds its position for this
 * tick — un-wedging happens by trying again next tick, never by placing it
 * illegally. Position and heading are committed TOGETHER at the very end, with
 * exactly one exception, added 2026-08-24 and argued at its own call site: a
 * creature whose step is vetoed but which the ladder DID hand a legal direction
 * commits the turn alone, so a turn-rate-limited animal can come about on the
 * spot instead of standing against a riser forever. Every other "hold position"
 * return leaves both exactly as the tick found them.
 *
 * `school` is the summary of the creature's own school as it stood at the START
 * of the tick (see summarizeSchools); omitting it steers with wander alone,
 * which is what the solitary case and any caller without a population index get.
 *
 * `occupants` is everybody ELSE, as they stood at the start of the tick — the
 * same snapshot discipline, and for the same reason: a creature's step must not
 * depend on where it sits in the iteration order. It must not contain this
 * creature (see `creatureOccupants` and shared's `withoutSelf`). Omitting it
 * disables separation for this creature only.
 */
export function advanceEntity(
  world: HabitatWorld,
  entity: WildlifeEntity,
  dt: number,
  school?: SchoolSummary,
  occupants: readonly Occupant[] = [],
): void {
  if (entity.fleeSecondsRemaining > 0) {
    entity.fleeSecondsRemaining = Math.max(0, entity.fleeSecondsRemaining - dt);
  }

  const profile = profileOf(entity.species);
  const fleeing = entity.fleeSecondsRemaining > 0;

  // THE IDLE BOUT, resolved before anything else moves — so an animal that just
  // resumed walks this very tick rather than standing through the tick it woke
  // in. See `advanceIdleState` for the state machine and for why fleeing wins.
  advanceIdleState(entity, dt);
  if (entity.idle) return;

  // A fleeing creature swims straight: panic suppresses idle meandering.
  const noise = fleeing ? 0 : randomSigned(profile.turnNoiseRadiansPerSecond * dt);

  const wander = normalizeAngle(entity.heading + noise);
  const desired =
    fleeing || school === undefined
      ? wander
      : steerWithSchool(entity, school, schoolLoosenessOf(entity), wander, dt);
  const lookahead = lookaheadCellsFor(entity);
  // One tick's travel — where separation is tested, and the same number every
  // step below moves by. Computed once so the distance the sweep reasons about
  // and the distance the creature actually covers cannot come apart.
  const stepCells = speedOf(entity) * dt;
  const turnRate = maxTurnRadiansPerSecondOf(entity);
  const wanted = steerThisTick(world, entity, desired, lookahead, stepCells, occupants);

  if (wanted === null) {
    // Nowhere legal even one tick's travel away, in any direction: a one-cell
    // pocket. Hold position and keep facing as-is — inventing a heading with
    // no matching movement is the twitch this replaces.
    return;
  }

  // THE TURNING CIRCLE, and it is the whole answer to "no spinning in place"
  // (owner, 2026-08-24). `wanted` is a DIRECTION, freely up to 180° off; what
  // the creature adopts is its current heading turned toward that direction by
  // at most one tick's worth of its own turn rate. Nothing anywhere overrides
  // this — a creature with no in-arc option holds still (above and below)
  // rather than pivoting, which is exactly the behaviour asked for: it has to
  // swim the arc to come about.
  let steered = turnToward(entity.heading, wanted, turnRate, dt);

  // `steered` is still only a CANDIDATE — it is deliberately NOT written to
  // entity.heading here. The destination re-check below can still veto this
  // step, and a vetoed step must leave the heading alone as well: committing
  // early made a wedged creature spin through headings it could not travel
  // along and depart in an arbitrary direction once the obstacle cleared, and
  // it made the retry sweep below start from the vetoed heading instead of the
  // pre-tick one. Heading and position are committed together, exactly once,
  // at the bottom.
  let nextX = entity.x + Math.cos(steered) * stepCells;
  let nextY = entity.y + Math.sin(steered) * stepCells;

  // BELT AND SUSPENDERS. Since 2026-08-24 the sweep samples the whole probe
  // segment rather than only its far end (shared's `canProceedAlong`), so the
  // narrow-tongue-of-wrong-habitat case this re-check was written for is
  // caught up front now. It stays anyway, and stays cheap: the sweep samples
  // at ~1-cell spacing and the `permits` veto is still only applied at the
  // probe's far end, so a corner clipped between two samples remains
  // expressible. Re-checking the actual destination against both
  // isValidCellFor and canTraverse keeps "no creature is ever outside its
  // habitat, and no creature ever crosses a slope it can't climb" true by
  // construction rather than by trusting the sampling grain.
  if (
    !isValidCellFor(world, entity.species, nextX, nextY) ||
    !canTraverse(world, entity.species, entity.x, entity.y, nextX, nextY)
  ) {
    // Run the whole ladder again from the PRE-TICK heading — genuinely the
    // current one, since the candidate above has not been committed. The sweep
    // said `steered` was fine at `lookahead`, but the actual one-tick step
    // lands somewhere it isn't: a corner clipped between two samples, or a
    // `permits` rule that only the end of the probe was tested against.
    const retry = steerThisTick(world, entity, entity.heading, lookahead, stepCells, occupants);
    if (retry === null) return; // hold position, keep facing as-is.

    steered = turnToward(entity.heading, retry, turnRate, dt);
    nextX = entity.x + Math.cos(steered) * stepCells;
    nextY = entity.y + Math.sin(steered) * stepCells;
    if (
      !isValidCellFor(world, entity.species, nextX, nextY) ||
      !canTraverse(world, entity.species, entity.x, entity.y, nextX, nextY)
    ) {
      // TURN WITHOUT MOVING, and this is the fix for the permanent wedge
      // (owner, 2026-08-24: grazers "get stuck"). `retry` is a direction the
      // ladder certified THIS TICK; `steered` is one tick of the creature's own
      // turning circle toward it, and that partial turn can still point into
      // the obstacle — a creature standing against a riser is asked to go 135°
      // the other way and gets 17°, which is still the riser. Holding BOTH
      // heading and position then made the next tick identical to this one, and
      // the one after that, forever: the escape direction was never inside the
      // arc, so it could never be reached, so the creature never moved again.
      //
      // Committing the heading alone breaks that fixed point without breaking
      // the rule it was protecting. What the 2026-08-24 "commit them together"
      // discipline exists to prevent is a creature spinning through headings
      // NOTHING certified and then departing along an arbitrary one; here the
      // heading only ever rotates toward a direction the ladder just approved,
      // monotonically, so it converges in at most π / turnRate seconds (~1 s
      // for a grazer) and the creature walks away facing somewhere it can go.
      // A grazer that stops at a riser and turns to follow it is also the
      // behaviour the animal should have had all along.
      entity.heading = steered;
      return; // turned in place; no step this tick.
    }
  }

  // The step is known good: commit heading and position together, here and
  // nowhere else. Every "hold position" return above therefore leaves BOTH
  // exactly as the tick found them.
  entity.heading = steered;
  entity.x = nextX;
  entity.y = nextY;
}

/**
 * Advances every living creature.
 *
 * The school summaries AND the occupant rows are both built first, from the
 * population as it stands now, so every member of a school steers against the
 * same pre-tick centroid and every creature avoids the same pre-tick bodies.
 * Cost is two passes over at most WILDLIFE_POPULATION_CAP creatures.
 *
 * `withoutSelf` filters by IDENTITY, not by position (shared's own doc): two
 * creatures may legitimately share a position for a tick, and dropping both
 * would disable separation exactly where it matters most. The rows are built
 * once and the self row filtered out per creature, rather than rebuilt per
 * creature, so the snapshot every creature sees is the same one.
 */
export function advanceMovement(world: HabitatWorld, dt: number): void {
  const population = livingEntities();
  const schools = summarizeSchools(population);
  const occupants = creatureOccupants(population);
  for (let index = 0; index < population.length; index++) {
    const entity = population[index];
    advanceEntity(
      world,
      entity,
      dt,
      schools.get(entity.schoolId),
      withoutSelf(occupants, occupants[index]),
    );
  }

  applyPredatorAlarms();
}

/**
 * Every hunter frightens its prey, from where it has just arrived.
 *
 * AFTER MOVEMENT, NOT DURING IT, and that is the same snapshot discipline the
 * two loops above keep: a hunter startles from its END-of-tick position, so
 * whether a fish is alarmed does not depend on whether its hunter happened to
 * sit earlier or later in the population array. Prey react on the NEXT tick,
 * which is also physically the right order — an animal reacts to where the
 * shark got to, not to where it is going.
 *
 * REUSES `startleNear` rather than growing a second reaction: everything a
 * startle already guarantees applies unchanged — headings are pointed away from
 * the hunter, an existing panic is never shortened, and the flee heading is
 * still vetoed against the habitat by `advanceEntity`, so a fish driven at a
 * beach turns along the shore instead of stranding itself.
 *
 * COST is O(hunters × population) per tick and is affordable only because
 * hunters are rare by density (species/shark.ts's own note). Species that
 * declare no `hunts` cost one property read each.
 */
function applyPredatorAlarms(): void {
  for (const hunter of livingEntities()) {
    const hunts = profileOf(hunter.species).hunts;
    if (hunts === undefined) continue;
    startleNear(hunter.x, hunter.y, hunts.alarmRadiusCells, { species: hunts.preySpecies });
  }
}

/**
 * Narrowing for `startleNear`.
 *
 * IT EXISTS FOR THE HUNTER (species/profile.ts's `Predation`), which is the
 * first caller that startles SOME of what is near a point rather than all of
 * it: a shark frightens the fish and the rays around it and must not frighten
 * itself. The two original callers — a sculpt's diff and a new flame
 * (../index.ts) — pass nothing and get exactly the behaviour they always had,
 * which is why this is an options object with one optional field rather than a
 * required argument that every call site would have to answer.
 */
export interface StartleOptions {
  /** Startle only these species. Omitted means every species. */
  readonly species?: readonly WildlifeHabitatSpecies[];
}

/**
 * REACTIVE PATH. Startles everything within `radius` cells of (centerX, centerY)
 * and points it directly away, at burst speed, for FLEE_DURATION_SECONDS.
 *
 * A creature sitting exactly on the centre has no "away" direction, so it keeps
 * the heading it had — it is already running somewhere, and inventing a random
 * one would look like a glitch rather than a reaction.
 *
 * The heading set here is not validated against the habitat: `advanceEntity`
 * runs the same steering veto on it as on any other heading, so a fish told to
 * flee toward a beach turns along the shore instead of beaching itself.
 *
 * Returns how many creatures were startled.
 */
export function startleNear(
  centerX: number,
  centerY: number,
  radius: number,
  options: StartleOptions = {},
): number {
  const radiusSquared = radius * radius;
  const only = options.species;
  const population = livingEntities();

  // PASS 1 — who the disturbance itself reaches. Recorded rather than acted on,
  // because a herd's answer depends on whether ANY of its members were reached
  // (pass 2), and a single loop would startle the early members of a herd from
  // the disturbance and the late ones from the herd, in array order.
  const reached = new Set<number>();
  const herds = new Set<number>();
  for (const entity of population) {
    if (only !== undefined && !only.includes(entity.species)) continue;
    const dx = entity.x - centerX;
    const dy = entity.y - centerY;
    if (dx * dx + dy * dy > radiusSquared) continue;
    reached.add(entity.id);
    if (profileOf(entity.species).groupStartle) herds.add(entity.schoolId);
  }

  // PASS 2 — the herds. Every living member of a school one of whose members
  // was reached is startled FROM THE SAME ORIGIN as the ones that were, so the
  // whole herd runs the same way rather than fanning out from a point none of
  // them can see. The species filter still applies: a school is single-species
  // by construction, so this can only ever confirm what pass 1 decided, and
  // applying it uniformly means there is one rule rather than two.
  //
  // Only a species that DECLARES groupStartle propagates (species/bison.ts);
  // for everything else `herds` is empty and this is a set lookup per creature.
  let startled = 0;
  for (const entity of population) {
    if (only !== undefined && !only.includes(entity.species)) continue;
    if (!reached.has(entity.id) && !herds.has(entity.schoolId)) continue;

    const dx = entity.x - centerX;
    const dy = entity.y - centerY;
    if (dx !== 0 || dy !== 0) entity.heading = Math.atan2(dy, dx);
    // NEVER SHORTENS AN EXISTING PANIC, on `panicIndividuals`' rule below and
    // for a failure that was MEASURED, not imagined (in-world, 2026-08-26: a
    // torched grazer bolted for 2.5 s of its 8 s burn and then grazed the rest
    // of its death away at cruise speed). A burning individual is at distance
    // ZERO from the `fire:ignited` position its own ignition announces, so the
    // bystander startle always reaches it — a plain assignment here cut the
    // burn-long panic `panicIndividuals` had just set back down to the sculpt
    // burst. `fleeSecondsRemaining` has two writers and both must refuse to
    // shorten, or the shorter one silently wins whenever they coincide.
    entity.fleeSecondsRemaining = Math.max(entity.fleeSecondsRemaining, FLEE_DURATION_SECONDS);
    // A startled animal is not grazing. `advanceIdleState` would clear this on
    // the creature's next step anyway (fleeing cancels a bout); clearing it
    // here as well means the flag is never observably true and fleeing at the
    // same instant, which is what a caller reading the population between two
    // ticks would otherwise see.
    entity.idle = false;
    startled++;
  }
  return startled;
}

/**
 * REACTIVE PATH, THE SECOND ONE: puts these individuals into a panic that lasts
 * `seconds`, without moving them and without pointing them anywhere.
 *
 * FOR A CREATURE THAT IS ITSELF ON FIRE (../server/index.ts's fuel
 * registration), which is a different reaction from `startleNear` above in the
 * two ways that matter:
 *
 *   * THERE IS NO "AWAY". A startled bystander runs from a place; an animal
 *     that is alight carries the fire with it, so it keeps the heading it had
 *     and bolts. Panic already suppresses the idle meander (`advanceEntity`),
 *     so what this produces is a straight, fast run rather than the wandering
 *     of a calm grazer — which is the read the design asks for: "the number is
 *     how long the player watches it run before it drops".
 *   * IT LASTS AS LONG AS THE BURN, not FLEE_DURATION_SECONDS. A sculpt is an
 *     instant and the panic that follows it is a burst; being on fire is a
 *     condition, and an animal that calmed down two and a half seconds into an
 *     eight-second death would walk the rest of it at a grazing pace.
 *
 * WHY THE WHOLE BURN IS SET ONCE RATHER THAN REFRESHED EVERY TICK, decided
 * against the alternative rather than by default. Refreshing would need this
 * plugin to hold its own "which of mine are alight" set, and fire announces
 * only two of a burning individual's four endings to the owner: it says when
 * one burned to death, and says NOTHING when rain puts it out or when the fire
 * is dropped because the animal died of something else (plugins/fire/server/
 * entityBlaze.ts's four endings). A set fed by those announcements would leak,
 * and a leaked entry here is an animal that panics forever. Setting the burn
 * once needs no set at all: the countdown is the burn, it expires on its own,
 * and the only divergence — an animal the rain saved keeps running for the rest
 * of what would have been its life — is both harmless and honest, because it
 * has in fact just been on fire.
 *
 * `fleeSecondsRemaining` therefore stays the ONE definition of the panic state
 * (see `isFleeing`); this adds no second flag that could disagree with it.
 */
export function panicIndividuals(ids: readonly number[], seconds: number): number {
  if (seconds <= 0) return 0;

  let panicked = 0;
  // Iterated over the POPULATION rather than over `ids`, so the order of work
  // is the population's fixed order and not the caller's list — the same
  // discipline every other loop in this file keeps (design § determinism).
  for (const entity of livingEntities()) {
    if (!ids.includes(entity.id)) continue;
    // NEVER SHORTENS an existing panic: an animal startled a moment ago and set
    // alight now must not have its flight cut back to the shorter of the two.
    entity.fleeSecondsRemaining = Math.max(entity.fleeSecondsRemaining, seconds);
    panicked++;
  }
  return panicked;
}

/** Reads the flee state, so its meaning stays defined in exactly one file. */
export function isFleeing(entity: WildlifeEntity): boolean {
  return entity.fleeSecondsRemaining > 0;
}
