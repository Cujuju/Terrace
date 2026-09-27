import { describe, expect, it } from 'vitest';
import { SEA_LEVEL, bandFloorHeight, bandLevelHeight, isClimbStep, newStillness } from '@terrace/shared';
import { GRAZER_MAX_LEAP_BANDS } from '../protocol.ts';
import { type HabitatWorld, canTraverse, walkerProfileOf } from '../server/census.ts';
import { advanceEntity, lookaheadCellsFor, speedOf, steerToValidHeading } from '../server/movement.ts';
import type { WildlifeEntity } from '../server/population.ts';
import { AQUATIC_MAX_GRADIENT_PER_CELL } from '../server/species.ts';

const TREAD_BAND = 1;

function fakeWorld(heightAtX: (x: number) => number, worldSize = 40): HabitatWorld {
  return {
    worldSize,
    chunksPerEdge: 1,
    heightAt: (x) => heightAtX(x),
    isChunkUnlocked: () => true,
    isCellUnlocked: () => true,
  };
}

function riserWorld(bands: number): HabitatWorld {
  return fakeWorld((x) => bandLevelHeight(x < 10 ? TREAD_BAND : TREAD_BAND + bands));
}

/** The steepest step that stays inside one drawn band. */
function inBandSlopeWorld(): HabitatWorld {
  return fakeWorld((x) => (x < 10 ? bandFloorHeight(TREAD_BAND) : bandFloorHeight(TREAD_BAND + 1) - 1));
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

describe('band-limited traversal (canTraverse)', () => {
  it('makes every drawn band change a grazer leap, never a walk, and walks any in-band step', () => {
    const riser = riserWorld(1);
    expect(canTraverse(riser, 'grazer', 9.5, 5, 10.5, 5)).toBe(false);
    expect(isClimbStep(riser, walkerProfileOf('grazer'), 9.5, 5, 10.5, 5)).toBe(true);

    expect(canTraverse(inBandSlopeWorld(), 'grazer', 9.5, 5, 10.5, 5)).toBe(true);
  });

  it('rejects a mid-path band change even when both endpoints share a band (case e)', () => {
    const world = fakeWorld((x) => bandLevelHeight(x >= 1 && x < 2 ? TREAD_BAND - 1 : TREAD_BAND));
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

describe('band veto in steering (steerToValidHeading)', () => {
  it('never steers a grazer to walk across a riser (case a)', () => {
    const world = riserWorld(1);
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

  it('lets a grazer walk straight up an in-band slope (case b), and does not constrain a fish crossing a drop (case c)', () => {
    const world = inBandSlopeWorld();
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

describe('a fleeing grazer leaps what it can and deflects from the rest (advanceEntity, case d)', () => {
  it('leaps a riser of GRAZER_MAX_LEAP_BANDS, and deflects along the terrace from one band taller', () => {
    const leapable = riserWorld(GRAZER_MAX_LEAP_BANDS);
    const leaper = grazer(9.5, 20, { heading: 0, fleeSecondsRemaining: 2 });

    advanceEntity(leapable, leaper, TICK_DT);

    expect(leaper.climb).not.toBeNull();
    expect(leaper.climb!.toX).toBe(10);

    const world = riserWorld(GRAZER_MAX_LEAP_BANDS + 1);
    const entity = grazer(9.5, 20, { heading: 0, fleeSecondsRemaining: 2 });
    const startHeight = world.heightAt(Math.floor(entity.x), 20);

    expect(entity.x + lookaheadCellsFor(entity)).toBeGreaterThan(10);

    advanceEntity(world, entity, TICK_DT);

    expect(entity.climb).toBeNull();
    expect(Math.floor(entity.x)).toBeLessThan(10);
    expect(world.heightAt(Math.floor(entity.x), Math.floor(entity.y))).toBe(startHeight);
  });
});
