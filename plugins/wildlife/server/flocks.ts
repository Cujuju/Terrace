import {
  NEIGHBOURHOOD_CELLS,
  WORLD_UNIT_CELLS,
  cellsAcross,
} from '@terrace/shared';
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

const BIRD_SPECIES: WildlifeFlockSpecies = 'bird';

export const BIRD_CRUISE_SPEED_CELLS_PER_SECOND = cellsAcross(8);

export const BIRD_TURN_NOISE_RADIANS_PER_SECOND = 0.5;

export const FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND = 1;

export const BIRD_FLOCK_LOOSENESS = 2;

import { BIRDS_PER_FLOCK_MIN, BIRDS_PER_FLOCK_MAX } from '../protocol.ts';
export { BIRDS_PER_FLOCK_MIN, BIRDS_PER_FLOCK_MAX };

import { MAX_CONCURRENT_FLOCKS } from '../protocol.ts';
export { MAX_CONCURRENT_FLOCKS };

import { MAX_BIRDS_ALOFT } from '../protocol.ts';
export { MAX_BIRDS_ALOFT };

export const FLOCK_MEAN_SPAWN_INTERVAL_SECONDS = 60;

export const FLOCK_RING_MARGIN_CELLS = NEIGHBOURHOOD_CELLS;

export const FLOCK_SPAWN_SCATTER_CELLS = cellsAcross(4);

export const FLOCK_AIM_SPREAD_FRACTION = 0.25;

export const FLOCK_LIFETIME_SLACK_FACTOR = 2;

export interface Bird {
  readonly id: number;
  x: number;
  y: number;
  heading: number;
}

export interface Flock {
  readonly id: number;
  readonly courseHeading: number;
  ageSeconds: number;
  readonly birds: Bird[];
}

export interface FlockWorld {
  readonly worldSize: number;
}

const flocks: Flock[] = [];
let nextFlockId = 1;

export function livingFlocks(): readonly Flock[] {
  return flocks;
}

export function livingBirds(): Bird[] {
  const birds: Bird[] = [];
  for (const flock of flocks) birds.push(...flock.birds);
  return birds;
}

export function resetFlocks(): void {
  flocks.length = 0;
  nextFlockId = 1;
}

export function crossingRadiusCells(worldSize: number): number {
  return worldSize * Math.SQRT1_2 + FLOCK_RING_MARGIN_CELLS;
}

export function despawnRadiusCells(worldSize: number): number {
  return crossingRadiusCells(worldSize) + FLOCK_SPAWN_SCATTER_CELLS;
}

export function flockLifetimeLimitSeconds(worldSize: number): number {
  const straightCrossing =
    (2 * crossingRadiusCells(worldSize)) / BIRD_CRUISE_SPEED_CELLS_PER_SECOND;
  return straightCrossing * FLOCK_LIFETIME_SLACK_FACTOR;
}

export function flockCentroid(flock: Flock): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  for (const bird of flock.birds) {
    sumX += bird.x;
    sumY += bird.y;
  }
  return { x: sumX / flock.birds.length, y: sumY / flock.birds.length };
}

function randomIntInclusive(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

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
      heading: courseHeading,
    });
  }

  const flock: Flock = { id: nextFlockId++, courseHeading, ageSeconds: 0, birds };
  flocks.push(flock);
  return flock;
}

function rollFlockArrival(dt: number): boolean {
  return Math.random() < Math.min(1, dt / FLOCK_MEAN_SPAWN_INTERVAL_SECONDS);
}

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
    if (distanceFromCentre > despawnRadius || flock.ageSeconds > lifetimeLimit) {
      flocks.splice(i, 1);
    }
  }

  if (flocks.length >= MAX_CONCURRENT_FLOCKS) return;
  if (!rollFlockArrival(dt)) return;
  spawnFlock(world);
}

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
        climbHeight: null,
        falling: false,
        stance: null,
        size: DEFAULT_SIZE_CLASS_INDEX,
      });
    }
  }
  return states;
}
