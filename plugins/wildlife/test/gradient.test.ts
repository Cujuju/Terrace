import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, SEA_LEVEL, newStillness } from '@terrace/shared';
import { type HabitatWorld, canTraverse } from '../server/census.ts';
import { advanceEntity, lookaheadCellsFor, speedOf, steerToValidHeading } from '../server/movement.ts';
import type { WildlifeEntity } from '../server/population.ts';
import { AQUATIC_MAX_GRADIENT_PER_CELL, GRAZER_MAX_GRADIENT_PER_CELL } from '../server/species.ts';

function fakeWorld(heightAtX: (x: number) => number, worldSize = 40): HabitatWorld {
  return {
    worldSize,
    chunksPerEdge: 1,
    heightAt: (x) => heightAtX(x),
    isChunkUnlocked: () => true,
    isCellUnlocked: () => true,
  };
}

function riserWorld(riseUnits: number): HabitatWorld {
  const belowHeight = SEA_LEVEL + BAND_HEIGHT;
  return fakeWorld((x) => (x < 10 ? belowHeight : belowHeight + riseUnits));
}

function grazer(x: number, y: number, overrides: Partial<WildlifeEntity> = {}): WildlifeEntity {
  return {
    ...newStillness(x, y),
    id: 1,
    species: 'grazer',
    schoolId: 1,
    size: 'medium',
    idle: false,
    huntTargetId: null,
    huntSecondsRemaining: 0,
    huntRestSecondsRemaining: 0,
    climb: null,
    x,
    y,
    heading: 0,
    fleeSecondsRemaining: 0,
    ...overrides,
  };
}

describe('gradient-limited traversal (canTraverse)', () => {
  it('rejects a grazer riser step that exceeds GRAZER_MAX_GRADIENT_PER_CELL, and accepts one at exactly the limit', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL + 1);
    expect(canTraverse(world, 'grazer', 9.5, 5, 10.5, 5)).toBe(false);

    const ramp = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL);
    expect(canTraverse(ramp, 'grazer', 9.5, 5, 10.5, 5)).toBe(true);
  });

  it('rejects a mid-path riser even when both endpoints share a height (case e)', () => {
    const plateauHeight = SEA_LEVEL + BAND_HEIGHT;
    const gorgeHeight = plateauHeight - (GRAZER_MAX_GRADIENT_PER_CELL + 1);
    const world = fakeWorld((x) => (x >= 1 && x < 2 ? gorgeHeight : plateauHeight));
    expect(canTraverse(world, 'grazer', 0.5, 5, 2.5, 5)).toBe(false);
  });

  it('is unconstrained for aquatic species regardless of gradient', () => {
    expect(AQUATIC_MAX_GRADIENT_PER_CELL).toBe(Infinity);
    const shallowFloor = SEA_LEVEL - 10;
    const world = fakeWorld((x) => (x < 10 ? shallowFloor : shallowFloor - 100));
    expect(canTraverse(world, 'fish', 9.5, 5, 10.5, 5)).toBe(true);
    expect(canTraverse(world, 'whale', 9.5, 5, 10.5, 5)).toBe(true);
  });
});

const TICK_DT = 0.1;

describe('gradient veto in steering (steerToValidHeading)', () => {
  it('turns a grazer along the terrace instead of crossing a riser (case a)', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL + 1);
    const entity = grazer(9.5, 20);
    const lookahead = 2;
    const heading = steerToValidHeading(
      world,
      entity,
      0 ,
      lookahead,
      speedOf(entity) * TICK_DT,
    );

    expect(heading).not.toBeNull();
    expect(Math.abs(Math.cos(heading!))).toBeLessThan(1e-9);
  });

  it('lets a grazer cross a gentle ramp under the limit (case b), and does not constrain a fish crossing the same-shaped terrain (case c)', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL - 1);
    const entity = grazer(9.5, 20);
    const heading = steerToValidHeading(world, entity, 0, 2, speedOf(entity) * TICK_DT);

    expect(heading).not.toBeNull();
    expect(heading).toBeCloseTo(0, 9);

    const shallowFloor = SEA_LEVEL - 10;
    const seaWorld = fakeWorld((x) => (x < 10 ? shallowFloor : shallowFloor - 100));
    const fish: WildlifeEntity = {
      ...newStillness(0, 0),
      id: 2,
      species: 'fish',
      schoolId: 1,
      size: 'small',
      idle: false,
      huntTargetId: null,
      huntSecondsRemaining: 0,
      huntRestSecondsRemaining: 0,
      climb: null,
      x: 9.5,
      y: 20,
      heading: 0,
      fleeSecondsRemaining: 0,
    };
    const fishHeading = steerToValidHeading(seaWorld, fish, 0, 2, speedOf(fish) * TICK_DT);
    expect(fishHeading).toBeCloseTo(0, 9);
  });
});

describe('flee still respects the gradient veto (advanceEntity, case d)', () => {
  it('a panicking grazer deflects along the terrace instead of bolting up the riser', () => {
    const world = riserWorld(GRAZER_MAX_GRADIENT_PER_CELL + 1);
    const entity = grazer(9.5, 20, { heading: 0, fleeSecondsRemaining: 2 });
    const startX = entity.x;
    const startHeight = world.heightAt(Math.floor(startX), 20);

    expect(entity.x + lookaheadCellsFor(entity)).toBeGreaterThan(10);

    advanceEntity(world, entity, 0.1);

    expect(Math.floor(entity.x)).toBeLessThan(10);
    expect(world.heightAt(Math.floor(entity.x), Math.floor(entity.y))).toBe(startHeight);
  });
});
