// Lurking: the slow wander, the long stillnesses, and the refusal to leave the
// RANGE — the trench for the kraken, deep water for Cthulhu, snow for the yeti.
//
// The steering contract, in one sentence — the same one the wildlife plugin
// keeps, because it is the contract that makes "a monster is never outside the
// set it belongs to" true by construction: a monster only ever commits to a step
// whose DESTINATION LOOK-AHEAD is unlocked ground of ITS OWN RANGE, so
// shorelines, snow lines, trench walls and locked territory are all walls rather
// than places it can be pushed out of afterwards. The probe asks the kind's own
// regime, so the same three lines make a shore a wall to Cthulhu, a snow line a
// wall to the yeti and the seven-band contour a wall to the kraken.
//
// RANGE AND NOT HABITAT, SINCE 2026-09-02, and this file is the whole of that
// change. `MonsterProfile.habitat` is the FLOOR of a half of the heightmap —
// three bands of water, or the snow line — and every rule in this file used to
// read it. `MonsterProfile.range` (kinds.ts) is that floor narrowed by the
// kind's own `minLairReachBands`, which admission had always applied and
// movement never had: the kraken was summoned into a seven-band trench and then
// steered against three-band water, so it swam the open sea. For Cthulhu and the
// yeti the range IS the habitat — the same object, `habitatRangeOf` returns the
// regime unchanged when the demand equals the threshold — so nothing about
// either of them moved.
//
// The one case that contract does not cover is a monster that is ALREADY
// outside its range because the world changed under it and its kind cannot be
// banished for it (see isStranded below). It never MOVED there, so the contract
// is intact; what it does about it is a separate rule.
//
// NOWHERE TO GO IS ALWAYS ANSWERED BY HOLDING STILL (2026-08-26). Whether the
// habitat has left from under the animal (stranded) or merely closed in around
// it (every candidate step illegal), the answer is the same: keep the position,
// keep the noise-drifted heading, look again next tick. It used to be the same
// only for the first of those, and the second reversed by π at the tick rate —
// which is not a decision an animal makes, it is a weathervane. Nothing about
// being wedged changes between two ticks, so nothing about the response should
// either.
//
// Everything is scaled by the host's `dt`. There is no wall clock in this file.

import {
  AVOID_TURN_ATTEMPTS as SHARED_AVOID_TURN_ATTEMPTS,
  AVOID_TURN_STEP_RADIANS as SHARED_AVOID_TURN_STEP_RADIANS,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  normalizeAngle as sharedNormalizeAngle,
  steerWithShorteningProbe,
  withoutSelf,
  type Occupant,
  type TraversalProfile,
} from '@terrace/shared';
import { type LairWorld, isLairCell, isLairPose } from './habitat.ts';
import { bodyRadiusCells, profileOf, type MonsterProfile } from './kinds.ts';
import { monsterRandom, rollEvent } from './rng.ts';
import { type Monster, livingMonsters } from './summoning.ts';


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
 * them — now shared's, not this file's own copy (2026-08-20).
 *
 * The values and the reasoning are unchanged: eight × 45° sweeps the full
 * circle, so "there is a way out of this cell" and "the search found it" are
 * the same statement, and candidates alternate left and right of the current
 * heading so a shoreline reads as a slow deflection rather than a bounce. What
 * changed is where they live. This file's own comment used to end "(Wildlife's
 * steering, unchanged: this is the pattern, copied, not an import.)" — and
 * FOUR plugins said a version of that sentence about each other, which is why
 * none of them ever gained the things the pattern was missing. See
 * shared/src/steering.ts's header. Re-exported under the old names so this
 * plugin's own call sites and tests do not have to move.
 */
export const AVOID_TURN_ATTEMPTS = SHARED_AVOID_TURN_ATTEMPTS;
export const AVOID_TURN_STEP_RADIANS = SHARED_AVOID_TURN_STEP_RADIANS;

/** Normalises an angle to (-π, π]. Shared's, re-exported — see above. */
export const normalizeAngle = sharedNormalizeAngle;

/**
 * The kind's traversal rule as the STEERING probe should read it: every axis
 * of `MonsterProfile.traversal` except the gradient one.
 *
 * WHY THE GRADIENT AXIS IS DROPPED HERE, and it is a deliberate omission
 * rather than an oversight. This plugin's movement constraint has always been
 * `isLairPose` (habitat.ts) — a WHOLE-BODY rim test against the kind's own
 * habitat regime, which is a stricter and differently-shaped rule than a
 * per-cell slope limit. Letting the archetype's slope limit through as well
 * would quietly add a movement rule monsters have never had (a yeti refusing
 * a terrace riser inside his own snowfield), which is a gameplay decision
 * nobody has made. The axis this composition is FOR is freshwater: the ground
 * axes are vacuous or weaker than `isLairPose` for every shipped kind, so what
 * this actually adds to the probe is "and do not walk into a lake you cannot
 * swim" — precisely the rule that was missing.
 */
function steeringProfileOf(profile: MonsterProfile): TraversalProfile {
  return { ...profile.traversal, maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL };
}

/**
 * How far ahead this monster probes, in cells. Never less than its own body
 * radius, so the probe point is always outside the body rather than inside it.
 *
 * THIS IS A DISTANCE, NOT A CLEARANCE, and that distinction is the 2026-08-20
 * correction. This comment used to claim the floor was what stopped "the
 * model's wing tips intersecting a cliff the centre point cleared happily" — it
 * never did, and could not: pushing a single probe POINT further along the
 * heading says nothing about what is beside the animal. Forward reach and
 * lateral clearance are different questions, and a monster can be perfectly
 * clear ahead while three cells of its flank are buried in a headland. The
 * lateral half is now `isLairPose`'s job (habitat.ts); this floor keeps its
 * original, narrower value — do not probe a point inside your own body.
 */
export function lookaheadCellsFor(profile: MonsterProfile): number {
  return Math.max(
    bodyRadiusCells(profile),
    profile.lurkSpeedCellsPerSecond * LOOKAHEAD_SECONDS,
  );
}

/**
 * Picks a heading whose look-ahead POSE — the whole body, not the centre point —
 * is unlocked ground of this monster's own RANGE, preferring `desired` and
 * then the smallest deviation from it. Null when it is boxed in on all eight
 * candidates — the caller then holds position.
 *
 * `clearanceCells` is the body radius the pose must keep clear, and passing 0
 * asks the old centre-point question (see `advanceMonster` for when, and why,
 * it does exactly that).
 *
 * A LADDER OF SHORTENING PROBES SINCE 2026-08-26, not a single probe at
 * `lookahead`. This used to call shared's `steerAvoiding` directly, which asks
 * one question: is the whole body legal `lookahead` cells ahead? For the yeti
 * that is a body 4.81 cells across, centred 2.41 cells out — snow required to
 * ~4.8 cells ahead — and in a lair near YETI_MIN_LAIR_SNOW_CELLS there is
 * simply no such heading from anywhere off-centre. All eight candidates failed
 * every tick, and the blocked-path answer spun him on the spot while a legal
 * one-tick step of 0.032 cells existed in most directions: near-sighted about a
 * place he could perfectly well have walked to.
 *
 * `steerWithShorteningProbe` (shared) is the fix shared already made for fish
 * and boats on 2026-08-24 for exactly this failure — full probe, then half,
 * then one tick's travel — and this plugin was the last mover not using it.
 * Its third rung probes at `stepCells`, THE SAME DISTANCE `advanceMonster`'s
 * destination re-check judges, so a heading this returns can never be vetoed by
 * that re-check: the two cannot disagree, which is what stops the ladder from
 * granting an escape the line below revokes.
 */
export function steerToValidHeading(
  world: LairWorld,
  monster: Monster,
  desired: number,
  lookahead: number,
  clearanceCells: number,
  stepCells: number,
  occupants: readonly Occupant[] = [],
): number | null {
  const profile = profileOf(monster.kind);
  // THE RANGE, NOT THE HABITAT FLOOR (2026-09-02). This is the question "where
  // may this animal GO", and the kind's range is the one value that answers it:
  // the habitat narrowed to the kind's own depth demand (kinds.ts's `range`).
  // Reading `profile.habitat` here is the confinement bug — a kraken admitted to
  // a seven-band trench was steered against three-band water, so the open sea
  // was a legal destination. For Cthulhu and the yeti this IS `profile.habitat`,
  // the same object, so their steering is unchanged.
  const regime = profile.range;
  return steerWithShorteningProbe(world, steeringProfileOf(profile), monster, desired, lookahead, {
    stepCells,
    occupants,
    // A monster's personal space is the radius its own POSE already occupies
    // (kinds.ts's bodyRadiusCells — half the footprint), not a separate figure:
    // two bodies that may not overlap the shoreline may not overlap each other
    // either, and inventing a second number would let the two rules drift.
    selfRadiusCells: bodyRadiusCells(profile),
    // The whole-body habitat test stays this plugin's own — see
    // `steeringProfileOf` on why it is a `permits` hook rather than something
    // shared could express.
    permits: (x, y) => isLairPose(regime, world, x, y, clearanceCells),
  });
}

/**
 * The living monsters as shared's `Occupant` rows, in `livingMonsters` order.
 *
 * WHY THIS IS NOT DEAD CODE FOR A WORLD OF SINGLETONS. Each KIND has one slot,
 * but a habitat may hold more than one kind since the 2026-08-19 per-kind
 * slots — the sea carries the kraken and Cthulhu at once, both on
 * OPEN_WATER_PROFILE, both free to occupy the same water. That pair is the
 * whole subject: two seven-cell bodies converging on the same deep basin used
 * to interpenetrate, because this plugin supplied no occupant list at all.
 *
 * The residual shared's `steerAvoiding` names does not bite here: a monster
 * ambles at most 0.6 cells/second, so one tick is 0.06 cells against body radii
 * measured in whole cells — the separation floor is positive by two orders of
 * magnitude, unlike the fast, small movers wildlife steers.
 */
export function monsterOccupants(monsters: readonly Monster[]): Occupant[] {
  return monsters.map((monster) => ({
    x: monster.x,
    y: monster.y,
    radiusCells: bodyRadiusCells(profileOf(monster.kind)),
  }));
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
 * Is this monster standing somewhere that is no longer its range?
 *
 * Only ever TRUE for a kind that cannot be banished (./kinds.ts): a banishable
 * one is removed by enforceHabitat in the same tick this becomes true, so it
 * never gets a second step. For Cthulhu, whose sea a player has just drained,
 * this is the normal state of the rest of his life.
 *
 * DELIBERATELY THE CENTRE TEST, not `isLairPose`, even though steering became
 * body-aware in 2026-08-20. "Stranded" means the ANIMAL is out of its element
 * and its answer is to stop moving entirely; an arm tip lapping a shoal is not
 * that, and promoting it to strandedness would freeze a kraken solid every time
 * a player raised a sandbar within 3.5 cells of it. A pinched body is a thing
 * to swim OUT of, which is `advanceMonster`'s escape below — a beached body is
 * a thing to hold still in, which is this.
 */
export function isStranded(world: LairWorld, monster: Monster): boolean {
  // THE RANGE. "Out of its element" has to mean the same set movement is
  // confined to, or the two disagree at exactly the cells that matter: a kraken
  // standing in three-band water is inside its habitat and outside its range,
  // and if this asked the habitat it would report "not stranded" while every
  // candidate step failed — the steering ladder would run in full, every tick,
  // for the rest of its life, and land on the identical hold. Same answer, and
  // this is the cheap path to it (one lookup rather than a certain-to-fail
  // ladder), which is the reason the early exit exists at all.
  //
  // It is also the path a RESTORED monster takes: persistence.ts trusts a
  // snapshot's position, and a kraken saved mid-basin under the old rule
  // restores outside its range, is left alone by enforceHabitat (which is the
  // habitat floor, deliberately — see summoning.ts), and holds still here
  // rather than crashing or teleporting.
  return !isLairCell(profileOf(monster.kind).range, world, monster.x, monster.y);
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
 * and the blocked-path answer of the day — reverse, and try again next tick —
 * would flip his heading by π ten times a second: on a client that is a monster
 * spinning like a weathervane, which reads as a broken server rather than as a
 * stranded animal. So a stranded monster holds its position AND its heading,
 * drifting only by the turn noise, exactly as if it were idling. It costs one
 * habitat lookup per tick, and if the water ever comes back the probe succeeds
 * again on that tick and he simply swims off.
 *
 * AND IT IS NO LONGER THE ONLY CASE THAT ANSWERS THAT WAY (2026-08-26). The
 * reversal it was written against is gone: a monster that the shortening probe
 * ladder cannot find a single legal step for does the same thing this case does
 * — hold, and keep the drifted heading — because the reasoning is identical and
 * only the reason for having nowhere to go differs (the ground under it versus
 * the ground around it). This early exit is kept because it is the CHEAPER of
 * the two: one habitat lookup rather than a full ladder that is certain to fail,
 * every tick, for the rest of a stranded animal's life.
 */
export function advanceMonster(
  world: LairWorld,
  monster: Monster,
  dt: number,
  occupants: readonly Occupant[] = [],
): void {
  const profile = profileOf(monster.kind);
  advanceIdleState(monster, profile, dt);

  const noise = (monsterRandom() * 2 - 1) * profile.turnNoiseRadiansPerSecond * dt;
  const desired = normalizeAngle(monster.heading + noise);

  if (isStranded(world, monster)) {
    monster.heading = desired;
    return;
  }

  // ONE CLEARANCE DECISION PER TICK, and both probes below use it.
  //
  // Normally the body radius: the monster may only commit to a pose that keeps
  // its whole footprint in its habitat, which is what stops a 7-cell kraken
  // laying its arm crown across a headland its centre point cleared.
  //
  // ZERO WHEN THE BODY IS ALREADY PINCHED, which is the escape hatch and is not
  // optional. A monster can find itself pose-invalid without ever having moved
  // there illegally — summoned onto a region's deepest cell that happens to sit
  // in a crescent, or left there by a player raising ground just outside
  // `groundProtectionRadiusCells`. If the strict test were applied
  // unconditionally in that state, EVERY candidate heading would fail and the
  // blocked-path answer would reverse the heading ten times a second: the
  // weathervane the stranded case above exists to prevent, re-introduced by the
  // fix. So a pinched body falls back to the centre question for this tick and
  // simply swims out; the strict test resumes the moment its rim is clear.
  const bodyRadius = bodyRadiusCells(profile);
  // The range again, and it must be the same set the steering probe uses: this
  // asks "is my body already pinched", the probe asks "may my body be there",
  // and two different sets would make a kraken whose rim laps the trench wall
  // permanently pinched by one test and permanently fine by the other.
  const clearance = isLairPose(profile.range, world, monster.x, monster.y, bodyRadius)
    ? bodyRadius
    : 0;

  const lookahead = lookaheadCellsFor(profile);
  // One tick's travel — the same number the move below uses. An idling monster
  // still steers (it drifts its gaze) but does not translate; it states the
  // step it WOULD take, which is the honest answer to "how far along this
  // heading would I be", and costs nothing while no occupants are supplied.
  const stepCells = profile.lurkSpeedCellsPerSecond * dt;
  const steered = steerToValidHeading(
    world,
    monster,
    desired,
    lookahead,
    clearance,
    stepCells,
    occupants,
  );

  if (steered === null) {
    // Boxed in — and since the 2026-08-26 ladder that is a much stronger
    // statement than it used to be. `steerToValidHeading` now probes at the
    // full look-ahead, at half of it, and finally at ONE TICK'S TRAVEL, so null
    // means there is no legal cell a single step away in ANY of the eight
    // directions at the current clearance. (And a body that is already pinched
    // is steering at clearance 0, so for it this is the point sense of trapped:
    // its own cell is habitat and every neighbour a step away is not.)
    //
    // Reversal used to be the answer here and is WRONG for that state: nothing
    // about the world changes next tick, so the flip repeats at the tick rate
    // and the animal weathervanes on the spot — the yeti in a small lair, and
    // the exact failure the stranded case below the header exists to prevent.
    // Since there is nowhere to go, it does what a stranded monster does: holds
    // its position, keeps the noise-drifted heading, and tries again next tick.
    // If the ground opens up — a player sculpts, or the water returns — the
    // ladder finds a step on that tick and it simply walks off.
    monster.heading = desired;
    return;
  }

  monster.heading = steered;
  if (monster.idle) return;

  const nextX = monster.x + Math.cos(steered) * stepCells;
  const nextY = monster.y + Math.sin(steered) * stepCells;

  // BELT AND SUSPENDERS. The look-ahead validated a pose several cells away,
  // which is much further than one tick's travel; that covers the ordinary case
  // but says nothing about the cells in between, so a narrow tongue of shallows
  // (or of bare rock) crossing the path could still be stepped into. Re-checking
  // the actual destination makes the invariant "the monster is always inside its
  // habitat" true by construction rather than by trusting the probe distance.
  //
  // The SAME `clearance` the steering used, deliberately: a heading chosen by
  // the pinched-body fallback must not then be vetoed here by the strict test,
  // or the escape would be granted and immediately revoked — which is the
  // weathervane again, one line further down.
  //
  // KEPT, AND SINCE 2026-08-26 IT SHOULD BE UNREACHABLE. The ladder's third
  // rung probes at exactly `stepCells` — this destination — so any heading it
  // returns has already been judged legal at precisely the distance judged
  // here, and the two can no longer disagree. It stays as the suspenders: the
  // veto is cheap (one pose test per tick), the invariant it protects is
  // "a monster is never outside its habitat", and a future change to either
  // probe distance would otherwise re-open the gap silently. The reversal is
  // left rather than replaced by the hold above, because reaching this line at
  // all means the two distances HAVE disagreed and the heading is not one to
  // keep.
  // The range, for the reason this line exists: it is the suspenders on the
  // invariant "a monster is never outside the set it is confined to", and an
  // invariant checked against a wider set than the steering enforces is not a
  // check.
  if (!isLairPose(profile.range, world, nextX, nextY, clearance)) {
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
  const alive = livingMonsters();
  // Built ONCE, from positions as they stood at the top of the tick, and the
  // self row filtered out by identity per monster — the same snapshot
  // discipline every other mover keeps (shared/src/steering.ts's determinism
  // note), so a monster's step never depends on where it sits in this list.
  const occupants = monsterOccupants(alive);
  for (let index = 0; index < alive.length; index++) {
    advanceMonster(world, alive[index], dt, withoutSelf(occupants, occupants[index]));
  }
}
