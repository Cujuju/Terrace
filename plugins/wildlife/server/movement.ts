import {
  AVOID_TURN_ATTEMPTS as SHARED_AVOID_TURN_ATTEMPTS,
  AVOID_TURN_STEP_RADIANS as SHARED_AVOID_TURN_STEP_RADIANS,
  CELL_CENTRE_OFFSET,
  CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR as SHARED_CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR,
  WORLD_UNIT_CELLS,
  advanceClimb,
  approachAndClimb,
  cellsAcross,
  climbSeed,
  limitTurn as sharedLimitTurn,
  normalizeAngle as sharedNormalizeAngle,
  steerAvoiding,
  steerWithShorteningProbe,
  turnToward as sharedTurnToward,
  withoutSelf,
  type Occupant,
  advanceStillness,
} from '@terrace/shared';
import { WILDLIFE_SIZE_MODEL_SCALE, type WildlifeHabitatSpecies } from '../protocol.ts';
import { type HabitatWorld, canTraverse, isValidCellFor, walkerProfileOf } from './census.ts';
import { type WildlifeEntity, despawnWithCredit, livingEntities } from './population.ts';
import { randomSigned, rollEvent } from './rng.ts';
import {
  FLEE_SPEED_MULTIPLIER,
  SCHOOL_LOOSENESS_BY_SIZE,
  SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS,
  TURN_RADIUS_BODY_LENGTHS,
  profileOf,
} from './species.ts';

export const LOOKAHEAD_SECONDS = 0.6;

export const AVOID_TURN_ATTEMPTS = SHARED_AVOID_TURN_ATTEMPTS;
export const AVOID_TURN_STEP_RADIANS = SHARED_AVOID_TURN_STEP_RADIANS;

export const CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR = SHARED_CONTOUR_FALLBACK_LOOKAHEAD_DIVISOR;

export { TURN_RADIUS_BODY_LENGTHS };

export { FLEE_SPEED_MULTIPLIER };
export const FLEE_DURATION_SECONDS = 2.5;

export const PURSUIT_LOSE_RADIUS_SLACK = 1.5;

export const SCHOOL_COMFORT_RADIUS_CELLS = cellsAcross(2.5);

export const SCHOOL_FULL_PULL_RADIUS_CELLS = cellsAcross(5);

export const SCHOOL_MAX_PULL_RADIANS_PER_SECOND = 3;

export const SCHOOL_ALIGNMENT_RADIANS_PER_SECOND = 0.6;

export const SCHOOL_MIN_HEADING_COHERENCE = 0.1;

export const normalizeAngle = sharedNormalizeAngle;

export function speedOf(entity: WildlifeEntity): number {
  const profile = profileOf(entity.species);
  const cruise = profile.cruiseSpeedCellsPerSecond;
  if (entity.fleeSecondsRemaining > 0) return cruise * FLEE_SPEED_MULTIPLIER;
  const pursuit = profile.hunts?.pursuit;
  if (pursuit !== undefined && entity.huntTargetId !== null) return cruise * pursuit.speedMultiplier;
  return cruise;
}

export function schoolLoosenessOf(entity: WildlifeEntity): number {
  const species = profileOf(entity.species).bodyLengthCells
    / SCHOOL_SPACING_BASELINE_BODY_LENGTH_CELLS;
  return SCHOOL_LOOSENESS_BY_SIZE[entity.size] * species;
}

export function bodyLengthCellsOf(entity: WildlifeEntity): number {
  return profileOf(entity.species).bodyLengthCells * WILDLIFE_SIZE_MODEL_SCALE[entity.size];
}

export function personalSpaceCellsOf(entity: WildlifeEntity): number {
  return bodyLengthCellsOf(entity) / 2;
}

export function maxTurnRadiansPerSecondOf(entity: WildlifeEntity): number {
  const radiusBodyLengths = profileOf(entity.species).turnRadiusBodyLengths;
  return speedOf(entity) / (radiusBodyLengths * bodyLengthCellsOf(entity));
}

export function creatureOccupants(entities: Iterable<WildlifeEntity>): Occupant[] {
  const rows: Occupant[] = [];
  for (const entity of entities) {
    rows.push({ x: entity.x, y: entity.y, radiusCells: personalSpaceCellsOf(entity) });
  }
  return rows;
}

export function lookaheadCellsFor(entity: WildlifeEntity): number {
  return Math.max(bodyLengthCellsOf(entity), speedOf(entity) * LOOKAHEAD_SECONDS);
}

export interface SchoolMember {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

export interface SchoolSummary {
  readonly count: number;
  readonly sumX: number;
  readonly sumY: number;
  readonly sumCos: number;
  readonly sumSin: number;
}

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

export function cohesionPullRadiansPerSecond(distanceCells: number, looseness: number): number {
  const comfort = SCHOOL_COMFORT_RADIUS_CELLS * looseness;
  if (distanceCells <= comfort) return 0;

  const full = SCHOOL_FULL_PULL_RADIUS_CELLS * looseness;
  const ramp = Math.min(1, (distanceCells - comfort) / (full - comfort));
  return (ramp * SCHOOL_MAX_PULL_RADIANS_PER_SECOND) / looseness;
}

export const limitTurn = sharedLimitTurn;

export const turnToward = sharedTurnToward;

export function steerWithSchool(
  member: SchoolMember,
  school: SchoolSummary,
  looseness: number,
  wanderHeading: number,
  dt: number,
): number {
  const others = school.count - 1;
  if (others < 1) return wanderHeading;

  let heading = wanderHeading;

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

function steerThisTick(
  world: HabitatWorld,
  entity: WildlifeEntity,
  desired: number,
  lookahead: number,
  stepCells: number,
  occupants: readonly Occupant[],
): number | null {
  return steerWithShorteningProbe(
    world,
    walkerProfileOf(entity.species),
    entity,
    desired,
    lookahead,
    {
      stepCells,
      occupants,
      selfRadiusCells: personalSpaceCellsOf(entity),
      permits: (x, y) => isValidCellFor(world, entity.species, x, y),
    },
  );
}

export function advanceIdleState(entity: WildlifeEntity, dt: number): void {
  if (entity.fleeSecondsRemaining > 0 || entity.huntTargetId !== null) {
    entity.idle = false;
    return;
  }
  const idle = profileOf(entity.species).idle;
  if (idle === undefined) return;
  const rate = entity.idle ? idle.endPerSecond : idle.onsetPerSecond;
  if (rollEvent(rate, dt)) entity.idle = !entity.idle;
}

export type EntityAdvance = 'alive' | 'fell';

export function advanceEntity(
  world: HabitatWorld,
  entity: WildlifeEntity,
  dt: number,
  school?: SchoolSummary,
  occupants: readonly Occupant[] = [],
  pursuitTarget?: PursuitTarget,
): EntityAdvance {
  advanceStillness(entity, dt);

  if (entity.fleeSecondsRemaining > 0) {
    entity.fleeSecondsRemaining = Math.max(0, entity.fleeSecondsRemaining - dt);
  }

  const profile = profileOf(entity.species);

  if (entity.climb !== null) {
    const outcome = advanceClimb(entity, dt);
    if (outcome === 'fallen') return 'fell';
    if (outcome === 'arrived') entity.climb = null;
    return 'alive';
  }

  const fleeing = entity.fleeSecondsRemaining > 0;

  advanceIdleState(entity, dt);
  if (entity.idle) return 'alive';

  const chase =
    pursuitTarget === undefined
      ? null
      : bearingTo(entity, pursuitTarget.x, pursuitTarget.y);

  const noise =
    fleeing || chase !== null ? 0 : randomSigned(profile.turnNoiseRadiansPerSecond * dt);

  const wander = normalizeAngle(entity.heading + noise);
  const desired =
    chase !== null
      ? chase
      : fleeing || school === undefined
        ? wander
        : steerWithSchool(entity, school, schoolLoosenessOf(entity), wander, dt);
  const lookahead = lookaheadCellsFor(entity);
  const stepCells = speedOf(entity) * dt;
  const turnRate = maxTurnRadiansPerSecondOf(entity);
  const wanted = steerThisTick(world, entity, desired, lookahead, stepCells, occupants);

  if (wanted === null) {
    return 'alive';
  }

  let steered = turnToward(entity.heading, wanted, turnRate, dt);

  let nextX = entity.x + Math.cos(steered) * stepCells;
  let nextY = entity.y + Math.sin(steered) * stepCells;

  if (
    !isValidCellFor(world, entity.species, nextX, nextY) ||
    !canTraverse(world, entity.species, entity.x, entity.y, nextX, nextY)
  ) {
    const retry = steerThisTick(world, entity, entity.heading, lookahead, stepCells, occupants);
    if (retry === null) {
      climbOut(world, entity, stepCells);
      return 'alive';
    }

    steered = turnToward(entity.heading, retry, turnRate, dt);
    nextX = entity.x + Math.cos(steered) * stepCells;
    nextY = entity.y + Math.sin(steered) * stepCells;
    if (
      !isValidCellFor(world, entity.species, nextX, nextY) ||
      !canTraverse(world, entity.species, entity.x, entity.y, nextX, nextY)
    ) {
      entity.heading = steered;
      return 'alive';
    }
  }

  entity.heading = steered;
  entity.x = nextX;
  entity.y = nextY;
  return 'alive';
}

function climbOut(world: HabitatWorld, entity: WildlifeEntity, stepCells: number): boolean {
  const target = {
    x: Math.floor(entity.x) + Math.round(Math.cos(entity.heading)),
    y: Math.floor(entity.y) + Math.round(Math.sin(entity.heading)),
  };
  if (!isValidCellFor(world, entity.species, target.x + CELL_CENTRE_OFFSET, target.y + CELL_CENTRE_OFFSET)) {
    return false;
  }
  return (
    approachAndClimb(
      world,
      walkerProfileOf(entity.species),
      entity,
      target,
      stepCells,
      climbSeed(entity.id, Math.floor(entity.x), Math.floor(entity.y), target.x, target.y),
    ) !== null
  );
}

export function advanceMovement(world: HabitatWorld, dt: number): void {
  const population = livingEntities();
  const fallen: number[] = [];
  const schools = summarizeSchools(population);
  const occupants = creatureOccupants(population);
  const pursuits = resolvePursuits(population, dt);
  for (let index = 0; index < population.length; index++) {
    const entity = population[index];
    const pursuit = pursuits.get(entity.id);
    const advance = advanceEntity(
      world,
      entity,
      dt,
      schools.get(entity.schoolId),
      huntingOccupants(population, occupants, index, pursuit),
      pursuit,
    );
    if (advance === 'fell') fallen.push(entity.id);
  }

  for (let i = population.length - 1; i >= 0; i--) {
    if (fallen.includes(population[i]!.id)) despawnWithCredit(i);
  }

  applyPredatorAlarms();
  resolveCatches();
}

function applyPredatorAlarms(): void {
  for (const hunter of livingEntities()) {
    const hunts = profileOf(hunter.species).hunts;
    if (hunts === undefined) continue;
    startleNear(hunter.x, hunter.y, hunts.alarmRadiusCells, { species: hunts.preySpecies });
  }
}

export interface PursuitTarget {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

function huntingOccupants(
  population: readonly WildlifeEntity[],
  occupants: readonly Occupant[],
  index: number,
  pursuit: PursuitTarget | undefined,
): readonly Occupant[] {
  const others = withoutSelf(occupants, occupants[index]);
  if (pursuit === undefined) return others;
  const targetIndex = population.findIndex((candidate) => candidate.id === pursuit.id);
  return targetIndex < 0 ? others : withoutSelf(others, occupants[targetIndex]);
}

function bearingTo(entity: WildlifeEntity, x: number, y: number): number {
  const dx = x - entity.x;
  const dy = y - entity.y;
  return dx === 0 && dy === 0 ? entity.heading : Math.atan2(dy, dx);
}

function nearestPrey(
  population: readonly WildlifeEntity[],
  hunter: WildlifeEntity,
  preySpecies: readonly WildlifeHabitatSpecies[],
  radius: number,
): WildlifeEntity | null {
  const radiusSquared = radius * radius;
  let best: WildlifeEntity | null = null;
  let bestSquared = 0;
  for (const candidate of population) {
    if (!preySpecies.includes(candidate.species)) continue;
    const dx = candidate.x - hunter.x;
    const dy = candidate.y - hunter.y;
    const squared = dx * dx + dy * dy;
    if (squared > radiusSquared) continue;
    if (best !== null && (squared > bestSquared || (squared === bestSquared && candidate.id > best.id))) {
      continue;
    }
    best = candidate;
    bestSquared = squared;
  }
  return best;
}

function resolvePursuits(
  population: readonly WildlifeEntity[],
  dt: number,
): Map<number, PursuitTarget> {
  const targets = new Map<number, PursuitTarget>();

  for (const hunter of population) {
    const hunts = profileOf(hunter.species).hunts;
    const pursuit = hunts?.pursuit;
    if (hunts === undefined || pursuit === undefined) continue;

    if (hunter.huntRestSecondsRemaining > 0) {
      hunter.huntRestSecondsRemaining = Math.max(0, hunter.huntRestSecondsRemaining - dt);
    }

    if (hunter.fleeSecondsRemaining > 0) {
      hunter.huntTargetId = null;
      hunter.huntSecondsRemaining = 0;
      continue;
    }

    if (hunter.huntTargetId !== null) {
      hunter.huntSecondsRemaining = Math.max(0, hunter.huntSecondsRemaining - dt);
      const target = population.find((candidate) => candidate.id === hunter.huntTargetId);
      const loseRadius = pursuit.detectRadiusCells * PURSUIT_LOSE_RADIUS_SLACK;
      if (target !== undefined && hunter.huntSecondsRemaining > 0) {
        const dx = target.x - hunter.x;
        const dy = target.y - hunter.y;
        if (dx * dx + dy * dy <= loseRadius * loseRadius) {
          targets.set(hunter.id, { id: target.id, x: target.x, y: target.y });
          continue;
        }
      }
      hunter.huntTargetId = null;
      hunter.huntSecondsRemaining = 0;
      hunter.huntRestSecondsRemaining = pursuit.restAfterMissSeconds;
      continue;
    }

    if (hunter.huntRestSecondsRemaining > 0) continue;
    const prey = nearestPrey(population, hunter, hunts.preySpecies, pursuit.detectRadiusCells);
    if (prey === null) continue;
    hunter.huntTargetId = prey.id;
    hunter.huntSecondsRemaining = pursuit.maxSeconds;
    targets.set(hunter.id, { id: prey.id, x: prey.x, y: prey.y });
  }

  return targets;
}

function resolveCatches(): void {
  const population = livingEntities();
  for (const hunter of population) {
    if (hunter.huntTargetId === null) continue;
    const pursuit = profileOf(hunter.species).hunts?.pursuit;
    if (pursuit === undefined) continue;
    const target = population.find((candidate) => candidate.id === hunter.huntTargetId);
    if (target === undefined) continue;
    const dx = target.x - hunter.x;
    const dy = target.y - hunter.y;
    if (dx * dx + dy * dy > pursuit.catchRadiusCells * pursuit.catchRadiusCells) continue;
    hunter.huntTargetId = null;
    hunter.huntSecondsRemaining = 0;
    hunter.huntRestSecondsRemaining = pursuit.restAfterCatchSeconds;
  }
}

export interface StartleOptions {
  readonly species?: readonly WildlifeHabitatSpecies[];
}

export function startleNear(
  centerX: number,
  centerY: number,
  radius: number,
  options: StartleOptions = {},
): number {
  const radiusSquared = radius * radius;
  const only = options.species;
  const population = livingEntities();

  const reached = new Set<number>();
  const herds = new Set<number>();
  for (const entity of population) {
    if (only !== undefined && !only.includes(entity.species)) continue;
    const dx = entity.x - centerX;
    const dy = entity.y - centerY;
    if (dx * dx + dy * dy > radiusSquared) continue;
    reached.add(entity.id);
    if (profileOf(entity.species).groupStartle) herds.add(entity.schoolId);
  }

  let startled = 0;
  for (const entity of population) {
    if (only !== undefined && !only.includes(entity.species)) continue;
    if (!reached.has(entity.id) && !herds.has(entity.schoolId)) continue;

    const dx = entity.x - centerX;
    const dy = entity.y - centerY;
    if (dx !== 0 || dy !== 0) entity.heading = Math.atan2(dy, dx);
    entity.fleeSecondsRemaining = Math.max(entity.fleeSecondsRemaining, FLEE_DURATION_SECONDS);
    entity.idle = false;
    startled++;
  }
  return startled;
}

export function panicIndividuals(ids: readonly number[], seconds: number): number {
  if (seconds <= 0) return 0;

  let panicked = 0;
  for (const entity of livingEntities()) {
    if (!ids.includes(entity.id)) continue;
    entity.fleeSecondsRemaining = Math.max(entity.fleeSecondsRemaining, seconds);
    panicked++;
  }
  return panicked;
}

export function isFleeing(entity: WildlifeEntity): boolean {
  return entity.fleeSecondsRemaining > 0;
}
