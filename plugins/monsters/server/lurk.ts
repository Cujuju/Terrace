import {
  AVOID_TURN_ATTEMPTS as SHARED_AVOID_TURN_ATTEMPTS,
  AVOID_TURN_STEP_RADIANS as SHARED_AVOID_TURN_STEP_RADIANS,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  advanceClimb,
  approachAndClimb,
  climbSeed,
  normalizeAngle as sharedNormalizeAngle,
  steerWithShorteningProbe,
  withoutSelf,
  type Occupant,
  type TraversalProfile,
  advanceStillness,
} from '@terrace/shared';
import { CELL_CENTRE_OFFSET, type LairWorld, isLairCell, isLairPose } from './habitat.ts';
import { bodyRadiusCells, profileOf, type MonsterProfile } from './kinds.ts';
import { monsterRandom, rollEvent } from './rng.ts';
import { banish, type Monster, livingMonsters } from './summoning.ts';

export const LOOKAHEAD_SECONDS = 4;

export const AVOID_TURN_ATTEMPTS = SHARED_AVOID_TURN_ATTEMPTS;
export const AVOID_TURN_STEP_RADIANS = SHARED_AVOID_TURN_STEP_RADIANS;

export const normalizeAngle = sharedNormalizeAngle;

function steeringProfileOf(profile: MonsterProfile): TraversalProfile {
  if (profile.traversal.climb !== undefined && profile.traversal.climb !== null) {
    return profile.traversal;
  }
  return { ...profile.traversal, maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL };
}

export function lookaheadCellsFor(profile: MonsterProfile): number {
  return Math.max(
    bodyRadiusCells(profile),
    profile.lurkSpeedCellsPerSecond * LOOKAHEAD_SECONDS,
  );
}

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
  const regime = profile.range;
  return steerWithShorteningProbe(world, steeringProfileOf(profile), monster, desired, lookahead, {
    stepCells,
    occupants,
    selfRadiusCells: bodyRadiusCells(profile),
    permits: (x, y) => isLairPose(regime, world, x, y, clearanceCells),
  });
}

export function monsterOccupants(monsters: readonly Monster[]): Occupant[] {
  return monsters.map((monster) => ({
    x: monster.x,
    y: monster.y,
    radiusCells: bodyRadiusCells(profileOf(monster.kind)),
  }));
}

export function advanceIdleState(monster: Monster, profile: MonsterProfile, dt: number): void {
  const rate = monster.idle ? profile.idleEndPerSecond : profile.idleOnsetPerSecond;
  if (rollEvent(rate, dt)) monster.idle = !monster.idle;
}

export function isStranded(world: LairWorld, monster: Monster): boolean {
  return !isLairCell(profileOf(monster.kind).range, world, monster.x, monster.y);
}

export function advanceMonster(
  world: LairWorld,
  monster: Monster,
  dt: number,
  occupants: readonly Occupant[] = [],
): MonsterAdvance {
  const profile = profileOf(monster.kind);

  advanceStillness(monster, dt);

  if (monster.climb !== null) {
    const outcome = advanceClimb(monster, dt);
    if (outcome === 'fallen') return 'fell';
    if (outcome === 'arrived') monster.climb = null;
    return 'moved';
  }

  advanceIdleState(monster, profile, dt);

  const noise = (monsterRandom() * 2 - 1) * profile.turnNoiseRadiansPerSecond * dt;
  const desired = normalizeAngle(monster.heading + noise);

  if (isStranded(world, monster)) {
    monster.heading = desired;
    return 'moved';
  }

  const bodyRadius = bodyRadiusCells(profile);
  const clearance = isLairPose(profile.range, world, monster.x, monster.y, bodyRadius)
    ? bodyRadius
    : 0;

  const lookahead = lookaheadCellsFor(profile);
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
    monster.heading = desired;
    if (climbOut(world, monster, desired, stepCells)) return 'moved';
    return 'moved';
  }

  monster.heading = steered;
  if (monster.idle) return 'moved';

  const nextX = monster.x + Math.cos(steered) * stepCells;
  const nextY = monster.y + Math.sin(steered) * stepCells;

  if (!isLairPose(profile.range, world, nextX, nextY, clearance)) {
    monster.heading = normalizeAngle(monster.heading + Math.PI);
    return 'moved';
  }

  monster.x = nextX;
  monster.y = nextY;
  return 'moved';
}

export type MonsterAdvance = 'moved' | 'fell';

function climbOut(world: LairWorld, monster: Monster, desired: number, stepCells: number): boolean {
  const profile = profileOf(monster.kind);
  const target = {
    x: Math.floor(monster.x) + Math.round(Math.cos(desired)),
    y: Math.floor(monster.y) + Math.round(Math.sin(desired)),
  };
  return (
    approachAndClimb(
      world,
      profile.traversal,
      monster,
      target,
      stepCells,
      climbSeedFor(monster, target),
    ) !== null
  );
}

function climbSeedFor(monster: Monster, target: { x: number; y: number }): number {
  return (
    climbSeed(monster.id, Math.floor(monster.x), Math.floor(monster.y), target.x, target.y)
  );
}

export function advanceLurking(world: LairWorld, dt: number): void {
  const alive = livingMonsters();
  const occupants = monsterOccupants(alive);
  for (let index = 0; index < alive.length; index++) {
    if (advanceMonster(world, alive[index], dt, withoutSelf(occupants, occupants[index])) === 'fell') {
      banish(alive[index]);
    }
  }
}
