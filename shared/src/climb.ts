import { BAND_HEIGHT, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, cellsAcross } from './constants.ts';
import { hashToIndex } from './rng.ts';
import {
  admitsHeight,
  exceedsWalkableGradient,
  type ClimbRule,
  type TerrainSampler,
  type TraversalProfile,
} from './traversal.ts';

export const WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND = 0.5;

export const CLIMB_SPEED_FRACTION_OF_WALK = 1 / 2;

const BAND_WORLD_UNITS = BAND_HEIGHT * (MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT);

export const CLIMB_SECONDS_PER_BAND =
  BAND_WORLD_UNITS / (WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND * CLIMB_SPEED_FRACTION_OF_WALK);

export const CLIMB_RISE_HEIGHT_UNITS_PER_SECOND = BAND_HEIGHT / CLIMB_SECONDS_PER_BAND;

export function climbRiseHeightUnitsPerSecond(rule: ClimbRule): number {
  return BAND_HEIGHT / (rule.secondsPerBand ?? CLIMB_SECONDS_PER_BAND);
}

export function climbSecondsPerBand(rule: ClimbRule): number {
  return rule.secondsPerBand ?? CLIMB_SECONDS_PER_BAND;
}

export const CELL_CENTRE_OFFSET = 0.5;

const CLIMB_BODY_HALF_DEPTH_WORLD_UNITS = 0.125 * 0.95 * 0.85;

export const CLIMB_BODY_HALF_WIDTH_CELLS = cellsAcross(CLIMB_BODY_HALF_DEPTH_WORLD_UNITS);

const CLIMB_BODY_HALF_WIDTH_LIMIT_CELLS = CELL_CENTRE_OFFSET;

export function climbBodyHalfWidthCells(rule: ClimbRule): number {
  const declared = rule.bodyHalfWidthCells ?? CLIMB_BODY_HALF_WIDTH_CELLS;
  return Math.min(Math.max(0, declared), CLIMB_BODY_HALF_WIDTH_LIMIT_CELLS);
}

export const CLIMB_TURN_SECONDS = CLIMB_SECONDS_PER_BAND / 4;

export const FALL_SPEED_MULTIPLE_OF_WALK = 3;

export const FALL_SECONDS_PER_BAND =
  BAND_WORLD_UNITS / (WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND * FALL_SPEED_MULTIPLE_OF_WALK);

export const FALL_DROP_HEIGHT_UNITS_PER_SECOND = BAND_HEIGHT / FALL_SECONDS_PER_BAND;

export const FALL_ROLL_BASIS_POINTS = 10_000;

export const FALL_RELEASE_MIN_FRACTION = 0.25;
export const FALL_RELEASE_MAX_FRACTION = 0.9;

const FALL_RELEASE_STEPS = 64;

const ASCENT_LEGS = ['face', 'lip'] as const;
const DESCENT_LEGS = ['turn', 'lip', 'face', 'ground'] as const;

export type ClimbLeg = (typeof ASCENT_LEGS)[number] | (typeof DESCENT_LEGS)[number] | 'done';

export interface ClimbState {
  readonly toX: number;
  readonly toY: number;
  readonly footX: number;
  readonly footY: number;
  readonly entryX: number;
  readonly entryY: number;
  readonly exitX: number;
  readonly exitY: number;
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly lowHeight: number;
  readonly highHeight: number;
  readonly descending: boolean;
  readonly heading: number;
  readonly turnFrom: number;
  readonly risePerSecond: number;
  readonly lipSeconds: number;
  readonly groundSeconds: number;
  height: number;
  legIndex: number;
  legElapsed: number;
  readonly doomed: boolean;
  readonly releaseHeight: number;
  falling: boolean;
}

export interface ClimbWire {
  readonly climbHeight: number | null;
  readonly falling: boolean;
}

const NOT_CLIMBING: ClimbWire = Object.freeze({ climbHeight: null, falling: false });

export function climbWireOf(climb: ClimbState | null): ClimbWire {
  if (climb === null) return NOT_CLIMBING;
  return { climbHeight: climb.height, falling: climb.falling };
}

export type ClimbOutcome = 'climbing' | 'arrived' | 'fallen';

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
    approachX: descending ? highCellX + CELL_CENTRE_OFFSET : lowCellX + CELL_CENTRE_OFFSET + normalX * inset,
    approachY: descending ? highCellY + CELL_CENTRE_OFFSET : lowCellY + CELL_CENTRE_OFFSET + normalY * inset,
    heading: Math.atan2(normalY, normalX),
    rule,
  };
}

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
  const doomed = hashToIndex(seed, FALL_ROLL_BASIS_POINTS) < rule.fallChance * FALL_ROLL_BASIS_POINTS;
  const releaseStep = hashToIndex(seed + 1, FALL_RELEASE_STEPS);
  const releaseFraction =
    FALL_RELEASE_MIN_FRACTION +
    ((FALL_RELEASE_MAX_FRACTION - FALL_RELEASE_MIN_FRACTION) * releaseStep) / (FALL_RELEASE_STEPS - 1);
  const releaseHeight = geometry.lowHeight + (geometry.highHeight - geometry.lowHeight) * releaseFraction;

  const secondsPerBand = climbSecondsPerBand(rule);
  const halfWidth = climbBodyHalfWidthCells(rule);
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

function legsOf(state: ClimbState): readonly ClimbLeg[] {
  return state.descending ? DESCENT_LEGS : ASCENT_LEGS;
}

export function climbLegOf(state: ClimbState): ClimbLeg {
  return legsOf(state)[state.legIndex] ?? 'done';
}

function legSeconds(state: ClimbState, leg: ClimbLeg): number {
  if (leg === 'turn') return CLIMB_TURN_SECONDS;
  if (leg === 'lip') return state.lipSeconds;
  if (leg === 'ground') return state.groundSeconds;
  return 0;
}

function legComplete(state: ClimbState, leg: ClimbLeg): boolean {
  if (leg === 'face') {
    return state.descending ? state.height <= state.lowHeight : state.height >= state.highHeight;
  }
  return state.legElapsed >= legSeconds(state, leg);
}

function advanceFaceLeg(state: ClimbState, seconds: number): number {
  const direction = state.descending ? -1 : 1;
  const target = state.descending ? state.lowHeight : state.highHeight;

  if (state.doomed) {
    const toRelease = (state.releaseHeight - state.height) * direction;
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

function advanceFlatLeg(state: ClimbState, leg: ClimbLeg, seconds: number): number {
  const total = legSeconds(state, leg);
  const remaining = total - state.legElapsed;
  const used = Math.min(remaining, seconds);
  state.legElapsed += used;
  return Math.max(0, used);
}

export function advanceClimb(mover: ClimbingMover, dt: number): ClimbOutcome {
  const state = mover.climb;
  if (state === null) return 'arrived';
  let left = Math.max(0, dt);

  if (state.falling) {
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

function placeOnWall(mover: ClimbingMover, state: ClimbState): void {
  switch (climbLegOf(state)) {
    case 'turn': {
      mover.x = state.entryX;
      mover.y = state.entryY;
      mover.heading = turnToward(state.turnFrom, state.heading, state.legElapsed / CLIMB_TURN_SECONDS);
      return;
    }
    case 'lip': {
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

function turnToward(from: number, to: number, fraction: number): number {
  const turn = Math.PI * 2;
  let delta = (to - from) % turn;
  if (delta > Math.PI) delta -= turn;
  if (delta < -Math.PI) delta += turn;
  return from + delta * Math.min(1, Math.max(0, fraction));
}

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

  if (!geometry.descending) mover.heading = geometry.heading;

  const dx = geometry.approachX - mover.x;
  const dy = geometry.approachY - mover.y;
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

export interface ClimbingMover {
  x: number;
  y: number;
  heading: number;
  climb: ClimbState | null;
}

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

const SEED_MIX_RANGE = 0x7fffffff;

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
