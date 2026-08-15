// Lurking: the slow wander, the long stillnesses, and the refusal to leave the
// habitat — deep water for the sea kinds, snow for the yeti.
//
// The steering contract, in one sentence — the same one the wildlife plugin
// keeps, because it is the contract that makes "a monster is never outside its
// habitat" true by construction: a monster only ever commits to a step whose
// DESTINATION LOOK-AHEAD is unlocked ground of ITS OWN HABITAT, so shorelines,
// snow lines and locked territory are all walls rather than places it can be
// pushed out of afterwards. The probe asks the kind's own regime, so the same
// three lines make a shore a wall to Cthulhu and a snow line a wall to the yeti.
//
// The one case that contract does not cover is a monster that is ALREADY
// outside its habitat because the world changed under it and its kind cannot be
// banished for it (see isStranded below). It never MOVED there, so the contract
// is intact; what it does about it is a separate rule.
//
// Everything is scaled by the host's `dt`. There is no wall clock in this file.

import { type LairWorld, isLairCell } from './habitat.ts';
import { profileOf, type MonsterProfile } from './kinds.ts';
import { monsterRandom, rollEvent } from './rng.ts';
import { type Monster, livingMonsters } from './summoning.ts';

const TWO_PI = Math.PI * 2;

/**
 * How far ahead it checks, in seconds of its own travel. It looks at where it
 * will be in 4 seconds and refuses to go there if that is not its habitat.
 *
 * Much longer than wildlife's 0.6 s, and necessarily so: at 0.25 cells/s, 0.6 s
 * of travel is 0.15 cells — a probe well inside its own body, which would let a
 * thing 7 cells wide swim its shoulders into a cliff before noticing. Four
 * seconds is one cell of travel, and the floor below keeps the probe outside the
 * body regardless.
 */
export const LOOKAHEAD_SECONDS = 4;

/**
 * Candidate headings tried when the way ahead is blocked, and the angle between
 * them. Eight × 45° sweeps the full circle, so "there is a way out of this cell"
 * and "the search found it" are the same statement. Candidates alternate left
 * and right of the current heading, so it takes the SMALLEST turn that works and
 * a shoreline reads as a slow deflection rather than a bounce. (Wildlife's
 * steering, unchanged: this is the pattern, copied, not an import.)
 */
export const AVOID_TURN_ATTEMPTS = 8;
export const AVOID_TURN_STEP_RADIANS = Math.PI / 4;

/** Normalises an angle to (-π, π]. */
export function normalizeAngle(radians: number): number {
  const wrapped = radians % TWO_PI;
  if (wrapped > Math.PI) return wrapped - TWO_PI;
  if (wrapped <= -Math.PI) return wrapped + TWO_PI;
  return wrapped;
}

/**
 * How far ahead this monster probes, in cells. Never less than HALF ITS OWN
 * FOOTPRINT: the probe has to clear the widest part of the body, or the model's
 * wing tips intersect a cliff the centre point cleared happily.
 */
export function lookaheadCellsFor(profile: MonsterProfile): number {
  return Math.max(
    profile.footprintCells / 2,
    profile.lurkSpeedCellsPerSecond * LOOKAHEAD_SECONDS,
  );
}

/**
 * Picks a heading whose look-ahead cell is unlocked ground of this monster's own
 * habitat, preferring `desired` and then the smallest deviation from it. Null
 * when it is boxed in on all eight candidates — the caller then holds position.
 */
export function steerToValidHeading(
  world: LairWorld,
  monster: Monster,
  desired: number,
  lookahead: number,
): number | null {
  const regime = profileOf(monster.kind).habitat;
  for (let attempt = 0; attempt < AVOID_TURN_ATTEMPTS; attempt++) {
    // 0, +45°, -45°, +90°, -90°, … — smallest workable turn first.
    const step = Math.ceil(attempt / 2) * AVOID_TURN_STEP_RADIANS;
    const heading = desired + (attempt % 2 === 1 ? step : -step);
    const probeX = monster.x + Math.cos(heading) * lookahead;
    const probeY = monster.y + Math.sin(heading) * lookahead;
    if (isLairCell(regime, world, probeX, probeY)) return normalizeAngle(heading);
  }
  return null;
}

/**
 * Flips the idle beat on or off for this step.
 *
 * A two-state Poisson process (see the rates in ./kinds.ts): while moving it may
 * stall, while stalled it may resume, and both are memoryless — there is no
 * countdown to store, and no phase for a player to learn. Exposed for the test
 * that pins the two rates to the state they drive.
 */
export function advanceIdleState(monster: Monster, profile: MonsterProfile, dt: number): void {
  const rate = monster.idle ? profile.idleEndPerSecond : profile.idleOnsetPerSecond;
  if (rollEvent(rate, dt)) monster.idle = !monster.idle;
}

/**
 * Is this monster standing somewhere that is no longer its habitat?
 *
 * Only ever TRUE for a kind that cannot be banished (./kinds.ts): a banishable
 * one is removed by enforceHabitat in the same tick this becomes true, so it
 * never gets a second step. For Cthulhu, whose sea a player has just drained,
 * this is the normal state of the rest of his life.
 */
export function isStranded(world: LairWorld, monster: Monster): boolean {
  return !isLairCell(profileOf(monster.kind).habitat, world, monster.x, monster.y);
}

/**
 * Advances one monster by `dt`.
 *
 * Order matters: the idle beat resolves first (so a monster that just woke moves
 * this very tick), then turn noise perturbs the heading, then steering vetoes it
 * against the world, then the position moves.
 *
 * An idling monster still TURNS — it drifts its gaze — but does not translate.
 * That is the whole visual difference between "holding still" and "switched
 * off", and it costs one steering call.
 *
 * STRANDED IS ITS OWN CASE, and it exists because Cthulhu cannot be banished.
 * When the water around him is gone, EVERY candidate heading fails the probe,
 * and the ordinary blocked-path answer — reverse, and try again next tick —
 * would flip his heading by π ten times a second: on a client that is a monster
 * spinning like a weathervane, which reads as a broken server rather than as a
 * stranded animal. So a stranded monster holds its position AND its heading,
 * drifting only by the turn noise, exactly as if it were idling. It costs one
 * habitat lookup per tick, and if the water ever comes back the probe succeeds
 * again on that tick and he simply swims off.
 */
export function advanceMonster(world: LairWorld, monster: Monster, dt: number): void {
  const profile = profileOf(monster.kind);
  advanceIdleState(monster, profile, dt);

  const noise = (monsterRandom() * 2 - 1) * profile.turnNoiseRadiansPerSecond * dt;
  const desired = normalizeAngle(monster.heading + noise);

  if (isStranded(world, monster)) {
    monster.heading = desired;
    return;
  }

  const lookahead = lookaheadCellsFor(profile);
  const steered = steerToValidHeading(world, monster, desired, lookahead);

  if (steered === null) {
    // Boxed in on every candidate. Reverse: it is un-wedged next tick without
    // ever having been placed illegally.
    monster.heading = normalizeAngle(monster.heading + Math.PI);
    return;
  }

  monster.heading = steered;
  if (monster.idle) return;

  const distance = profile.lurkSpeedCellsPerSecond * dt;
  const nextX = monster.x + Math.cos(steered) * distance;
  const nextY = monster.y + Math.sin(steered) * distance;

  // BELT AND SUSPENDERS. The look-ahead validated a cell several cells away,
  // which is much further than one tick's travel; that covers the ordinary case
  // but says nothing about the cells in between, so a narrow tongue of shallows
  // (or of bare rock) crossing the path could still be stepped into. Re-checking
  // the actual destination makes the invariant "the monster is always inside its
  // habitat" true by construction rather than by trusting the probe distance.
  if (!isLairCell(profile.habitat, world, nextX, nextY)) {
    monster.heading = normalizeAngle(monster.heading + Math.PI);
    return;
  }

  monster.x = nextX;
  monster.y = nextY;
}

/**
 * Advances every living monster.
 *
 * Iterated over the habitat slots in fixed order (livingMonsters), so a world
 * holding both a kraken and a yeti consumes the shared random source in the same
 * order every tick — which is what keeps a seeded test reproducible.
 */
export function advanceLurking(world: LairWorld, dt: number): void {
  for (const monster of livingMonsters()) advanceMonster(world, monster, dt);
}
