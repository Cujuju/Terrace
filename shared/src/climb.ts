// Climbing — what a legged mover does when the way on is a wall. Vertical leg
// up the face, horizontal leg across the lip, one fall roll.
// See docs/decisions/movement.md.

import { BAND_HEIGHT, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, cellsAcross } from './constants.ts';
import { hashToIndex } from './rng.ts';
import {
  admitsHeight,
  exceedsWalkableGradient,
  type ClimbRule,
  type TerrainSampler,
  type TraversalProfile,
} from './traversal.ts';

/**
 * Walking speed climbs are measured and priced against, in world units/s.
 * Restates plugins/pilgrims' PILGRIM_WALK_SPEED_CELLS_PER_SECOND: shared/ may
 * not import a plugin. See docs/decisions/movement.md.
 */
export const WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND = 0.5;

/** Default climb rate as a fraction of walking speed over the same world distance. */
export const CLIMB_SPEED_FRACTION_OF_WALK = 1 / 2;

/** One drawn band of wall, in world units. */
const BAND_WORLD_UNITS = BAND_HEIGHT * (MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT);

/** Seconds a climber spends on one band of wall. Derived; never write it by hand. */
export const CLIMB_SECONDS_PER_BAND =
  BAND_WORLD_UNITS / (WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND * CLIMB_SPEED_FRACTION_OF_WALK);

/** The same speed in the height units the sim actually moves in. */
export const CLIMB_RISE_HEIGHT_UNITS_PER_SECOND = BAND_HEIGHT / CLIMB_SECONDS_PER_BAND;

/**
 * How fast THIS climber goes up, in height units per second. Ask this, never
 * CLIMB_RISE_HEIGHT_UNITS_PER_SECOND, wherever a particular climber is meant.
 * See docs/decisions/movement.md.
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
 * Half the peep's depth along its facing axis, in world units. A number, not
 * an import: shared/ may not read client geometry. Re-measure if remodelled.
 * See docs/decisions/movement.md.
 */
const CLIMB_BODY_HALF_DEPTH_WORLD_UNITS = 0.125 * 0.95 * 0.85;

/**
 * How far a climber's centre stands from the face it holds, in cells. A body
 * dimension, never a crowding radius. See docs/decisions/movement.md.
 */
export const CLIMB_BODY_HALF_WIDTH_CELLS = cellsAcross(CLIMB_BODY_HALF_DEPTH_WORLD_UNITS);

/**
 * The widest half-width the inset arithmetic admits: a body at exactly this
 * stands on the shared edge, and anything wider hangs off the wall.
 */
const CLIMB_BODY_HALF_WIDTH_LIMIT_CELLS = CELL_CENTRE_OFFSET;

/**
 * This climber's half-width — the constant above unless its rule overrides it.
 * Clamped, so a body wider than a cell stands on the edge rather than off the
 * wall.
 */
export function climbBodyHalfWidthCells(rule: ClimbRule): number {
  const declared = rule.bodyHalfWidthCells ?? CLIMB_BODY_HALF_WIDTH_CELLS;
  return Math.min(Math.max(0, declared), CLIMB_BODY_HALF_WIDTH_LIMIT_CELLS);
}

/**
 * Seconds a descender spends turning its back on the drop before it goes over.
 * A quarter of a band's climb; ascents never pay it.
 */
export const CLIMB_TURN_SECONDS = CLIMB_SECONDS_PER_BAND / 4;

/** Gravity: every faller drops at this multiple of walking speed, whatever its climb rate. */
export const FALL_SPEED_MULTIPLE_OF_WALK = 3;

/** Seconds any faller takes to drop one band. Derived; never write it by hand. */
export const FALL_SECONDS_PER_BAND =
  BAND_WORLD_UNITS / (WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND * FALL_SPEED_MULTIPLE_OF_WALK);

/** How fast a climber that has let go drops, in height units per second. */
export const FALL_DROP_HEIGHT_UNITS_PER_SECOND = BAND_HEIGHT / FALL_SECONDS_PER_BAND;

/**
 * Denominator the fall roll is taken over — basis points. `fallChance` is a
 * fraction and `hashToIndex` returns an integer, so the comparison needs a
 * scale. See docs/decisions/movement.md.
 */
export const FALL_ROLL_BASIS_POINTS = 10_000;

/**
 * Where up the wall a doomed climber lets go, as a fraction of the FACE leg —
 * hashed between these bounds, never the top nor the bottom.
 * See docs/decisions/movement.md.
 */
export const FALL_RELEASE_MIN_FRACTION = 0.25;
export const FALL_RELEASE_MAX_FRACTION = 0.9;

/** Steps the release fraction is hashed over between the two bounds above. */
const FALL_RELEASE_STEPS = 64;

/**
 * The legs of a climb, in travel order — the band's profile, not a diagonal.
 * A descender turns about, backs over the lip, and steps off at the bottom.
 */
const ASCENT_LEGS = ['face', 'lip'] as const;
const DESCENT_LEGS = ['turn', 'lip', 'face', 'ground'] as const;

/** One leg of a climb. `done` is the state past the last one. */
export type ClimbLeg = (typeof ASCENT_LEGS)[number] | (typeof DESCENT_LEGS)[number] | 'done';

/**
 * One climb in progress — the body's place on the wall and its current leg.
 * The foot belongs to the LOW cell of the pair, up or down.
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
   * This climber's own rise, in height units per second — resolved ONCE at the
   * foot so a tick never has to go looking for the profile again.
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
 * The two things a client has to be TOLD about a mover off the ground. One
 * shape for every wire; `falling` is not inferrable from `climbHeight`.
 * See docs/decisions/movement.md.
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
 * which way it faces. One derivation for the test and the act.
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
 * Starts a climb onto (toX, toY), or null when that step is not a climb for
 * this profile. `seed` decides the fall. See docs/decisions/movement.md.
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
  // ONE ROLL PER CLIMB, whatever the wall's height: a climb of forty bands is
  // the same single roll as a climb of four.
  const doomed = hashToIndex(seed, FALL_ROLL_BASIS_POINTS) < rule.fallChance * FALL_ROLL_BASIS_POINTS;
  // A second, independent draw off the same seed: the first decides WHETHER,
  // this one WHERE. `seed + 1` works because hashToIndex's mix is an avalanche.
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
 * Runs the vertical leg, the ONLY leg a doomed climber lets go on: a body on
 * the lip has nothing to let go of. Returns the seconds used.
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
 * Advances one climb by `dt` seconds, moving the mover; it owns the horizontal
 * legs too. 'arrived' clears the state, 'fallen' kills the mover; both are
 * terminal. See docs/decisions/movement.md.
 */
export function advanceClimb(mover: ClimbingMover, dt: number): ClimbOutcome {
  const state = mover.climb;
  if (state === null) return 'arrived';
  let left = Math.max(0, dt);

  if (state.falling) {
    // A FALL LANDS AT THE FOOT OF THE FACE, whichever way the climb was going
    // — which is what `lowHeight` means.
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
 * Puts the mover where its leg says it is. The face leg pins x and y at the
 * foot, in the LOW cell — never inside the rock.
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
 * Walks the last fraction of a cell to where the climb starts, unsteered, then
 * starts it. Null when `target` is not a climb for this mover.
 * See docs/decisions/movement.md.
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
 * walk? Asked through the geometry the act uses, so test and act cannot
 * disagree.
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
 * The seed a climb's fall is rolled off: stable for a mover on a face,
 * different for the next, and with no clock term so replays agree.
 * See docs/decisions/movement.md.
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
 * Seconds a whole climb takes — what pathing.ts prices a climbed edge at. The
 * legs added up, so the planner cannot price a climb that no longer exists.
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
