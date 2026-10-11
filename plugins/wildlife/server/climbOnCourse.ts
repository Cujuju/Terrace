import { approachAndClimb, climbSeed } from '@terrace/shared';
import { type HabitatWorld, canTraverse, climbStepAhead, walkerProfileOf } from './census.ts';
import { erodedSamplerFor, isHullPoseValid } from './hull.ts';
import type { WildlifeEntity } from './population.ts';

/**
 * Holds course for a climbable step ahead instead of steering around it: walks
 * straight to it, then climbs. False when the course holds no such step.
 */
export function climbOnCourse(
  world: HabitatWorld,
  entity: WildlifeEntity,
  heading: number,
  lookahead: number,
  stepCells: number,
): boolean {
  const step = climbStepAhead(world, entity.species, entity.x, entity.y, heading, lookahead);
  if (step === null) return false;

  if (step.fromX === Math.floor(entity.x) && step.fromY === Math.floor(entity.y)) {
    const seed = climbSeed(entity.id, step.fromX, step.fromY, step.toX, step.toY);
    const target = { x: step.toX, y: step.toY };
    return approachAndClimb(world, walkerProfileOf(entity.species), entity, target, stepCells, seed) !== null;
  }

  const nextX = entity.x + Math.cos(heading) * stepCells;
  const nextY = entity.y + Math.sin(heading) * stepCells;
  const eroded = erodedSamplerFor(world, entity.species, entity.size);
  if (
    !isHullPoseValid(world, eroded, entity.species, entity.size, nextX, nextY, heading) ||
    !canTraverse(world, entity.species, entity.x, entity.y, nextX, nextY)
  ) {
    return false;
  }
  entity.heading = heading;
  entity.x = nextX;
  entity.y = nextY;
  return true;
}
