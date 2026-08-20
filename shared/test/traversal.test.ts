import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  DEEP_WATER_MAX_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  SEA_LEVEL,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  canTraverseSegment,
  groundOf,
  isWalkableCell,
  type TerrainSampler,
  type WalkerProfile,
} from '../src/index.ts';

const LAND: WalkerProfile = { ground: 'dry', maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL };
const WATER: WalkerProfile = { ground: 'deep', maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL };

/** A world whose height is a pure function of x (uniform along y). */
function fakeWorld(heightAtX: (x: number) => number, worldSize = 40): TerrainSampler {
  return { worldSize, heightAt: (x) => heightAtX(x) };
}

describe('groundOf', () => {
  it('classifies dry / shallow / deep exhaustively and disjointly', () => {
    expect(groundOf(SEA_LEVEL + 1)).toBe('dry');
    expect(groundOf(SEA_LEVEL)).toBe('shallow');
    expect(groundOf(DEEP_WATER_MAX_HEIGHT + 1)).toBe('shallow');
    expect(groundOf(DEEP_WATER_MAX_HEIGHT)).toBe('deep');
    expect(groundOf(DEEP_WATER_MAX_HEIGHT - 1)).toBe('deep');
  });
});

describe('isWalkableCell', () => {
  it('rejects world edges and the wrong ground class', () => {
    const world = fakeWorld((x) => (x < 2 ? SEA_LEVEL - BAND_HEIGHT : 2 * BAND_HEIGHT), 40);
    expect(isWalkableCell(world, LAND, 20, 20)).toBe(true);
    expect(isWalkableCell(world, LAND, 0, 20)).toBe(false); // water, wrong ground
    expect(isWalkableCell(world, LAND, -1, 20)).toBe(false); // off-world
    expect(isWalkableCell(world, LAND, 20, 1000)).toBe(false); // off-world
  });
});

describe('canTraverseSegment (gradient-limited, segment-sampled)', () => {
  function riserWorld(riseUnits: number): TerrainSampler {
    const belowHeight = SEA_LEVEL + BAND_HEIGHT;
    return fakeWorld((x) => (x < 10 ? belowHeight : belowHeight + riseUnits));
  }

  it('rejects a riser step that exceeds the profile limit', () => {
    const world = riserWorld(LAND_WALKER_MAX_GRADIENT_PER_CELL + 1);
    expect(canTraverseSegment(world, LAND, 9.5, 5, 10.5, 5)).toBe(false);
  });

  it('accepts a ramp step at exactly the limit', () => {
    const world = riserWorld(LAND_WALKER_MAX_GRADIENT_PER_CELL);
    expect(canTraverseSegment(world, LAND, 9.5, 5, 10.5, 5)).toBe(true);
  });

  it('rejects a mid-path riser even when both endpoints share a height', () => {
    // x=0 and x=2 are the SAME height; the drop is entirely inside the
    // segment, at x=1. An endpoint-only check would miss it.
    const plateauHeight = SEA_LEVEL + BAND_HEIGHT;
    const gorgeHeight = plateauHeight - (LAND_WALKER_MAX_GRADIENT_PER_CELL + 1);
    const world = fakeWorld((x) => (x >= 1 && x < 2 ? gorgeHeight : plateauHeight));
    expect(canTraverseSegment(world, LAND, 0.5, 5, 2.5, 5)).toBe(false);
  });

  it('is unconstrained for a water-ground profile regardless of gradient', () => {
    expect(UNCONSTRAINED_GRADIENT_PER_CELL).toBe(Infinity);
    const shallowFloor = SEA_LEVEL - 10;
    const world = fakeWorld((x) => (x < 10 ? shallowFloor : shallowFloor - 100));
    expect(canTraverseSegment(world, WATER, 9.5, 5, 10.5, 5)).toBe(true);
  });
});
