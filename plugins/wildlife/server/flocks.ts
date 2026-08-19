// Bird flocks: transient ambience that crosses the world overhead and leaves.
//
// Owner, 2026-08-14: "we need random flocks of birds flying overhead."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE SPAWNER AND NOT A FIFTH CENSUS SPECIES
//
// The population machinery next door (census.ts / population.ts) regulates a
// STANDING POPULATION toward a habitat-derived equilibrium. Every one of its
// mechanisms is the wrong shape for a bird, and not by a little:
//
//   * `targetsFor` divides habitat CELLS by a density. Birds occupy no cells; a
//     census would have to invent a habitat for them.
//   * `despawnInvalidHabitat` deletes anything standing outside its habitat on
//     every tick and after every sculpt. A bird is outside every habitat by
//     definition, so it would be culled the tick it appeared.
//   * The respawn-credit loop exists to keep a count STABLE. A flock is supposed
//     to leave and not come back — "the population dropped by nine" is the
//     intended outcome, not a deficit to heal.
//
// So flocks get ~150 lines of their own: a Poisson-ish spawn timer, a straight
// crossing, and a despawn at the far side. THE TRADE-OFF, NAMED: birds are
// therefore outside the population cap, the equilibrium arithmetic, and the
// snapshot. Their cost to the wire is bounded by MAX_BIRDS_ALOFT instead, and
// that ceiling has to be kept in step with WILDLIFE_POPULATION_CAP by hand —
// the combined bandwidth sum in ./index.ts's header is the one place both
// numbers are added up, and the place to look when either moves.
//
// WHAT IS REUSED, DELIBERATELY: the cohesion + alignment steering from
// ./movement.ts, unchanged. A flock IS a school — same geometry, same constants,
// a different looseness — which is why steerWithSchool takes a structural
// SchoolMember and a looseness parameter rather than a fish.
//
// ANTI-CHEAT: this file reads NO terrain and NO unlock mask. It never calls
// heightAt or isCellUnlocked, and the only world property it uses is worldSize.
// A bird's position is therefore a function of RNG alone and leaks exactly
// nothing about locked territory — the same guarantee population.ts gets from
// "creatures only exist in unlocked chunks", reached from the opposite
// direction. (Consequence, accepted: a flock is visible over ground the player
// has not revealed. It tells them nothing about what is down there, and a
// sky-wide no-fly zone around the unlock mask would be both more code and more
// suspicious-looking than the birds are.)
//
// CLOCK: `dt` from the host, exactly like every other file here. No wall clock.
// ─────────────────────────────────────────────────────────────────────────────

import { CHUNK_SIZE } from '@terrace/shared';
import {
  DEFAULT_SIZE_CLASS_INDEX,
  type WildlifeEntityState,
  type WildlifeFlockSpecies,
  roundBroadcastPosition,
} from '../protocol.ts';
import {
  type SchoolSummary,
  normalizeAngle,
  steerWithSchool,
  summarizeSchool,
  turnToward,
} from './movement.ts';
import { allocateEntityId } from './population.ts';
import { randomSigned } from './rng.ts';

/** The only flock species today. Named once so nothing spells it inline. */
const BIRD_SPECIES: WildlifeFlockSpecies = 'bird';

/**
 * Cruise speed of a bird, in cells per second.
 *
 * The ceiling is set by the broadcast, not by ornithology: at the 5 Hz cadence a
 * creature that covers more than ~1.8 cells between updates is past what
 * client-side interpolation has been argued to render smoothly (index.ts's
 * header sizes that bound against a fleeing fish, 3 cells/s × 3 × 0.2 s = 1.8).
 * 8 cells/s × 0.2 s = 1.6 cells sits just under it, so birds need no cadence of
 * their own.
 *
 * That it is also 2.7× a fish and 5× a grazer is the point: birds are the
 * fastest thing in the world, they cross rather than mill, and at this speed a
 * flock is in a player's ~100-cell view for a good ten seconds — long enough to
 * look up at, short enough to be an event.
 */
export const BIRD_CRUISE_SPEED_CELLS_PER_SECOND = 8;

/**
 * Maximum random heading change, radians per second — the same dial as a
 * species' turnNoiseRadiansPerSecond.
 *
 * 0.5 is deliberately low, between a whale's glide (0.25) and a fish's dart
 * (1.4). A bird crossing the map is COMMITTED to a course; the noise exists only
 * so the flock's outline shifts and breathes rather than translating like a
 * rigid body, and anything higher fights the course-hold below for control of
 * the same heading.
 */
export const BIRD_TURN_NOISE_RADIANS_PER_SECOND = 0.5;

/**
 * How hard a bird is pulled back onto its flock's course, radians per second.
 *
 * This is what makes "crosses the world in a roughly straight path" true, and it
 * is sized between the two terms it shares a heading with:
 *
 *   BIRD_TURN_NOISE_RADIANS_PER_SECOND        0.5   ← must lose
 *   FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND  1
 *   cohesion at BIRD_FLOCK_LOOSENESS           1.5   ← must win
 *
 * ABOVE THE NOISE (2×), or a flock random-walks and never leaves — the lifetime
 * guard below would then be doing real work instead of being a guard.
 *
 * BELOW COHESION, and the figure that matters there is 1.5, not the nominal
 * SCHOOL_MAX_PULL_RADIANS_PER_SECOND of 3: cohesionPullRadiansPerSecond divides
 * the maximum by the looseness, so a bird flocking at looseness 2 pulls at most
 * 3/2. The two terms share one heading, so a course-hold at or above that rate
 * buys straightness by taking it out of a straggler's ability to rejoin.
 *
 * MEASURED, because the effect is a rate and not a cliff. One bird displaced 30
 * cells across the course, 40 trials on a 512² world, mean gap after 30 s:
 *
 *     rate  0.5 → 13.3    1 → 13.8    2 → 18.4    4 → 18.8
 *
 * 1 is the knee: it rejoins as fast as the weakest setting tried while holding
 * the line twice as firmly, and the settings above it lose a third of the
 * recovery for no measurable straightness (net displacement over distance flown
 * is 1.00 at every one of these — which is exactly why straightness cannot be
 * the number this is tuned against).
 */
export const FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND = 1;

/**
 * Spacing multiplier handed to the shared cohesion steering, on the same scale
 * as SCHOOL_LOOSENESS_BY_SIZE (1 = the tight small-fish baseline: a 2.5-cell
 * comfort radius, full pull at 5 cells).
 *
 * 2 gives a 5-cell comfort radius and a 10-cell full-pull radius — a flock that
 * reads as a loose 10-cell skein rather than a clenched ball. Birds in the air
 * hold far more space than fish in a shoal (a shoal's spacing is body lengths,
 * a flock's is wingspans of clearance), and at altitude a tight ball would read
 * as a single blob at the distance this game is played from.
 *
 * WHY A LOOSE CLUSTER AND NOT A V. A V is a FORMATION, not steering: it needs a
 * leader, per-bird slot assignment behind-and-outboard of the bird in front, and
 * a re-assignment rule for when a slot's occupant is lost — a solver, not two
 * more terms in a blend. It buys nothing here, because a V is only legible from
 * directly below or above, and this game's camera looks down at the ground from
 * an orbit 80+ cells out; at that angle a V projects to a smear indistinguishable
 * from the cluster the existing steering already produces for free. Reusing
 * cohesion + alignment also means one steering implementation to keep correct
 * instead of two.
 */
export const BIRD_FLOCK_LOOSENESS = 2;

/**
 * Birds in a flock: a uniform draw over this inclusive range.
 *
 * A range rather than a constant so no two crossings look like the same asset
 * played twice. 5 is the floor at which cohesion reads as flocking rather than
 * as a few birds that happen to be near each other (it is also the fish
 * groupSize, for the same reason); 9 is what MAX_BIRDS_ALOFT can afford twice
 * over, and past ~10 the individual birds stop being countable and the flock
 * gains nothing but payload.
 */
export const BIRDS_PER_FLOCK_MIN = 5;
export const BIRDS_PER_FLOCK_MAX = 9;

/**
 * Flocks aloft at once. TWO, and it is a bandwidth number before it is an
 * aesthetic one — see the combined budget in ./index.ts.
 *
 * Two is also the smallest number that makes the sky feel inhabited rather than
 * scripted: with one, a player who watches a flock leave knows the sky is now
 * empty until the timer fires again.
 */
export const MAX_CONCURRENT_FLOCKS = 2;

/**
 * Hard ceiling on birds on the wire. Derived, never written by hand — it is the
 * number the bandwidth arithmetic in ./index.ts consumes.
 */
export const MAX_BIRDS_ALOFT = MAX_CONCURRENT_FLOCKS * BIRDS_PER_FLOCK_MAX;

/**
 * Mean simulated seconds between flock arrivals, as a constant hazard of
 * 1/T per second — the same stochastic shape as SPAWN_MEAN_WAIT_SECONDS, so
 * arrivals are unpredictable rather than metronomic.
 *
 * 60 s against a crossing that takes 25 s on a 128² world and ~95 s on a 512²
 * one (2 × the crossing radius ÷ cruise speed). The two ends behave differently
 * and both are intended: a small world's sky is empty about half the time and a
 * flock is an occasional event, while a large world usually has its two flocks
 * somewhere in 262 144 cells — which is still a sky you have to look up to
 * notice. Making the rate scale with world area was considered and rejected: it
 * would make bandwidth a function of world size, which is the exact property
 * WILDLIFE_POPULATION_CAP exists to deny, and MAX_CONCURRENT_FLOCKS would clamp
 * it back anyway.
 */
export const FLOCK_MEAN_SPAWN_INTERVAL_SECONDS = 60;

/**
 * How far outside the world's own corner a flock is born and dies, in cells.
 *
 * One chunk. The crossing ring (below) already circumscribes the square world,
 * so this is pure margin: it puts the birth and death of a flock beyond the
 * furthest cell any player can be looking at, so flocks are never seen popping
 * into or out of existence — they fly in from off the map and off it again.
 */
export const FLOCK_RING_MARGIN_CELLS = CHUNK_SIZE;

/**
 * Scatter of a newborn flock around its entry point, in cells.
 *
 * Sized on the steering it is handed to: BIRD_FLOCK_LOOSENESS × the shared
 * SCHOOL_COMFORT_RADIUS_CELLS is 5, so a ±4-cell scatter puts every bird inside
 * the radius at which cohesion is silent. A flock therefore forms up gradually
 * out of a loose scatter instead of visibly clenching in its first second — the
 * same argument the fish groups' GROUP_SCATTER_BODY_LENGTHS makes.
 */
export const FLOCK_SPAWN_SCATTER_CELLS = 4;

/**
 * Half-extent, as a fraction of the world edge, of the square around the world's
 * centre that a flock aims at.
 *
 * A course is drawn from the entry point on the ring to a random point in this
 * square, so every crossing passes through the middle half of the map. Aiming at
 * the exact centre would send every flock through one point; aiming anywhere at
 * all would let most crossings clip a corner, which on a 512² world means most
 * flocks are never seen by anyone.
 */
export const FLOCK_AIM_SPREAD_FRACTION = 0.25;

/**
 * Multiple of the nominal crossing time after which a flock is removed wherever
 * it is.
 *
 * BELT AND SUSPENDERS. The course-hold is four times the wander noise, so a
 * flock that fails to reach the far side is not a case this file expects; but
 * "not expected" is not "cannot happen", and the failure mode without a guard is
 * an immortal flock permanently occupying one of MAX_CONCURRENT_FLOCKS slots —
 * the sky quietly stops producing new flocks and nothing anywhere reports why.
 * 2× the straight-line crossing time is loose enough that no legitimate crossing
 * can trip it (that would need the flock to average half speed along its course)
 * and tight enough that a wedged flock clears within a couple of minutes.
 */
export const FLOCK_LIFETIME_SLACK_FACTOR = 2;

/** One bird. Mutable; the tick loop writes it in place. */
export interface Bird {
  readonly id: number;
  x: number;
  y: number;
  heading: number;
}

/** One flock: a body of birds committed to a single crossing. */
export interface Flock {
  readonly id: number;
  /** The straight line this flock is flying, in radians. Never changes. */
  readonly courseHeading: number;
  /** Simulated seconds since the flock appeared; against the lifetime guard. */
  ageSeconds: number;
  readonly birds: Bird[];
}

/** The slice of the world this file reads. Note what is NOT here: terrain. */
export interface FlockWorld {
  readonly worldSize: number;
}

// ── Mutable module state ─────────────────────────────────────────────────────

const flocks: Flock[] = [];
let nextFlockId = 1;

/** Flocks currently aloft, in spawn order. */
export function livingFlocks(): readonly Flock[] {
  return flocks;
}

/** Every bird aloft, across every flock. */
export function livingBirds(): Bird[] {
  const birds: Bird[] = [];
  for (const flock of flocks) birds.push(...flock.birds);
  return birds;
}

/** Drops all flock state so a suite (or a snapshot restore) starts from zero. */
export function resetFlocks(): void {
  flocks.length = 0;
  nextFlockId = 1;
}

// ── Geometry of a crossing ───────────────────────────────────────────────────

/**
 * Radius of the circle flocks enter and leave on, in cells.
 *
 * `Math.SQRT1_2 × worldSize` is exactly half the world square's diagonal, so
 * this circle circumscribes the map: every point of the world is inside it, and
 * a chord of it therefore crosses the world rather than passing outside. The
 * margin then pushes birth and death a chunk further out still.
 */
export function crossingRadiusCells(worldSize: number): number {
  return worldSize * Math.SQRT1_2 + FLOCK_RING_MARGIN_CELLS;
}

/**
 * Radius at which a flock has finished its crossing and is removed.
 *
 * Strictly greater than the entry radius, by one flock-width: a flock is born
 * ON the ring with its members scattered ±FLOCK_SPAWN_SCATTER_CELLS, so its
 * centroid can start marginally OUTSIDE the ring, and a despawn test at the
 * entry radius would delete some flocks on their first tick.
 */
export function despawnRadiusCells(worldSize: number): number {
  return crossingRadiusCells(worldSize) + FLOCK_SPAWN_SCATTER_CELLS;
}

/** Seconds after which a flock is removed wherever it is. See the constant. */
export function flockLifetimeLimitSeconds(worldSize: number): number {
  const straightCrossing =
    (2 * crossingRadiusCells(worldSize)) / BIRD_CRUISE_SPEED_CELLS_PER_SECOND;
  return straightCrossing * FLOCK_LIFETIME_SLACK_FACTOR;
}

/** Mean position of a flock's birds. A flock always has at least one. */
export function flockCentroid(flock: Flock): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  for (const bird of flock.birds) {
    sumX += bird.x;
    sumY += bird.y;
  }
  return { x: sumX / flock.birds.length, y: sumY / flock.birds.length };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/** Uniform integer in [min, max], inclusive at both ends. */
function randomIntInclusive(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Launches one flock: an entry point drawn uniformly around the crossing ring,
 * a course aimed at a random point near the world's centre, and a scatter of
 * birds all facing that course.
 *
 * Exported so a test can put a flock in a known place instead of waiting out a
 * stochastic timer.
 */
export function spawnFlock(world: FlockWorld): Flock {
  const centre = world.worldSize / 2;
  const radius = crossingRadiusCells(world.worldSize);

  const entryAngle = Math.random() * Math.PI * 2;
  const entryX = centre + Math.cos(entryAngle) * radius;
  const entryY = centre + Math.sin(entryAngle) * radius;

  const aimSpread = world.worldSize * FLOCK_AIM_SPREAD_FRACTION;
  const aimX = centre + randomSigned(aimSpread);
  const aimY = centre + randomSigned(aimSpread);
  const courseHeading = Math.atan2(aimY - entryY, aimX - entryX);

  const birds: Bird[] = [];
  const wanted = randomIntInclusive(BIRDS_PER_FLOCK_MIN, BIRDS_PER_FLOCK_MAX);
  for (let n = 0; n < wanted; n++) {
    birds.push({
      id: allocateEntityId(),
      x: entryX + randomSigned(FLOCK_SPAWN_SCATTER_CELLS),
      y: entryY + randomSigned(FLOCK_SPAWN_SCATTER_CELLS),
      // One shared heading at birth; cohesion and noise take it from there.
      heading: courseHeading,
    });
  }

  const flock: Flock = { id: nextFlockId++, courseHeading, ageSeconds: 0, birds };
  flocks.push(flock);
  return flock;
}

/**
 * Rolls whether a flock arrives in this `dt`. Clamped at 1 for the same reason
 * the spawn hazard next door is: it guards a future retune, not today's numbers
 * (at TICK_HZ 10 the probability is 0.1/60 ≈ 0.0017).
 */
function rollFlockArrival(dt: number): boolean {
  return Math.random() < Math.min(1, dt / FLOCK_MEAN_SPAWN_INTERVAL_SECONDS);
}

// ── The tick ─────────────────────────────────────────────────────────────────

/**
 * Advances one bird by `dt`.
 *
 * Same order of authority as advanceEntity next door, minus the one thing that
 * does not exist up here:
 *
 *   1. its own wander noise;
 *   2. the course-hold, pulling it back onto the flock's line;
 *   3. its flock, pulling it toward the others and aligning it with them;
 *   4. it moves. THERE IS NO VETO — the sky has no habitat, no unlock mask and
 *      no edges, so there is nothing for a step to be illegal against. The only
 *      boundary a bird has is the end of its crossing, and that is handled by
 *      removing the whole flock, not by steering the bird.
 */
export function advanceBird(
  bird: Bird,
  flock: Flock,
  school: SchoolSummary,
  dt: number,
): void {
  const noise = randomSigned(BIRD_TURN_NOISE_RADIANS_PER_SECOND * dt);
  const wander = normalizeAngle(bird.heading + noise);
  const onCourse = turnToward(
    wander,
    flock.courseHeading,
    FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND,
    dt,
  );
  const heading = steerWithSchool(bird, school, BIRD_FLOCK_LOOSENESS, onCourse, dt);

  bird.heading = heading;
  const distance = BIRD_CRUISE_SPEED_CELLS_PER_SECOND * dt;
  bird.x += Math.cos(heading) * distance;
  bird.y += Math.sin(heading) * distance;
}

/**
 * One tick of the whole flock subsystem: arrivals, flight, departures.
 *
 * Each flock's school summary is taken BEFORE any of its birds move, exactly as
 * advanceMovement does, so a tick's steering does not depend on the order birds
 * sit in the array.
 */
export function advanceFlocks(world: FlockWorld, dt: number): void {
  const centre = world.worldSize / 2;
  const despawnRadius = despawnRadiusCells(world.worldSize);
  const lifetimeLimit = flockLifetimeLimitSeconds(world.worldSize);

  for (let i = flocks.length - 1; i >= 0; i--) {
    const flock = flocks[i];
    flock.ageSeconds += dt;

    const school = summarizeSchool(flock.birds);
    for (const bird of flock.birds) advanceBird(bird, flock, school, dt);

    const centroid = flockCentroid(flock);
    const distanceFromCentre = Math.hypot(centroid.x - centre, centroid.y - centre);
    // Departed at the far side (the ordinary case), or wedged (the guard).
    if (distanceFromCentre > despawnRadius || flock.ageSeconds > lifetimeLimit) {
      flocks.splice(i, 1);
    }
  }

  if (flocks.length >= MAX_CONCURRENT_FLOCKS) return;
  if (!rollFlockArrival(dt)) return;
  spawnFlock(world);
}

// ── Wire ─────────────────────────────────────────────────────────────────────

/**
 * The birds' contribution to the broadcast, in the same shape as every other
 * creature — so the client needs no second message type, no second parser and no
 * second interpolator, only a fifth model.
 *
 * ALTITUDE IS NOT ON THE WIRE. Every bird flies at one fixed world Y, which the
 * client already knows as a constant (client/placement.ts,
 * BIRD_FLIGHT_WORLD_Y); sending it would be a float per bird per broadcast to
 * transmit a number that never changes. Neither is wing phase: that is derived
 * from elapsed time and the entity id, client-side, like every other idle
 * animation in this plugin.
 */
export function birdStates(): WildlifeEntityState[] {
  const states: WildlifeEntityState[] = [];
  for (const flock of flocks) {
    for (const bird of flock.birds) {
      states.push({
        id: bird.id,
        species: BIRD_SPECIES,
        x: roundBroadcastPosition(bird.x),
        y: roundBroadcastPosition(bird.y),
        heading: roundBroadcastPosition(bird.heading),
        // Birds do not vary in size, so this is the default class every
        // non-fish species carries — see WILDLIFE_SIZE_MODEL_SCALE.
        size: DEFAULT_SIZE_CLASS_INDEX,
      });
    }
  }
  return states;
}
