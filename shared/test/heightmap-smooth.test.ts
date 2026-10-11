import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  bandLevelHeight,
  BAND_HEIGHT,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  forEachFootprintOffset,
  heightAt,
  MAX_HEIGHT,
  sculptOptionsOf,
  smooth,
  SMOOTH_PASS_LIMIT,
  smoothCascadeReachCells,
  WORLD_UNIT_CELLS,
  type Heightmap,
  type SculptOptions,
  drawnBandOfSample,
} from '../src/index.ts';
import {
  CEILING_BANDS,
  expectGradientLimitHolds,
  expectGradientLimitHoldsWithin,
} from './support/heightmapFixtures.ts';

describe('smooth', () => {
  it('restores the gradient limit after a spike', () => {
    const map = createHeightmap(64);
    const changed = new Set<number>();
    const i = 32 * 64 + 32;
    map.cells[i] = 512;
    changed.add(i);
    smooth(map, changed);
    expectGradientLimitHolds(map);
    expect(heightAt(map, 32, 32)).toBeGreaterThan(0);
  });

  it('leaves an already-smooth map untouched', () => {
    const map = createHeightmap(32);
    map.cells.fill(100);
    const before = map.cells.slice();
    const changed = new Set<number>([5 * 32 + 5]);
    smooth(map, changed);
    expect(map.cells).toEqual(before);
  });

  it('holds the invariant near the map edge', () => {
    const map = createHeightmap(32);
    const changed = new Set<number>();
    map.cells[0] = 512;
    changed.add(0);
    smooth(map, changed);
    expectGradientLimitHolds(map);
  });
});

describe('smooth — cascades from stamped terrain (#12)', () => {
  const SIZE = 128;
  const C = SIZE / 2;
  const STAMP: SculptOptions = { tool: 'stamp', profile: 'hard' };
  const SMOOTH_HARD: SculptOptions = { tool: 'smooth', profile: 'hard' };

  function stampPlateau(map: Heightmap, x: number, y: number, bands: number): void {
    for (let s = 0; s < bands; s++) {
      applySculpt(map, x, y, 4, DEFAULT_SCULPT_AMOUNT, STAMP);
    }
  }

  it('one smooth stroke relaxes a 15-band stamped plateau inside its reach (the pass-cap repro)', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS - 1);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHoldsWithin(map, C, C, smoothCascadeReachCells(4));
  });

  it('a fully clamped smooth stroke still relaxes the cliffs under the brush', () => {
    const map = createHeightmap(SIZE);
    // One extra stamp: the first hard stamp from the sea only reaches the
    // shore, so clamping the plateau at MAX_HEIGHT takes CEILING_BANDS + 1.
    stampPlateau(map, C, C, CEILING_BANDS + 1);
    expect(drawnBandOfSample(heightAt(map, C, C))).toBe(drawnBandOfSample(MAX_HEIGHT));
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHoldsWithin(map, C, C, smoothCascadeReachCells(4));
  });

  it('converges across the full height range: MAX plateau beside a MIN moat', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS);
    for (let s = 0; s < 16; s++) {
      applySculpt(map, C + 8, C, 4, -DEFAULT_SCULPT_AMOUNT, STAMP);
    }
    applySculpt(map, C + 4, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHoldsWithin(map, C + 4, C, smoothCascadeReachCells(4));
  });

  it('reports a convergence-proving pass count strictly below the cap', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS - 1);
    const changed = new Set<number>();
    applyBrush(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, changed, 'hard');
    const passes = smooth(map, changed);
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    expectGradientLimitHolds(map);
  });
});

describe('a player stroke is never undone by its own relaxation (2026-08-22)', () => {
  const WORLD = 128;

  const rollingHills = (): Heightmap => {
    const map = createHeightmap(WORLD);
    for (let y = 0; y < WORLD; y++) {
      for (let x = 0; x < WORLD; x++) {
        const wx = x / WORLD_UNIT_CELLS;
        const wy = y / WORLD_UNIT_CELLS;
        map.cells[y * WORLD + x] = Math.round(
          (Math.sin(wx / 9) * Math.cos(wy / 7) * 6 + Math.sin((wx + wy) / 13) * 4) *
            BAND_HEIGHT,
        );
      }
    }
    return map;
  };

  const wireSmooth: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  const LADDER = [1, 2, 3, 4].map((worldUnits) => worldUnits * WORLD_UNIT_CELLS);

  for (const radius of LADDER) {
    for (const dir of [1, -1] as const) {
      it(`one click moves the clicked cell by at most two bands at radius ${radius}`, () => {
        // Pure smooth deposits nothing.
        for (let t = 0; t < 60; t++) {
          const map = rollingHills();
          const cx = 30 + ((t * 11) % 68);
          const cy = 30 + ((t * 17) % 68);
          const centre = cellIndex(map, cx, cy);
          const before = map.cells[centre];

          applySculpt(map, cx, cy, radius, dir * DEFAULT_SCULPT_AMOUNT, wireSmooth);

          expect(Math.abs(map.cells[centre]! - before!)).toBeLessThanOrEqual(2 * BAND_HEIGHT);
        }
      });
    }
  }

  it('relaxation never moves the CLICKED cell more than two bands', () => {
    for (const dir of [1, -1] as const) {
      for (const radius of LADDER) {
        const map = rollingHills();
        const cx = 61;
        const cy = 47;
        const centre = cellIndex(map, cx, cy);
        const before = map.cells[centre];
        const amount = dir * DEFAULT_SCULPT_AMOUNT;
        applySculpt(map, cx, cy, radius, amount, wireSmooth);

        expect(Math.abs(map.cells[centre]! - before!)).toBeLessThanOrEqual(2 * BAND_HEIGHT);
      }
    }
  });

  it('writes only its disc: outline vertices past the brush stay pinned', () => {
    for (const radius of LADDER) {
      const map = rollingHills();
      const before = Int16Array.from(map.cells);
      const cx = 61;
      const cy = 47;
      const footprint = new Set<number>();
      forEachFootprintOffset(radius, (dx, dy) => {
        footprint.add(cellIndex(map, cx + dx, cy + dy));
      });

      const diff = applySculpt(map, cx, cy, radius, DEFAULT_SCULPT_AMOUNT, wireSmooth);

      expect(diff.length).toBeGreaterThan(0);
      let movedOutside = 0;
      for (let i = 0; i < map.cells.length; i++) {
        if (map.cells[i] !== before[i] && !footprint.has(i)) movedOutside++;
      }
      expect([radius, movedOutside]).toEqual([radius, 0]);
    }
  });
});

describe('an anchored smooth moves a wall, it never manufactures one', () => {
  const SIZE = 64;
  const WALL_X = 32;
  const ROW = 32;
  const LOW = bandLevelHeight(20);
  const RADIUS = 4;
  const PRESSES = 10;
  const REACHING_CLICKS = [WALL_X, WALL_X + 1, WALL_X + 2];
  /** Taller than one drawn band: every wall cell under the brush is past the target. */
  const PAST_TARGET_BANDS = [2, 3];

  function wall(bands: number): Heightmap {
    const map = createHeightmap(SIZE);
    const high = LOW + bands * BAND_HEIGHT;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = x < WALL_X ? high : LOW;
    }
    return map;
  }

  function press(map: Heightmap, cx: number, dir: 1 | -1 = -1): number {
    const options = sculptOptionsOf({
      type: 'sculpt', x: cx, y: ROW, radius: RADIUS, dir, tool: 'smooth',
    });
    return applySculpt(map, cx, ROW, RADIUS, dir * DEFAULT_SCULPT_AMOUNT, options).length;
  }

  function footprintOfPress(map: Heightmap, cx: number): Set<number> {
    const cells = new Set<number>();
    forEachFootprintOffset(RADIUS, (dx, dy) => {
      cells.add(cellIndex(map, cx + dx, ROW + dy));
    });
    return cells;
  }

  function mapTotal(map: Heightmap): number {
    let total = 0;
    for (let i = 0; i < map.cells.length; i++) total += map.cells[i]!;
    return total;
  }

  it('a straight one-band step keeps every band: smooth removes kinks, it never spreads a wall', () => {
    for (const cx of REACHING_CLICKS) {
      const map = wall(1);
      const before = Int16Array.from(map.cells);
      const footprint = footprintOfPress(map, cx);

      let last = -1;
      for (let k = 0; k < PRESSES; k++) last = press(map, cx);
      expect(last).toBe(0);

      for (let i = 0; i < map.cells.length; i++) {
        expect(drawnBandOfSample(map.cells[i]!)).toBe(drawnBandOfSample(before[i]!));
        if (!footprint.has(i)) expect(map.cells[i]).toBe(before[i]);
      }
    }
  });

  for (const bands of PAST_TARGET_BANDS) {
    it(`a ${bands}-band step is past the target: lowering freezes it`, () => {
      const high = LOW + bands * BAND_HEIGHT;
      // Wall columns off the feature never move.
      for (const cx of REACHING_CLICKS) {
        const map = wall(bands);
        const total = mapTotal(map);
        const before = Int16Array.from(map.cells);
        const footprint = footprintOfPress(map, cx);

        let touched = press(map, cx);
        let last = -1;
        for (let k = 1; k < PRESSES; k++) {
          last = press(map, cx);
          touched += last;
        }
        expect(last).toBe(0);

        for (const i of footprint) {
          if (before[i] === high) {
            expect(map.cells[i]).toBeGreaterThanOrEqual(high - 2 * BAND_HEIGHT);
          }
        }
        expect(heightAt(map, WALL_X - 1, ROW)).toBeGreaterThanOrEqual(high - 2 * BAND_HEIGHT);
        expect(Math.abs(mapTotal(map) - total)).toBeLessThanOrEqual(touched * 2 * BAND_HEIGHT);
        for (let i = 0; i < map.cells.length; i++) {
          expect(map.cells[i]).toBeGreaterThanOrEqual(LOW);
          expect(map.cells[i]).toBeLessThanOrEqual(high);
        }
      }
    });
  }
});
