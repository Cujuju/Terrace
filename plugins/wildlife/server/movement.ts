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
  WORLD_UNIT_CELLS,
  cellsAcross,
  normalizeAngle as sharedNormalizeAngle,
  steerAvoiding,
  withoutSelf,
  type Occupant,
} from '@terrace/shared';
import { WILDLIFE_SIZE_MODEL_SCALE } from '../protocol.ts';
import { type HabitatWorld, canTraverse, isValidCellFor, walkerProfileOf } from './census.ts';
import { type WildlifeEntity, livingEntities } from './population.ts';
import { randomSigned } from './rng.ts';
import { SCHOOL_LOOSENESS_BY_SIZE, profileOf } from './species.ts';

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
 * Divides the ordinary look-ahead distance for the CONTOUR-FOLLOWING retry
 * `steerToValidHeading` runs when the primary sweep finds nothing (see
 * `advanceEntity`'s two-stage steer).
 *
 * Owner, 2026-08-19: "anything traveling across the map … attempts to go
 * around obstacles instead of over or through them." The primary sweep tries
 * all eight AVOID_TURN_ATTEMPTS compass headings at the FULL look-ahead
 * distance; when every one of those fails the creature is genuinely boxed in
 * at that distance, but may still have room to slide along whatever it is
 * pressed against at a shorter one — the same reasoning a person hugging a
 * wall uses short glances, not a long sightline, to keep finding the wall.
 * 2 is the smallest divisor that meaningfully shortens the probe (half
 * distance) while staying well above one tick's own travel (bodyLengthCellsOf
 * already floors the ordinary look-ahead above that), so the retry still
 * senses which way the obstacle runs rather than only re-confirming the
 * creature's own current cell.
 */
export const CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR = 2;

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
 * Scaled per size class by SCHOOL_LOOSENESS_BY_SIZE: this is the SMALL-fish
 * figure, and larger classes hold proportionally more space.
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
 * Divided per size class by SCHOOL_LOOSENESS_BY_SIZE (large fish are slower to
 * close a gap they were more relaxed about in the first place).
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
 * SCHOOL_COMFORT_RADIUS_CELLS (2.5 cells for a small fish, scaled up per size
 * class), and the separation floor for two small fish is 0.42 cells — a sixth of
 * that. The two terms therefore act on disjoint distance ranges: separation
 * keeps bodies from interpenetrating, cohesion keeps the group together, and
 * neither is ever the thing overruling the other. The only species whose
 * separation is large in absolute terms is the whale, which has groupSize 1 and
 * so has no school to fight.
 */
export function personalSpaceCellsOf(entity: WildlifeEntity): number {
  return bodyLengthCellsOf(entity) / 2;
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
 * whole list per candidate heading — at WILDLIFE_POPULATION_CAP (150) that is
 * at most 150 × 9 × 150 ≈ 200 k squared-distance compares per tick, ~2 M/s at
 * TICK_HZ 10. Cheap enough to be uninteresting beside the habitat census that
 * already walks 262 144 cells, and the same shape pilgrims and boats already
 * pay; a spatial index is the answer if the cap ever moves by an order of
 * magnitude, not before.
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
 * `looseness` is the size class's SCHOOL_LOOSENESS_BY_SIZE multiplier: it widens
 * both radii and softens the maximum, which is the whole of "bigger fish school
 * more loosely".
 */
export function cohesionPullRadiansPerSecond(distanceCells: number, looseness: number): number {
  const comfort = SCHOOL_COMFORT_RADIUS_CELLS * looseness;
  if (distanceCells <= comfort) return 0;

  const full = SCHOOL_FULL_PULL_RADIUS_CELLS * looseness;
  const ramp = Math.min(1, (distanceCells - comfort) / (full - comfort));
  return (ramp * SCHOOL_MAX_PULL_RADIANS_PER_SECOND) / looseness;
}

/** Clamps a turn to `limit` radians while keeping its direction. */
export function limitTurn(turn: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, turn));
}

/**
 * Turns `heading` toward `target` by at most `radiansPerSecond × dt`, and never
 * past it.
 *
 * The shape every steering term in this plugin has: clamped by a rate AND by the
 * angle actually remaining, so terms compose additively without any of them
 * being able to overshoot. Extracted because the flock course-hold in
 * ./flocks.ts is precisely this and nothing else.
 */
export function turnToward(
  heading: number,
  target: number,
  radiansPerSecond: number,
  dt: number,
): number {
  const remaining = normalizeAngle(target - heading);
  return normalizeAngle(heading + limitTurn(remaining, radiansPerSecond * dt));
}

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
 * `looseness` is the caller's spacing multiplier — SCHOOL_LOOSENESS_BY_SIZE for
 * a fish, BIRD_FLOCK_LOOSENESS for a bird. It is a parameter rather than a
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
 * Advances one creature by `dt`.
 *
 * Order matters, and it is the order the priorities are stated in:
 *
 *   1. the flee timer decays (so a creature that just calmed down moves at
 *      cruise speed this very tick);
 *   2. turn noise perturbs the heading — the creature's own wander;
 *   3. its school pulls on that, UNLESS it is fleeing, in which case panic
 *      overrides the school entirely and the group scatters;
 *   4. steering vetoes the result against the world — habitat and unlocked
 *      territory beat everything above, always;
 *   5. the position moves, and is re-checked.
 *
 * A creature that cannot find any valid heading holds its position for this
 * tick, facing whichever way it already was (see the two-stage steer below) —
 * un-wedging happens by trying again next tick, never by placing it illegally.
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
  // A fleeing creature swims straight: panic suppresses idle meandering.
  const noise = fleeing ? 0 : randomSigned(profile.turnNoiseRadiansPerSecond * dt);

  const wander = normalizeAngle(entity.heading + noise);
  const desired =
    fleeing || school === undefined
      ? wander
      : steerWithSchool(entity, school, SCHOOL_LOOSENESS_BY_SIZE[entity.size], wander, dt);
  const lookahead = lookaheadCellsFor(entity);
  // Shorter probe used by the contour-following fallback below, both when
  // the primary sweep is fully boxed in and when the belt-and-suspenders
  // re-check catches a miss the primary sweep didn't see.
  const contourLookahead = lookahead / CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR;
  // One tick's travel — where separation is tested, and the same number every
  // step below moves by. Computed once so the distance the sweep reasons about
  // and the distance the creature actually covers cannot come apart.
  const stepCells = speedOf(entity) * dt;
  let steered = steerToValidHeading(world, entity, desired, lookahead, stepCells, occupants);

  if (steered === null) {
    // BOXED IN AT THE LOOK-AHEAD HORIZON. Owner, 2026-08-19: obstacles should
    // deflect a traveller ALONG themselves, not bounce it backward — the
    // previous rule here (`heading += PI`) read as a twitch, and doubly so
    // here since the ±180° candidate is already one of the eight the primary
    // sweep just tried and failed. Retry the SAME compass sweep, but from the
    // creature's CURRENT heading (not `desired`) and at the much shorter
    // contourLookahead: it may still have room to slide along whatever it is
    // pressed against at that distance, which is exactly what "go around"
    // means at the scale of one tick.
    steered = steerToValidHeading(world, entity, entity.heading, contourLookahead, stepCells, occupants);
  }

  if (steered === null) {
    // Enclosed even at the short probe: nothing to turn toward this tick.
    // Hold position and keep facing as-is — inventing a heading with no
    // matching movement is the twitch this replaces.
    return;
  }

  entity.heading = steered;
  let nextX = entity.x + Math.cos(steered) * stepCells;
  let nextY = entity.y + Math.sin(steered) * stepCells;

  // BELT AND SUSPENDERS. The look-ahead validated a cell further out than
  // one tick's travel; that covers the ordinary case but says nothing about
  // the cells in between, so a narrow tongue of the wrong habitat — or a
  // riser steeper than this species can climb — crossing the path could
  // still be stepped into. Re-checking the actual destination, against both
  // isValidCellFor and canTraverse, makes the invariant "no creature is ever
  // outside its habitat, and no creature ever crosses a slope it can't
  // climb" true by construction rather than by trusting the probe distance.
  if (
    !isValidCellFor(world, entity.species, nextX, nextY) ||
    !canTraverse(world, entity.species, entity.x, entity.y, nextX, nextY)
  ) {
    // Same contour-following idea as above, one more time: the coarse sweep
    // said `steered` was fine at `lookahead`, but the actual one-tick step
    // lands somewhere it isn't — a thin obstacle or a corner the sweep
    // stepped past. Re-sweep from the current heading at the short distance
    // before giving up to holding position this tick.
    const retry = steerToValidHeading(world, entity, entity.heading, contourLookahead, stepCells, occupants);
    if (retry === null) return; // hold position, keep facing as-is.

    entity.heading = retry;
    nextX = entity.x + Math.cos(retry) * stepCells;
    nextY = entity.y + Math.sin(retry) * stepCells;
    if (
      !isValidCellFor(world, entity.species, nextX, nextY) ||
      !canTraverse(world, entity.species, entity.x, entity.y, nextX, nextY)
    ) {
      return; // still nowhere to go this tick; hold position.
    }
  }

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
export function startleNear(centerX: number, centerY: number, radius: number): number {
  const radiusSquared = radius * radius;
  let startled = 0;

  for (const entity of livingEntities()) {
    const dx = entity.x - centerX;
    const dy = entity.y - centerY;
    if (dx * dx + dy * dy > radiusSquared) continue;

    if (dx !== 0 || dy !== 0) entity.heading = Math.atan2(dy, dx);
    entity.fleeSecondsRemaining = FLEE_DURATION_SECONDS;
    startled++;
  }
  return startled;
}

/** Reads the flee state, so its meaning stays defined in exactly one file. */
export function isFleeing(entity: WildlifeEntity): boolean {
  return entity.fleeSecondsRemaining > 0;
}
