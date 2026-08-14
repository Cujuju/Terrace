// Movement: ambient wander, habitat-aware steering, and the reactive flee.
//
// The steering contract, in one sentence: a creature only ever commits to a step
// whose DESTINATION LOOK-AHEAD is inside its own habitat and inside unlocked
// territory, so locked chunks and the wrong terrain are impassable walls rather
// than places it can be pushed out of afterwards.
//
// Everything is scaled by the host's `dt`. There is no wall clock in this file.

import { WILDLIFE_SIZE_MODEL_SCALE } from '../protocol.ts';
import { type HabitatWorld, isValidCellFor } from './census.ts';
import { type WildlifeEntity, livingEntities } from './population.ts';
import { SCHOOL_LOOSENESS_BY_SIZE, profileOf } from './species.ts';

const TWO_PI = Math.PI * 2;

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
 * them. Eight × 45° sweeps the full circle, so "there is a way out of this cell"
 * and "the search found it" are the same statement — no creature can be trapped
 * by the search being too coarse. Candidates alternate left/right of the current
 * heading, so the creature takes the SMALLEST turn that works and a shoreline
 * reads as a deflection rather than a bounce.
 */
export const AVOID_TURN_ATTEMPTS = 8;
export const AVOID_TURN_STEP_RADIANS = Math.PI / 4;

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
 * It also comfortably contains the ±1.4-cell scatter a group is born with
 * (GROUP_SCATTER_BODY_LENGTHS × a fish's 0.7-cell body), so a newborn school
 * does not clench inward the moment it appears.
 *
 * Scaled per size class by SCHOOL_LOOSENESS_BY_SIZE: this is the SMALL-fish
 * figure, and larger classes hold proportionally more space.
 */
export const SCHOOL_COMFORT_RADIUS_CELLS = 2.5;

/**
 * Distance at which the pull reaches SCHOOL_MAX_PULL_RADIANS_PER_SECOND; it
 * ramps linearly from zero at the comfort radius to full here, and stays there
 * beyond.
 *
 * 5 cells is a little under two seconds of cruise swimming (3 cells/s) away from
 * the school — the point past which a member is not "at the edge of the group"
 * but "leaving", and should be turning as hard as it can. A ramp rather than a
 * step because a step produces a visible flinch as a fish crosses the boundary;
 * the linear region is what makes the edge of a school look soft.
 */
export const SCHOOL_FULL_PULL_RADIUS_CELLS = 5;

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

/** Normalises an angle to (-π, π]. */
export function normalizeAngle(radians: number): number {
  const wrapped = radians % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

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

/** Groups a population by school id. */
export function summarizeSchools(
  population: readonly WildlifeEntity[],
): Map<number, SchoolSummary> {
  const schools = new Map<number, { count: number; sumX: number; sumY: number; sumCos: number; sumSin: number }>();

  for (const entity of population) {
    let school = schools.get(entity.schoolId);
    if (school === undefined) {
      school = { count: 0, sumX: 0, sumY: 0, sumCos: 0, sumSin: 0 };
      schools.set(entity.schoolId, school);
    }
    school.count++;
    school.sumX += entity.x;
    school.sumY += entity.y;
    school.sumCos += Math.cos(entity.heading);
    school.sumSin += Math.sin(entity.heading);
  }

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
function limitTurn(turn: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, turn));
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
 */
export function steerWithSchool(
  entity: WildlifeEntity,
  school: SchoolSummary,
  wanderHeading: number,
  dt: number,
): number {
  const others = school.count - 1;
  // A school of one is a creature on its own: it wanders exactly as it always
  // did. This is also the "a school that has shrunk to its last member" case.
  if (others < 1) return wanderHeading;

  const looseness = SCHOOL_LOOSENESS_BY_SIZE[entity.size];
  let heading = wanderHeading;

  // (b) COHESION — toward the centroid of the other members.
  const centroidX = (school.sumX - entity.x) / others;
  const centroidY = (school.sumY - entity.y) / others;
  const dx = centroidX - entity.x;
  const dy = centroidY - entity.y;
  const distance = Math.hypot(dx, dy);
  const pull = cohesionPullRadiansPerSecond(distance, looseness);
  if (pull > 0) {
    const toCentroid = normalizeAngle(Math.atan2(dy, dx) - heading);
    heading = normalizeAngle(heading + limitTurn(toCentroid, pull * dt));
  }

  // (c) ALIGNMENT — toward the mean heading of the other members, if they agree
  // on one at all (see SCHOOL_MIN_HEADING_COHERENCE).
  const meanCos = (school.sumCos - Math.cos(entity.heading)) / others;
  const meanSin = (school.sumSin - Math.sin(entity.heading)) / others;
  if (Math.hypot(meanCos, meanSin) >= SCHOOL_MIN_HEADING_COHERENCE) {
    const toMean = normalizeAngle(Math.atan2(meanSin, meanCos) - heading);
    heading = normalizeAngle(
      heading + limitTurn(toMean, SCHOOL_ALIGNMENT_RADIANS_PER_SECOND * dt),
    );
  }

  return heading;
}

/**
 * Picks a heading whose look-ahead cell is valid habitat, preferring `desired`
 * and then the smallest deviation from it. Returns null when the creature is
 * boxed in on all eight candidates — the caller then holds position.
 */
export function steerToValidHeading(
  world: HabitatWorld,
  entity: WildlifeEntity,
  desired: number,
  lookahead: number,
): number | null {
  for (let attempt = 0; attempt < AVOID_TURN_ATTEMPTS; attempt++) {
    // 0, +45°, -45°, +90°, -90°, … — smallest workable turn first.
    const step = Math.ceil(attempt / 2) * AVOID_TURN_STEP_RADIANS;
    const heading = desired + (attempt % 2 === 1 ? step : -step);
    const probeX = entity.x + Math.cos(heading) * lookahead;
    const probeY = entity.y + Math.sin(heading) * lookahead;
    if (isValidCellFor(world, entity.species, probeX, probeY)) return normalizeAngle(heading);
  }
  return null;
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
 * A creature that cannot find any valid heading keeps its position and reverses,
 * which un-wedges it on the next tick without ever placing it illegally.
 *
 * `school` is the summary of the creature's own school as it stood at the START
 * of the tick (see summarizeSchools); omitting it steers with wander alone,
 * which is what the solitary case and any caller without a population index get.
 */
export function advanceEntity(
  world: HabitatWorld,
  entity: WildlifeEntity,
  dt: number,
  school?: SchoolSummary,
): void {
  if (entity.fleeSecondsRemaining > 0) {
    entity.fleeSecondsRemaining = Math.max(0, entity.fleeSecondsRemaining - dt);
  }

  const profile = profileOf(entity.species);
  const fleeing = entity.fleeSecondsRemaining > 0;
  // A fleeing creature swims straight: panic suppresses idle meandering.
  const noise = fleeing ? 0 : (Math.random() * 2 - 1) * profile.turnNoiseRadiansPerSecond * dt;

  const wander = normalizeAngle(entity.heading + noise);
  const desired =
    fleeing || school === undefined ? wander : steerWithSchool(entity, school, wander, dt);
  const lookahead = lookaheadCellsFor(entity);
  const steered = steerToValidHeading(world, entity, desired, lookahead);

  if (steered === null) {
    entity.heading = normalizeAngle(entity.heading + Math.PI);
    return;
  }

  entity.heading = steered;
  const distance = speedOf(entity) * dt;
  const nextX = entity.x + Math.cos(steered) * distance;
  const nextY = entity.y + Math.sin(steered) * distance;

  // BELT AND SUSPENDERS. The look-ahead validated the cell `lookahead` cells
  // away, which is much further than one tick's travel; that covers the ordinary
  // case but says nothing about the cells in between, so a narrow tongue of the
  // wrong habitat crossing the path could still be stepped into. Re-checking the
  // actual destination makes the invariant "no creature is ever outside its
  // habitat" true by construction rather than by trusting the probe distance.
  // A creature that would step somewhere invalid holds position and turns back.
  if (!isValidCellFor(world, entity.species, nextX, nextY)) {
    entity.heading = normalizeAngle(entity.heading + Math.PI);
    return;
  }

  entity.x = nextX;
  entity.y = nextY;
}

/**
 * Advances every living creature.
 *
 * The school summaries are built first, from the population as it stands now, so
 * every member of a school steers against the same pre-tick centroid. Cost is
 * one pass over at most WILDLIFE_POPULATION_CAP creatures.
 */
export function advanceMovement(world: HabitatWorld, dt: number): void {
  const population = livingEntities();
  const schools = summarizeSchools(population);
  for (const entity of population) advanceEntity(world, entity, dt, schools.get(entity.schoolId));
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
