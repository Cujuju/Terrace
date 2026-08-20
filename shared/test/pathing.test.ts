import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  ORTHOGONAL_STEP_COST,
  SEA_LEVEL,
  UNCONSTRAINED_GRADIENT_PER_CELL,
  findRoute,
  type RouteCell,
  type TerrainSampler,
  type WalkerProfile,
} from '../src/index.ts';

const LAND: WalkerProfile = { ground: 'dry', maxGradientPerCell: LAND_WALKER_MAX_GRADIENT_PER_CELL };
const WATER: WalkerProfile = { ground: 'deep', maxGradientPerCell: UNCONSTRAINED_GRADIENT_PER_CELL };

const BASE = SEA_LEVEL + BAND_HEIGHT; // flat "dry" ground everywhere by default.

function flatWorld(size: number, heightAt: (x: number, y: number) => number = () => BASE): TerrainSampler {
  return { worldSize: size, heightAt };
}

function has(cells: ReadonlyArray<RouteCell>, x: number, y: number): boolean {
  return cells.some((c) => c.x === x && c.y === y);
}

describe('findRoute — determinism', () => {
  it('returns a byte-identical route for the same inputs, twice', () => {
    // A wall with a single gap: exactly one legal route exists, but the
    // point is reproducibility, not uniqueness.
    const world = flatWorld(40, (x, y) => (x === 20 && y !== 10 ? SEA_LEVEL - BAND_HEIGHT : BASE));
    const start: RouteCell = { x: 5, y: 10 };
    const goal: RouteCell = { x: 35, y: 10 };
    const a = findRoute(world, LAND, start, goal);
    const b = findRoute(world, LAND, start, goal);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it('breaks a genuine tie the same way every time', () => {
    // A single-cell block sitting exactly on the straight line between start
    // and goal, with open flat ground on both sides — going around via y=9
    // costs exactly the same as going around via y=11, so the open set must
    // resolve the tie the same way every run rather than by insertion-order
    // luck.
    const world = flatWorld(40, (x, y) => (x === 20 && y === 10 ? SEA_LEVEL - BAND_HEIGHT : BASE));
    const start: RouteCell = { x: 15, y: 10 };
    const goal: RouteCell = { x: 25, y: 10 };
    const results = Array.from({ length: 5 }, () => findRoute(world, LAND, start, goal));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]).not.toBeNull();
    expect(has(results[0]!.cells, 20, 10)).toBe(false); // the block itself is never on the route
  });
});

describe('findRoute — goes around, not through', () => {
  it('routes around a wall rather than crossing it, when a gap exists', () => {
    // A north-south wall at x=20 from y=0..19 (impassable water), open from
    // y=20 down. The direct line at y=10 is blocked; the route must dip down
    // past y=20 to cross.
    const world = flatWorld(50, (x, y) => (x === 20 && y < 20 ? SEA_LEVEL - BAND_HEIGHT : BASE));
    const start: RouteCell = { x: 10, y: 10 };
    const goal: RouteCell = { x: 30, y: 10 };
    const plan = findRoute(world, LAND, start, goal);
    expect(plan).not.toBeNull();
    // Never inside the blocked stretch of the wall.
    for (const cell of plan!.cells) {
      expect(cell.x === 20 && cell.y < 20).toBe(false);
    }
    expect(has(plan!.cells, start.x, start.y)).toBe(true);
    expect(has(plan!.cells, goal.x, goal.y)).toBe(true);
  });

  it('never cuts a diagonal through a blocked corner', () => {
    // Two adjacent blocked cells forming an L at (10,10) and (11,9). A route
    // from (9,9) to (12,10) has a one-diagonal-step "shortcut" through that
    // corner; the corner-cutting guard must refuse it and detour instead.
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
    expect(plan).not.toBeNull(); // sanity: this world IS otherwise reachable
    const waterGoal = findRoute(world, WATER, { x: 5, y: 5 }, { x: 35, y: 35 });
    expect(waterGoal).toBeNull(); // no cell in this world is water-ground
  });

  it('returns null for a dry island fully enclosed by water', () => {
    // A small island around (25, 25), surrounded by a solid ring of water
    // thick enough that no gap exists at any radius.
    const world = flatWorld(60, (x, y) => {
      const d = Math.max(Math.abs(x - 25), Math.abs(y - 25)); // Chebyshev radius
      return d <= 3 || d > 8 ? BASE : SEA_LEVEL - BAND_HEIGHT; // moat between d=4..8
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
    expect(findRoute(world, LAND, start, goal, 5)).toBeNull(); // budget too small
    expect(findRoute(world, LAND, start, goal)).not.toBeNull(); // default budget succeeds
  });
});

describe('findRoute — slope cost', () => {
  it('prefers a flat detour to a steeper-but-legal shortcut', () => {
    // A "hill" straddling the direct line at y=5, x=9..13: each step up/down
    // is exactly at LAND_WALKER_MAX_GRADIENT_PER_CELL — legal, but expensive.
    // Rows y=4 and y=6 stay perfectly flat the whole way across.
    const RISE = LAND_WALKER_MAX_GRADIENT_PER_CELL;
    const world = flatWorld(40, (x, y) => {
      if (y !== 5) return BASE;
      if (x === 9 || x === 13) return BASE + RISE;
      if (x >= 10 && x <= 12) return BASE + 2 * RISE;
      return BASE;
    });
    const plan = findRoute(world, LAND, { x: 0, y: 5 }, { x: 20, y: 5 });
    expect(plan).not.toBeNull();
    // The route avoids the raised span of the hill row entirely.
    for (const cell of plan!.cells) {
      expect(cell.y === 5 && cell.x >= 9 && cell.x <= 13).toBe(false);
    }
    // Sanity: crossing the hill directly along y=5 WOULD have been legal
    // (every step is exactly at the gradient limit, never over it) and is
    // the natural minimal-length way through — so its hand-computed cost is
    // a fair "what crossing costs" figure to beat. 20 orthogonal steps, 4 of
    // which (8→9, 9→10, 12→13, 13→14) each carry one extra RISE of slope
    // cost on top of their base 10.
    const straightThroughCost = 20 * ORTHOGONAL_STEP_COST + 4 * RISE;
    expect(plan!.cost).toBeLessThan(straightThroughCost);
  });
});
