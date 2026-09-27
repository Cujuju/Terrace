import { approachAndClimb, climbSeed, stepKind } from '@terrace/shared';
import { type HabitatWorld, canTraverse, isValidCellFor, walkerProfileOf } from './census.ts';
import { erodedSamplerFor, isHullPoseValid } from './hull.ts';
import type { WildlifeEntity } from './population.ts';

interface ClimbStep {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

/** First climbable step along `heading` within `lookahead`, sampled per cell like `canProceedAlong`. */
function climbStepAhead(
  world: HabitatWorld,
  entity: WildlifeEntity,
  heading: number,
  lookahead: number,
): ClimbStep | null {
  const profile = walkerProfileOf(entity.species);
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const samples = Math.max(1, Math.ceil(lookahead));
  let fromX = Math.floor(entity.x);
  let fromY = Math.floor(entity.y);
  for (let sample = 1; sample <= samples; sample++) {
    const distance = (lookahead * sample) / samples;
    const toX = Math.floor(entity.x + cos * distance);
    const toY = Math.floor(entity.y + sin * distance);
    if (toX === fromX && toY === fromY) continue;
    if (!isValidCellFor(world, entity.species, toX, toY)) return null;
    const kind = stepKind(profile, world.heightAt(fromX, fromY), world.heightAt(toX, toY));
    if (kind === 'blocked') return null;
    if (kind === 'climb') return { fromX, fromY, toX, toY };
    fromX = toX;
    fromY = toY;
  }
  return null;
}

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
  const step = climbStepAhead(world, entity, heading, lookahead);
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
