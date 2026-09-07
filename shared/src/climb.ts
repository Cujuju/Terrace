// Climbing — what a legged mover does when the way on is a wall.
//
// WHY IT EXISTS (owner, 2026-09-05: "peeps need to be able to climb anything …
// and I think I would even like them to be able to slowly climb sheer walls
// with maybe a fifteen percent chance of falling and dying"). Measured on the
// live world (frostwick-hollows, snapshot 990) the land a LAND_WALKER_PROFILE
// leaves connected is shattered: 35 617 separate regions over 66 255 walkable
// cells, 28 157 of them a single isolated cell, and the LARGEST reachable
// region is 4.3 % of the land and spans exactly ONE terrace band. A walker's
// gradient limit is LAND_WALKER_MAX_GRADIENT_PER_CELL (2 height units per
// cell) while relaxation leaves adjacent cells differing by up to
// MAX_STEP + RELAX_SLACK (5) and the renderer draws in steps of BAND_HEIGHT
// (16) — so 68 % of adjacent land pairs are refused outright, and a band
// change, which is every visible step in a terraced world, is EIGHT TIMES the
// limit and can never be crossed at all. That is the "they seem to always be
// confined to one layer" the owner saw.
//
// THE RULE, AND WHERE IT LIVES. A profile that carries a `climb` rule
// (traversal.ts's ClimbRule) may cross ANY rise, up or down, by climbing it
// instead of walking it: slowly, at CLIMB_SECONDS_PER_BAND, and with one roll
// of that rule's `fallChance` at the foot of the wall. Everything about how a
// climb PROGRESSES is here; everything about WHO may climb is a profile, and
// everything about what a climb COSTS a route is pathing.ts. Three files, one
// rule each, so a mover cannot be given the ability without also being priced
// for it.
//
// DESCENT IS A CLIMB TOO. A wall refused on the way up is refused on the way
// down by the same symmetric |dh| test, so a climber that could only go up
// would strand itself on the first ledge it reached. Same speed, same roll:
// letting go of a cliff face is what kills you, and that is as true downward.
//
// DETERMINISM. No `Math.random` anywhere: the fall is decided by hashing a
// caller-supplied seed (rng.ts's `hashToIndex`, the same murmur3 finalizer
// every seeded thing in this repo uses), so two servers fed the same streams
// kill the same peep on the same wall — the property plugins/pilgrims'
// simulation header already promises for everything else it does.
//
// THE BODY TRACES THE BAND'S PROFILE (owner, 2026-09-06, rejecting the
// diagonal this file used to draw: "since it's a sheer face, try to draw it to
// the profile of the band"). A climb is a VERTICAL leg against the face and a
// HORIZONTAL leg across the lip, never one diagonal through the rock corner.
// `advanceClimb`'s leg tables are that shape written down.

import { BAND_HEIGHT } from './constants.ts';
import { hashToIndex } from './rng.ts';
import {
  admitsHeight,
  exceedsWalkableGradient,
  type ClimbRule,
  type TerrainSampler,
  type TraversalProfile,
} from './traversal.ts';

/**
 * Seconds a climber spends on one BAND of wall.
 *
 * 4 — owner, 2026-09-05, picking "a brisk scramble" over an ordeal. Against
 * the shipped walk it is what makes a wall a decision rather than a shortcut:
 * a peep covers a cell of flat ground in 0.5 s (PILGRIM_WALK_SPEED_CELLS_PER_
 * SECOND, 0.5 world units/s over a CELL_WORLD_SIZE of 0.25), so one band of
 * wall costs the same time as eight cells of walking — and pathing.ts prices
 * it at exactly that, plus the risk.
 *
 * A BAND IS THE UNIT because a band is what a player sees: the terrain draws
 * quantised to band floors, so every wall in the world is a whole number of
 * these, and "four seconds a band" is a sentence about the picture rather than
 * about the height scale underneath it.
 */
export const CLIMB_SECONDS_PER_BAND = 4;

/** The same speed in the height units the sim actually moves in. */
export const CLIMB_RISE_HEIGHT_UNITS_PER_SECOND = BAND_HEIGHT / CLIMB_SECONDS_PER_BAND;

/**
 * How fast THIS climber goes up, in height units per second.
 *
 * A RATE PER CLIMBER, not one for the world (owner, 2026-09-06: "Ibex are known
 * for being incredible jumpers"). The figure above stays the default and every
 * profile that does not ask for another one keeps it exactly, so this widening
 * costs the peep and the yeti nothing; what it buys is that an animal whose
 * whole character is HOW it gets up a wall can say so in the one place the
 * climb is defined, instead of the client faking a leap over a crawl.
 *
 * ASK THIS, NEVER `CLIMB_RISE_HEIGHT_UNITS_PER_SECOND` DIRECTLY, anywhere a
 * particular climber's speed is meant — the constant is the default, not the
 * answer.
 */
export function climbRiseHeightUnitsPerSecond(rule: ClimbRule): number {
  return BAND_HEIGHT / (rule.secondsPerBand ?? CLIMB_SECONDS_PER_BAND);
}

/** Seconds this climber takes over one band — the inverse of the rate above. */
export function climbSecondsPerBand(rule: ClimbRule): number {
  return rule.secondsPerBand ?? CLIMB_SECONDS_PER_BAND;
}

/** Cells are indexed at their corner; a mover stands in the middle of one. */
export const CELL_CENTRE_OFFSET = 0.5;

/**
 * How far a climber's centre stands from the face it is holding, in cells.
 *
 * A BODY DIMENSION, AND THE ONLY THING THAT MAY BE PASSED HERE. It used to be
 * an argument, and all three callers handed it WALKER_PERSONAL_SPACE_CELLS —
 * a crowding radius of 0.68, wider than the half-cell it is subtracted from,
 * so the inset went negative and every climber hung 0.68 cells out in the air
 * instead of touching the wall (measured 2026-09-06). An argument three
 * callers get wrong the same way is the API's bug, so the argument is gone.
 *
 * 0.1 of a cell is the drawn peep's own half-depth, and a climber that is not
 * a peep says so on its rule rather than at the callsite.
 */
export const CLIMB_BODY_HALF_WIDTH_CELLS = 0.1;

/**
 * The widest half-width the inset arithmetic admits: a body at exactly this
 * stands on the shared edge, and anything wider would push the foot back out
 * of the low cell — the negative inset that put every climber in mid-air.
 */
const CLIMB_BODY_HALF_WIDTH_LIMIT_CELLS = CELL_CENTRE_OFFSET;

/**
 * This climber's half-width — the constant above unless its rule overrides it.
 *
 * CLAMPED, because the defect this replaced was a number too wide for the
 * half-cell it is taken from. A future animal that declares a body wider than a
 * cell stands on the edge rather than off the wall.
 */
export function climbBodyHalfWidthCells(rule: ClimbRule): number {
  const declared = rule.bodyHalfWidthCells ?? CLIMB_BODY_HALF_WIDTH_CELLS;
  return Math.min(Math.max(0, declared), CLIMB_BODY_HALF_WIDTH_LIMIT_CELLS);
}

/**
 * Seconds a descender spends turning its back on the drop before it goes over.
 *
 * A quarter of a band's climb: long enough to read as turning about, short
 * enough not to read as a pause. Ascents never pay it — they already face the
 * wall they walked up to.
 */
export const CLIMB_TURN_SECONDS = CLIMB_SECONDS_PER_BAND / 4;

/**
 * Seconds a climber that has let go takes to drop one band.
 *
 * HALF A SECOND, AND IT BELONGS TO NOBODY. It was written as eight times the
 * climb rate while there was only one climb rate, and that reading breaks the
 * moment a climber gets a rate of its own: a fall is gravity, so the better
 * climber must not also be the faster faller. The value is exactly what that
 * derivation produced (BAND_HEIGHT / 4 s, times eight), so nothing shipped
 * moves — only what the number MEANS does.
 *
 * It still has to read as a fall rather than a controlled descent, which is the
 * one thing it must not look like, and against the default climb it is the same
 * eight-to-one it always was.
 */
export const FALL_SECONDS_PER_BAND = 0.5;

/** How fast a climber that has let go drops, in height units per second. */
export const FALL_DROP_HEIGHT_UNITS_PER_SECOND = BAND_HEIGHT / FALL_SECONDS_PER_BAND;

/**
 * Denominator the fall roll is taken over — basis points.
 *
 * A `fallChance` is a fraction and `hashToIndex` returns an integer, so the
 * comparison needs a scale. 10 000 makes every chance the owner has asked for
 * (15 %, 5 %, 1 %) exact rather than rounded, and leaves three more decimal
 * places for any future one.
 */
export const FALL_ROLL_BASIS_POINTS = 10_000;

/**
 * Where up the wall a doomed climber lets go, as a fraction of the FACE leg.
 *
 * NOT AT THE TOP AND NOT AT THE BOTTOM. A climber that always fell from the
 * last inch would read as being pushed off the ledge, and one that fell in the
 * first inch would read as never having started; both make the fall look like
 * a bug rather than a slip. The fraction is HASHED per climb between these two
 * bounds, so consecutive falls on the same wall let go at visibly different
 * heights.
 */
export const FALL_RELEASE_MIN_FRACTION = 0.25;
export const FALL_RELEASE_MAX_FRACTION = 0.9;

/** Steps the release fraction is hashed over between the two bounds above. */
const FALL_RELEASE_STEPS = 64;

/**
 * The legs of a climb, in travel order — the band's profile, not a diagonal.
 *
 * An ascender walked up to the face, so it starts on it. A descender is
 * standing on the lip facing the drop, so it turns about and backs over the
 * edge first, and steps off the face onto open ground at the bottom.
 */
const ASCENT_LEGS = ['face', 'lip'] as const;
const DESCENT_LEGS = ['turn', 'lip', 'face', 'ground'] as const;

/** One leg of a climb. `done` is the state past the last one. */
export type ClimbLeg = (typeof ASCENT_LEGS)[number] | (typeof DESCENT_LEGS)[number] | 'done';

/**
 * One climb in progress — where the body is on the wall, and which leg it is on.
 *
 * THE FOOT BELONGS TO THE LOW CELL OF THE PAIR, always, up or down. Computing
 * it in the MOVER's cell is correct going up and buries a descender in the rock
 * column it is standing on (measured 2026-09-06: the foot landed inside the
 * high cell, so the body sank through solid rock for the whole descent and
 * appeared at the bottom).
 */
export interface ClimbState {
  /** The cell being climbed ONTO — entered only when the climb completes. */
  readonly toX: number;
  readonly toY: number;
  /** The point on the face, in the LOW cell, inset by the body's half-width. */
  readonly footX: number;
  readonly footY: number;
  /** Where the body stood when the climb began — the lip leg's start, descending. */
  readonly entryX: number;
  readonly entryY: number;
  /** The target cell's centre, where `arrived` leaves the body. */
  readonly exitX: number;
  readonly exitY: number;
  /** Stored height the climb started from and is heading for. */
  readonly fromHeight: number;
  readonly toHeight: number;
  /** The same two, sorted — the face leg runs between them and a fall lands at `lowHeight`. */
  readonly lowHeight: number;
  readonly highHeight: number;
  readonly descending: boolean;
  /** Faces the wall for the whole climb: from the low cell toward the high one. */
  readonly heading: number;
  /** The heading the mover arrived on, for a descender's turn to rotate from. */
  readonly turnFrom: number;
  /**
   * This climber's own rise, in height units per second — `climbRiseHeightUnits
   * PerSecond` of the rule that started it, resolved ONCE at the foot so a tick
   * never has to go looking for the profile again.
   */
  readonly risePerSecond: number;
  /** Seconds the two horizontal legs take, resolved with the rate above. */
  readonly lipSeconds: number;
  readonly groundSeconds: number;
  /**
   * Where the climber is right now, in stored height units. Between
   * `lowHeight` and `highHeight` while on the face; falling toward
   * `lowHeight` once a doomed climb has let go.
   */
  height: number;
  /** Index into the leg table for this direction. Past the end means arrived. */
  legIndex: number;
  /** Seconds spent on the current horizontal or turning leg. */
  legElapsed: number;
  /** Decided once, at the foot of the wall (`beginClimb`). */
  readonly doomed: boolean;
  /** The height a doomed climb lets go at. Meaningless unless `doomed`. */
  readonly releaseHeight: number;
  /** True once it has let go: the height is now dropping, not rising. */
  falling: boolean;
}

/**
 * The two things a client has to be TOLD about a mover that is off the ground.
 *
 * ONE SHAPE FOR EVERY WIRE, because there are six places a mover's climb is
 * serialised (pilgrims' three walker kinds, monsters, wildlife's population and
 * its flocks) and a field added at five of them is a bug at the sixth. Each
 * protocol still declares its own fields — this only decides what goes in them.
 *
 * `falling` IS NOT INFERRABLE FROM `climbHeight`, which is why it is here: a
 * descent is a climb whose height is also falling, at an eighth of the speed
 * (FALL_DROP_HEIGHT_UNITS_PER_SECOND), so a client watching the height alone
 * would have to guess a rate from two snapshots and would guess wrong at the
 * first tick of every fall — the same argument that put `climbHeight` on the
 * wire rather than deriving it from the ground.
 */
export interface ClimbWire {
  /** Stored height while off the ground; null for a mover standing on it. */
  readonly climbHeight: number | null;
  /** True once a doomed climber has let go. Meaningless while climbHeight is null. */
  readonly falling: boolean;
}

/** A mover on the ground — one frozen object rather than one per mover per tick. */
const NOT_CLIMBING: ClimbWire = Object.freeze({ climbHeight: null, falling: false });

/** The wire fields for a mover's climb, or the standing case. */
export function climbWireOf(climb: ClimbState | null): ClimbWire {
  if (climb === null) return NOT_CLIMBING;
  return { climbHeight: climb.height, falling: climb.falling };
}

/** What one `advanceClimb` tick did. `fallen` means the caller's mover dies. */
export type ClimbOutcome = 'climbing' | 'arrived' | 'fallen';

/**
 * The fixed geometry of one climb: which cell is low, where the face is, and
 * which way the body faces on it.
 *
 * ONE DERIVATION FOR THE TEST AND THE ACT. `approachAndClimb` needs the foot
 * before a climb exists and `beginClimb` needs it again to start one; deriving
 * it twice is how the two came to disagree about which cell the foot is in.
 */
interface ClimbGeometry {
  readonly descending: boolean;
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly lowHeight: number;
  readonly highHeight: number;
  readonly footX: number;
  readonly footY: number;
  readonly exitX: number;
  readonly exitY: number;
  /** Where the approach walks to before the climb starts. */
  readonly approachX: number;
  readonly approachY: number;
  readonly heading: number;
  readonly rule: ClimbRule;
}

function climbGeometryOf(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): ClimbGeometry | null {
  const rule = profile.climb;
  if (rule === undefined || rule === null) return null;

  const toCellX = Math.floor(toX);
  const toCellY = Math.floor(toY);
  if (toCellX < 0 || toCellY < 0 || toCellX >= world.worldSize || toCellY >= world.worldSize) {
    return null;
  }

  const toHeight = world.heightAt(toCellX, toCellY);
  // A climb reaches a cell a WALK could have reached had it not been so steep.
  // Every other reason a cell is closed to this mover still closes it.
  if (!admitsHeight(profile, toHeight)) return null;

  const fromCellX = Math.floor(fromX);
  const fromCellY = Math.floor(fromY);
  const fromHeight = world.heightAt(fromCellX, fromCellY);
  if (!exceedsWalkableGradient(profile, toHeight - fromHeight)) return null;

  const descending = toHeight < fromHeight;
  const lowCellX = descending ? toCellX : fromCellX;
  const lowCellY = descending ? toCellY : fromCellY;
  const highCellX = descending ? fromCellX : toCellX;
  const highCellY = descending ? fromCellY : toCellY;

  // The face's outward normal, from the low cell toward the high one. Axis
  // aligned in practice: callers split a diagonal into orthogonal halves.
  const normalX = highCellX - lowCellX;
  const normalY = highCellY - lowCellY;
  const inset = CELL_CENTRE_OFFSET - climbBodyHalfWidthCells(rule);

  return {
    descending,
    fromHeight,
    toHeight,
    lowHeight: descending ? toHeight : fromHeight,
    highHeight: descending ? fromHeight : toHeight,
    footX: lowCellX + CELL_CENTRE_OFFSET + normalX * inset,
    footY: lowCellY + CELL_CENTRE_OFFSET + normalY * inset,
    exitX: toCellX + CELL_CENTRE_OFFSET,
    exitY: toCellY + CELL_CENTRE_OFFSET,
    // Up: walk to the face. Down: walk to the middle of the lip you are on,
    // so the reverse mantle always covers the same distance.
    approachX: descending ? highCellX + CELL_CENTRE_OFFSET : lowCellX + CELL_CENTRE_OFFSET + normalX * inset,
    approachY: descending ? highCellY + CELL_CENTRE_OFFSET : lowCellY + CELL_CENTRE_OFFSET + normalY * inset,
    heading: Math.atan2(normalY, normalX),
    rule,
  };
}

/**
 * Starts a climb from the mover's own cell onto (toX, toY), or null if that
 * step is not a climb this profile has to make.
 *
 * NULL FOR EVERY REASON A CLIMB IS NOT THE ANSWER, and the caller treats them
 * all the same way (keep walking, or give up): the profile cannot climb, the
 * target is not ground this mover may stand on at all (water, the wrong band,
 * a river — climbing does not make a lake crossable), or the step was never
 * blocked in the first place and is simply walkable.
 *
 * "WALKABLE" IS THE CLIMBER'S OWN FIGURE, and for a climber that is every slope
 * the world can grow (traversal.ts's `walkableGradientLimit` and
 * SHEER_RISE_HEIGHT_UNITS_PER_CELL), so a band crossed over ordinary ground is
 * WALKED at walking pace and only a sculpted, sheer face is climbed — the
 * owner's rule of 2026-09-05, and the reason this file needs no rate of its own
 * for gentle rises.
 *
 * `seed` decides the fall. It must be stable for THIS climb and different for
 * the next one — a mover id mixed with the cell it is climbing onto and a
 * per-mover climb counter is the shape every caller uses; see plugins/pilgrims'
 * `climbSeedFor`.
 */
export function beginClimb(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  seed: number,
  turnFrom = 0,
): ClimbState | null {
  const geometry = climbGeometryOf(world, profile, fromX, fromY, toX, toY);
  if (geometry === null) return null;

  const rule = geometry.rule;
  // ONE ROLL PER CLIMB, whatever the wall's height — the owner's rule, and the
  // 4:1 sheer face is what guarantees there is a wall to roll against at all
  // (ClimbRule's own comment). A climb of forty bands is the same single roll as
  // a climb of four.
  const doomed = hashToIndex(seed, FALL_ROLL_BASIS_POINTS) < rule.fallChance * FALL_ROLL_BASIS_POINTS;
  // A second, independent draw off the same seed: the first decides WHETHER,
  // this one decides WHERE. `seed + 1` rather than a second seed argument
  // because hashToIndex's mix is an avalanche — consecutive seeds land far
  // apart, which is exactly the property its own comment promises.
  const releaseStep = hashToIndex(seed + 1, FALL_RELEASE_STEPS);
  const releaseFraction =
    FALL_RELEASE_MIN_FRACTION +
    ((FALL_RELEASE_MAX_FRACTION - FALL_RELEASE_MIN_FRACTION) * releaseStep) / (FALL_RELEASE_STEPS - 1);
  // Measured up the FACE, so a descender that lets go has also let go part way
  // up the wall rather than part way through its own journey.
  const releaseHeight = geometry.lowHeight + (geometry.highHeight - geometry.lowHeight) * releaseFraction;

  const secondsPerBand = climbSecondsPerBand(rule);
  const halfWidth = climbBodyHalfWidthCells(rule);
  // Coming over the lip costs exactly one band of this climber's climbing time;
  // stepping off at the bottom is the shorter half of the same cell, pro rata.
  const lipCells = CELL_CENTRE_OFFSET + halfWidth;
  const groundCells = CELL_CENTRE_OFFSET - halfWidth;

  return {
    toX: Math.floor(toX),
    toY: Math.floor(toY),
    footX: geometry.footX,
    footY: geometry.footY,
    entryX: geometry.approachX,
    entryY: geometry.approachY,
    exitX: geometry.exitX,
    exitY: geometry.exitY,
    fromHeight: geometry.fromHeight,
    toHeight: geometry.toHeight,
    lowHeight: geometry.lowHeight,
    highHeight: geometry.highHeight,
    descending: geometry.descending,
    heading: geometry.heading,
    turnFrom,
    risePerSecond: climbRiseHeightUnitsPerSecond(rule),
    lipSeconds: secondsPerBand,
    groundSeconds: lipCells <= 0 ? 0 : (secondsPerBand * groundCells) / lipCells,
    height: geometry.descending ? geometry.highHeight : geometry.lowHeight,
    legIndex: 0,
    legElapsed: 0,
    doomed,
    releaseHeight,
    falling: false,
  };
}

/** The leg table for this climb's direction. */
function legsOf(state: ClimbState): readonly ClimbLeg[] {
  return state.descending ? DESCENT_LEGS : ASCENT_LEGS;
}

/** Which leg the climb is on, or `done` once the table has run out. */
export function climbLegOf(state: ClimbState): ClimbLeg {
  return legsOf(state)[state.legIndex] ?? 'done';
}

/** Seconds a horizontal or turning leg lasts. The face leg is timed by height. */
function legSeconds(state: ClimbState, leg: ClimbLeg): number {
  if (leg === 'turn') return CLIMB_TURN_SECONDS;
  if (leg === 'lip') return state.lipSeconds;
  if (leg === 'ground') return state.groundSeconds;
  return 0;
}

/** Has the current leg run out? */
function legComplete(state: ClimbState, leg: ClimbLeg): boolean {
  if (leg === 'face') {
    return state.descending ? state.height <= state.lowHeight : state.height >= state.highHeight;
  }
  return state.legElapsed >= legSeconds(state, leg);
}

/**
 * Runs the vertical leg, and it is the ONLY leg a doomed climber lets go on:
 * the fall is letting go of a face, so a body still on the lip has nothing to
 * let go of yet.
 *
 * Returns the seconds it used.
 */
function advanceFaceLeg(state: ClimbState, seconds: number): number {
  const direction = state.descending ? -1 : 1;
  const target = state.descending ? state.lowHeight : state.highHeight;

  if (state.doomed) {
    const toRelease = (state.releaseHeight - state.height) * direction;
    // Tested BEFORE arrival: a release and a target within one tick of each
    // other must still fall, or a fast enough tick would quietly save it.
    if (toRelease >= 0) {
      const releaseSeconds = toRelease / state.risePerSecond;
      if (releaseSeconds <= seconds) {
        state.height = state.releaseHeight;
        state.falling = true;
        return releaseSeconds;
      }
    }
  }

  const remaining = (target - state.height) * direction;
  const needed = remaining / state.risePerSecond;
  if (needed <= seconds) {
    state.height = target;
    return Math.max(0, needed);
  }
  state.height += direction * state.risePerSecond * seconds;
  return seconds;
}

/** Runs a horizontal or turning leg on its own clock. Returns the seconds used. */
function advanceFlatLeg(state: ClimbState, leg: ClimbLeg, seconds: number): number {
  const total = legSeconds(state, leg);
  const remaining = total - state.legElapsed;
  const used = Math.min(remaining, seconds);
  state.legElapsed += used;
  return Math.max(0, used);
}

/**
 * Advances one climb by `dt` seconds, moving the mover.
 *
 * IT OWNS THE HORIZONTAL TOO, and that is the fix rather than a convenience
 * (owner, 2026-09-06: "I don't want a model sitting in place for 4 s as it
 * climbs only for it to pop to the next level"). Every caller used to place the
 * mover on the target cell itself, in one frame, on the tick that returned
 * 'arrived' — three plugins each writing the same teleport, and no place where
 * topping out could be written once.
 *
 * A TICK MAY SPAN A LEG BOUNDARY, so the legs run in a loop off one budget of
 * seconds: the body does not stall for the remainder of a tick at the corner.
 *
 * 'arrived' means the caller clears the state; 'fallen' means the climber is
 * back at the foot of the wall having let go, and the caller kills it. Both are
 * terminal — a caller that keeps ticking a finished climb gets the same answer
 * again rather than a moving corpse.
 */
export function advanceClimb(mover: ClimbingMover, dt: number): ClimbOutcome {
  const state = mover.climb;
  if (state === null) return 'arrived';
  let left = Math.max(0, dt);

  if (state.falling) {
    // A FALL GOES DOWN AND LANDS AT THE FOOT OF THE FACE, whichever way the
    // climb was going — which is what `lowHeight` means and why the direction
    // is no longer read off `fromHeight`.
    state.height -= FALL_DROP_HEIGHT_UNITS_PER_SECOND * left;
    if (state.height <= state.lowHeight) {
      state.height = state.lowHeight;
      placeOnWall(mover, state);
      return 'fallen';
    }
    placeOnWall(mover, state);
    return 'climbing';
  }

  const legs = legsOf(state);
  while (state.legIndex < legs.length) {
    const leg = legs[state.legIndex] as ClimbLeg;
    left -= leg === 'face' ? advanceFaceLeg(state, left) : advanceFlatLeg(state, leg, left);
    if (state.falling) break;
    if (!legComplete(state, leg)) break;
    state.legIndex += 1;
    state.legElapsed = 0;
    if (left <= 0) break;
  }

  placeOnWall(mover, state);
  return state.legIndex >= legs.length ? 'arrived' : 'climbing';
}

/**
 * Puts the mover where its own leg says it is: turning on the lip, crossing it,
 * flat against the face, or stepping off at the bottom.
 *
 * THE FACE LEG PINS x AND y. Only the height moves, and it moves at the foot —
 * which is in the LOW cell, so the body is against the wall in open air rather
 * than inside the rock.
 */
function placeOnWall(mover: ClimbingMover, state: ClimbState): void {
  switch (climbLegOf(state)) {
    case 'turn': {
      mover.x = state.entryX;
      mover.y = state.entryY;
      mover.heading = turnToward(state.turnFrom, state.heading, state.legElapsed / CLIMB_TURN_SECONDS);
      return;
    }
    case 'lip': {
      // Descending, the lip leg backs off the ledge onto the face; ascending it
      // is the mantle, carrying the body forward onto the cell it topped out on.
      const fromX = state.descending ? state.entryX : state.footX;
      const fromY = state.descending ? state.entryY : state.footY;
      const toX = state.descending ? state.footX : state.exitX;
      const toY = state.descending ? state.footY : state.exitY;
      const u = state.lipSeconds <= 0 ? 1 : Math.min(1, state.legElapsed / state.lipSeconds);
      mover.x = fromX + (toX - fromX) * u;
      mover.y = fromY + (toY - fromY) * u;
      mover.heading = state.heading;
      return;
    }
    case 'ground': {
      const u = state.groundSeconds <= 0 ? 1 : Math.min(1, state.legElapsed / state.groundSeconds);
      mover.x = state.footX + (state.exitX - state.footX) * u;
      mover.y = state.footY + (state.exitY - state.footY) * u;
      mover.heading = state.heading;
      return;
    }
    case 'face': {
      mover.x = state.footX;
      mover.y = state.footY;
      mover.heading = state.heading;
      return;
    }
    default: {
      mover.x = state.exitX;
      mover.y = state.exitY;
      mover.heading = state.heading;
    }
  }
}

/** Rotates the short way round, so turning about never spins the long way. */
function turnToward(from: number, to: number, fraction: number): number {
  const turn = Math.PI * 2;
  let delta = (to - from) % turn;
  if (delta > Math.PI) delta -= turn;
  if (delta < -Math.PI) delta += turn;
  return from + delta * Math.min(1, Math.max(0, fraction));
}

/**
 * One tick of "the way on is a wall": walk the last fraction of a cell to where
 * the climb starts, then start it. Null when stepping onto `target` is not a
 * climb for this mover at all, which is the answer almost every tick.
 *
 * WHY THE APPROACH IS HERE AND NOT LEFT TO EACH MOVER'S STEERING. Every steering
 * sweep in this repo looks for a heading that is legal to WALK, and beside a
 * wall there almost always is one — along the foot of it. Left to the sweep a
 * climber with a wall in its way simply slides sideways along the cliff for
 * ever (measured on the pilgrims sim before this existed: 200 of 200 walkers,
 * none climbing, none arriving). So the decision to climb is taken by whatever
 * knows the way on — a route, a goal bearing — and the last fraction of a cell
 * is walked STRAIGHT, unsteered: the destination is a point inside the cell the
 * mover is already standing in, which is ground it has already been certified
 * on, so there is nothing for a sweep to discover.
 *
 * WHERE IT WALKS TO DEPENDS ON THE DIRECTION. Up, that is the foot of the face.
 * Down, it is the middle of the lip the mover is already standing on, so the
 * reverse mantle always has the same width of ledge to back across.
 *
 * `seed` is `beginClimb`'s. The body's half-width is no longer an argument —
 * see CLIMB_BODY_HALF_WIDTH_CELLS for the three callers that got it wrong.
 *
 * Returns 'approaching' while it is still walking, 'climbing' the tick the
 * climb starts.
 */
export function approachAndClimb(
  world: TerrainSampler,
  profile: TraversalProfile,
  mover: ClimbingMover,
  target: { readonly x: number; readonly y: number },
  stepCells: number,
  seed: number,
): 'approaching' | 'climbing' | null {
  const geometry = climbGeometryOf(world, profile, mover.x, mover.y, target.x, target.y);
  if (geometry === null) return null;

  // An ascender faces the wall as it walks up to it. A descender keeps the
  // heading it arrived on and turns about on the lip, as its first leg.
  if (!geometry.descending) mover.heading = geometry.heading;

  const dx = geometry.approachX - mover.x;
  const dy = geometry.approachY - mover.y;
  // Math.sqrt, not Math.hypot — the determinism rule shared/src/traversal.ts
  // states at its own use of it.
  const remaining = Math.sqrt(dx * dx + dy * dy);
  if (remaining > stepCells && remaining > 0) {
    mover.x += (dx / remaining) * stepCells;
    mover.y += (dy / remaining) * stepCells;
    return 'approaching';
  }

  mover.x = geometry.approachX;
  mover.y = geometry.approachY;
  const climb = beginClimb(world, profile, mover.x, mover.y, target.x, target.y, seed, mover.heading);
  if (climb === null) return null;
  mover.climb = climb;
  return 'climbing';
}

/**
 * Would stepping onto this cell be a CLIMB for this profile — rather than a
 * walk, or something it may not do at all?
 *
 * Asked through the same geometry the act uses, so the test and the act can
 * never disagree about what a climb is.
 */
export function isClimbStep(
  world: TerrainSampler,
  profile: TraversalProfile,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  return climbGeometryOf(world, profile, fromX, fromY, toX, toY) !== null;
}

/** The mover fields climbing reads and writes — `Mover` (steering.ts) plus the wall. */
export interface ClimbingMover {
  x: number;
  y: number;
  heading: number;
  climb: ClimbState | null;
}

/**
 * The seed a climb's fall is rolled off, from the mover and the wall.
 *
 * ONE RULE FOR EVERY CLIMBER rather than one per plugin, because the property
 * it has to have is subtle enough to be worth writing down once: STABLE for a
 * given mover on a given face (so a climb cannot be re-rolled by re-entering
 * the branch that starts it) and DIFFERENT for the next one (so a mover that
 * meets the same wall twice is not fated to the same outcome). `discriminator`
 * is whatever the caller has that moves on between climbs — a mover id, a route
 * index — and mixing it in is what buys the second half.
 *
 * NO CLOCK TERM anywhere, so a replayed server kills the same mover on the same
 * face: the determinism this file's header promises.
 */
export function climbSeed(
  discriminator: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  let seed = discriminator | 0;
  seed = hashToIndex(seed ^ (fromX | 0), SEED_MIX_RANGE);
  seed = hashToIndex(seed ^ (fromY | 0), SEED_MIX_RANGE);
  seed = hashToIndex(seed ^ (toX | 0), SEED_MIX_RANGE);
  return hashToIndex(seed ^ (toY | 0), SEED_MIX_RANGE);
}

/** Modulus the seed fold runs over: the whole non-negative int32 range, so the
 *  fold keeps the mixer's spread instead of throwing most of it away. */
const SEED_MIX_RANGE = 0x7fffffff;

/**
 * Seconds a whole climb takes, foot to ledge — what pathing.ts prices a climbed
 * edge at.
 *
 * THE LEGS, ADDED UP, so a change to the motion cannot leave the route planner
 * pricing a climb that no longer exists. The face is the rise at the climber's
 * own rate; the lip is one band of that rate; a descent also turns about and
 * steps off at the bottom.
 */
export function climbSeconds(rule: ClimbRule, fromHeight: number, toHeight: number): number {
  const rise = Math.abs(toHeight - fromHeight);
  const secondsPerBand = climbSecondsPerBand(rule);
  const halfWidth = climbBodyHalfWidthCells(rule);
  const face = rise / climbRiseHeightUnitsPerSecond(rule);
  const lip = secondsPerBand;
  if (toHeight >= fromHeight) return face + lip;
  const ground = (secondsPerBand * (CELL_CENTRE_OFFSET - halfWidth)) / (CELL_CENTRE_OFFSET + halfWidth);
  return CLIMB_TURN_SECONDS + lip + face + ground;
}
