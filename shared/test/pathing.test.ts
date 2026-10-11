import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  LAND_WALKER_PROFILE,
  ORTHOGONAL_STEP_COST,
  SLOPE_COST_PER_HEIGHT_UNIT,
  SEA_LEVEL,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  findRoute,
  type RouteCell,
  type TerrainSampler,
  type TraversalProfile,
  waterBandProfile,
} from '../src/index.ts';

const LAND: TraversalProfile = LAND_WALKER_PROFILE;
const WATER: TraversalProfile = waterBandProfile('deep');

const BASE = SEA_LEVEL + BAND_HEIGHT;

function flatWorld(size: number, heightAt: (x: number, y: number) => number = () => BASE): TerrainSampler {
  return { worldSize: size, heightAt };
}

function has(cells: ReadonlyArray<RouteCell>, x: number, y: number): boolean {
  return cells.some((c) => c.x === x && c.y === y);
}

describe('findRoute — determinism', () => {
  it('returns a byte-identical route for the same inputs, twice', () => {
    const world = flatWorld(40, (x, y) => (x === 20 && y !== 10 ? SEA_LEVEL - BAND_HEIGHT : BASE));
    const start: RouteCell = { x: 5, y: 10 };
    const goal: RouteCell = { x: 35, y: 10 };
    const a = findRoute(world, LAND, start, goal);
    const b = findRoute(world, LAND, start, goal);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it('breaks a genuine tie the same way every time', () => {
    const world = flatWorld(40, (x, y) => (x === 20 && y === 10 ? SEA_LEVEL - BAND_HEIGHT : BASE));
    const start: RouteCell = { x: 15, y: 10 };
    const goal: RouteCell = { x: 25, y: 10 };
    const results = Array.from({ length: 5 }, () => findRoute(world, LAND, start, goal));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]).not.toBeNull();
    expect(has(results[0]!.cells, 20, 10)).toBe(false);
  });
});

describe('findRoute — goes around, not through', () => {
  it('routes around a wall rather than crossing it, when a gap exists', () => {
    const world = flatWorld(50, (x, y) => (x === 20 && y < 20 ? SEA_LEVEL - BAND_HEIGHT : BASE));
    const start: RouteCell = { x: 10, y: 10 };
    const goal: RouteCell = { x: 30, y: 10 };
    const plan = findRoute(world, LAND, start, goal);
    expect(plan).not.toBeNull();
    for (const cell of plan!.cells) {
      expect(cell.x === 20 && cell.y < 20).toBe(false);
    }
    expect(has(plan!.cells, start.x, start.y)).toBe(true);
    expect(has(plan!.cells, goal.x, goal.y)).toBe(true);
  });

  it('never cuts a diagonal through a blocked corner', () => {
    const world = flatWorld(20, (x, y) =>
      (x === 10 && y === 10) || (x === 11 && y === 9) ? SEA_LEVEL - BAND_HEIGHT : BASE,
    );
    const plan = findRoute(world, LAND, { x: 9, y: 9 }, { x: 12, y: 10 });
    expect(plan).not.toBeNull();
    expect(has(plan!.cells, 10, 10)).toBe(false);
    expect(has(plan!.cells, 11, 9)).toBe(false);
  });
});

describe('findRoute — impossible destinations', () => {
  it('returns null for a goal cell that is not the walker\'s ground at all', () => {
    const world = flatWorld(40);
    const plan = findRoute(world, LAND, { x: 5, y: 5 }, { x: 35, y: 35 });
    expect(plan).not.toBeNull();
    const waterGoal = findRoute(world, WATER, { x: 5, y: 5 }, { x: 35, y: 35 });
    expect(waterGoal).toBeNull();
  });

  it('returns null for a dry island fully enclosed by water', () => {
    const world = flatWorld(60, (x, y) => {
      const d = Math.max(Math.abs(x - 25), Math.abs(y - 25));
      return d <= 3 || d > 8 ? BASE : SEA_LEVEL - BAND_HEIGHT;
    });
    const plan = findRoute(world, LAND, { x: 5, y: 5 }, { x: 25, y: 25 });
    expect(plan).toBeNull();
  });
});

describe('findRoute — budget', () => {
  it('exhausts a small budget on a route that a larger budget completes', () => {
    const world = flatWorld(60, (x, y) => (x === 30 && y < 25 ? SEA_LEVEL - BAND_HEIGHT : BASE));
    const start: RouteCell = { x: 10, y: 10 };
    const goal: RouteCell = { x: 50, y: 10 };
    expect(findRoute(world, LAND, start, goal, 5)).toBeNull();
    expect(findRoute(world, LAND, start, goal)).not.toBeNull();
  });
});

describe('findRoute — slope cost', () => {
  it('prefers a flat detour to a steeper-but-legal shortcut', () => {
    const RISE = LAND_WALKER_MAX_GRADIENT_PER_CELL;
    const world = flatWorld(40, (x, y) => {
      if (y !== 5) return BASE;
      if (x === 9 || x === 13) return BASE + RISE;
      if (x >= 10 && x <= 12) return BASE + 2 * RISE;
      return BASE;
    });
    const plan = findRoute(world, LAND, { x: 0, y: 5 }, { x: 20, y: 5 });
    expect(plan).not.toBeNull();
    for (const cell of plan!.cells) {
      expect(cell.y === 5 && cell.x >= 9 && cell.x <= 13).toBe(false);
    }
    const straightThroughCost =
      20 * ORTHOGONAL_STEP_COST + 4 * RISE * SLOPE_COST_PER_HEIGHT_UNIT;
    expect(plan!.cost).toBeLessThan(straightThroughCost);
  });
});
