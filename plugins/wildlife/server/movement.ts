// Movement: ambient wander, habitat-aware steering, and the reactive flee.
//
// The steering contract, in one sentence: a creature only ever commits to a step
// whose DESTINATION LOOK-AHEAD is inside its own habitat and inside unlocked
// territory, so locked chunks and the wrong terrain are impassable walls rather
// than places it can be pushed out of afterwards.
//
// Everything is scaled by the host's `dt`. There is no wall clock in this file.

import { type HabitatWorld, isValidCellFor } from './census.ts';
import { type WildlifeEntity, livingEntities } from './population.ts';
import { profileOf } from './species.ts';

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

/**
 * How far ahead this creature probes, in cells. Never less than its own body
 * length: a 5-cell whale that only looked 0.5 cells ahead would have its head in
 * open water and its tail through a cliff.
 */
export function lookaheadCellsFor(entity: WildlifeEntity): number {
  return Math.max(profileOf(entity.species).bodyLengthCells, speedOf(entity) * LOOKAHEAD_SECONDS);
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
 * Order matters: the flee timer decays first (so a creature that just calmed
 * down moves at cruise speed this very tick), then turn noise perturbs the
 * heading, then steering vetoes it against the world, then the position moves.
 * A creature that cannot find any valid heading keeps its position and reverses,
 * which un-wedges it on the next tick without ever placing it illegally.
 */
export function advanceEntity(world: HabitatWorld, entity: WildlifeEntity, dt: number): void {
  if (entity.fleeSecondsRemaining > 0) {
    entity.fleeSecondsRemaining = Math.max(0, entity.fleeSecondsRemaining - dt);
  }

  const profile = profileOf(entity.species);
  // A fleeing creature swims straight: panic suppresses idle meandering.
  const noise =
    entity.fleeSecondsRemaining > 0
      ? 0
      : (Math.random() * 2 - 1) * profile.turnNoiseRadiansPerSecond * dt;

  const desired = normalizeAngle(entity.heading + noise);
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

/** Advances every living creature. */
export function advanceMovement(world: HabitatWorld, dt: number): void {
  for (const entity of livingEntities()) advanceEntity(world, entity, dt);
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
