import { describe, expect, it } from 'vitest';
import {
  AMPHIBIOUS_WALKER_PROFILE, LAND_WALKER_PROFILE, OPEN_WATER_PROFILE,
  canProceedAlong, canTraverseSegment, followRoute, type TerrainSampler,
} from '../src/index.ts';
import { everyCrossedCell } from '../src/grid.ts';

describe('exact segment cells', () => {
  it('visits successive boundary crossings in order, including the short intervening cell', () => {
    const cells: number[][] = [];
    expect(everyCrossedCell(0.25, 0.25, 2.25, 1.25, (x, y) => {
      cells.push([x, y]);
      return true;
    })).toBe(true);
    expect(cells).toEqual([[0, 0], [1, 0], [1, 1], [2, 1]]);
  });

  it('checks corner flanks from the preceding cell, then enters the diagonal', () => {
    const edges: number[][] = [];
    everyCrossedCell(1.5, 1.5, 2.5, 2.5, (x, y, px, py) => {
      edges.push([px, py, x, y]);
      return true;
    });
    expect(edges).toEqual([[1, 1, 1, 1], [1, 1, 2, 1], [1, 1, 1, 2], [1, 1, 2, 2]]);
  });

  it('handles negative travel from a boundary and exact endpoint ownership', () => {
    const cells: number[][] = [];
    everyCrossedCell(2, 1.5, 1, 1.5, (x, y) => { cells.push([x, y]); return true; });
    expect(cells).toEqual([[2, 1], [1, 1]]);
  });

  it('rejects nonrepresentable cells without visiting or looping', () => {
    for (const x of [NaN, Infinity, Number.MAX_VALUE]) {
      let visits = 0;
      expect(everyCrossedCell(x, 0, 1, 1, () => { visits++; return true; })).toBe(false);
      expect(visits).toBe(0);
    }
  });
});

describe('traversal and steering share the segment contract', () => {
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const swap of [false, true]) {
    it(`refuses a crossed wall in orientation ${sx}/${sy}/${swap}`, () => {
      const at = (x: number, y: number): [number, number] => swap ? [8 + sy * y, 8 + sx * x] : [8 + sx * x, 8 + sy * y];
      const from = at(1.9, 1.85);
      const to = at(2.1, 2.05);
      const blocked = at(2.5, 1.5).map(Math.floor);
      const world: TerrainSampler = {
        worldSize: 16,
        heightAt: (x, y) => x === blocked[0] && y === blocked[1] ? 300 : 100,
      };
      expect(canTraverseSegment(world, LAND_WALKER_PROFILE, ...from, ...to)).toBe(false);
      expect(canProceedAlong(world, LAND_WALKER_PROFILE, ...from, ...to)).toBe(false);
    });
  }

  it('refuses crossed habitat and freshwater barriers even with unconstrained slopes', () => {
    const world: TerrainSampler = {
      worldSize: 16,
      heightAt: (x, y) => x === 2 && y === 1 ? 100 : -100,
    };
    expect(canProceedAlong(world, OPEN_WATER_PROFILE, 1.9, 1.85, 2.1, 2.05)).toBe(false);
    const river: TerrainSampler = {
      worldSize: 16, heightAt: () => 100,
      freshwater: { at: (x, y) => x === 2 && y === 1 ? 'pool' : 'none' },
    };
    expect(canProceedAlong(river, LAND_WALKER_PROFILE, 1.9, 1.85, 2.1, 2.05)).toBe(false);
    expect(canProceedAlong(river, AMPHIBIOUS_WALKER_PROFILE, 1.9, 1.85, 2.1, 2.05)).toBe(true);
  });

  it('requires both diagonal flanks to pass their own step checks', () => {
    for (const [bx, by] of [[2, 1], [1, 2]]) {
      const world: TerrainSampler = { worldSize: 16, heightAt: (x, y) => x === bx && y === by ? 300 : 100 };
      expect(canTraverseSegment(world, LAND_WALKER_PROFILE, 1.5, 1.5, 2.5, 2.5)).toBe(false);
    }
  });

  it('keeps gradient-only traversal distinct from steering habitat admission', () => {
    const world: TerrainSampler = { worldSize: 16, heightAt: () => 100 };
    expect(canTraverseSegment(world, OPEN_WATER_PROFILE, 1.5, 1.5, 2.5, 2.5)).toBe(true);
    expect(canProceedAlong(world, OPEN_WATER_PROFILE, 1.5, 1.5, 2.5, 2.5)).toBe(false);
  });

  it('allows leaving habitat invalidated under a mover, while refusing entry to it', () => {
    const world: TerrainSampler = { worldSize: 16, heightAt: (x) => x === 1 ? 100 : -100 };
    expect(canProceedAlong(world, OPEN_WATER_PROFILE, 1.9, 1.5, 2.1, 1.5)).toBe(true);
    expect(canProceedAlong(world, OPEN_WATER_PROFILE, 2.1, 1.5, 1.9, 1.5)).toBe(false);
  });

  it('makes route steering avoid the same crossed obstacle', () => {
    const world: TerrainSampler = { worldSize: 16, heightAt: (x, y) => x === 2 && y === 1 ? 300 : 100 };
    const mover = { x: 1.9, y: 1.85, heading: Math.PI / 4, route: null, routeIndex: 0 };
    followRoute(world, LAND_WALKER_PROFILE, mover, {
      stepCells: Math.hypot(0.2, 0.2), lookaheadCells: 1, goalX: 2.1, goalY: 2.05,
    });
    expect(mover.x === 2.1 && mover.y === 2.05).toBe(false);
    expect(canProceedAlong(world, LAND_WALKER_PROFILE, 1.9, 1.85, mover.x, mover.y)).toBe(true);
  });
});
