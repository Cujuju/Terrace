import { describe, expect, it } from 'vitest';
import {
  applyBrush,
  applySculpt,
  BAND_HEIGHT,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  forEachFootprintOffset,
  heightAt,
  MAX_HEIGHT,
  sculptOptionsOf,
  smooth,
  SMOOTH_PASS_LIMIT,
  WORLD_UNIT_CELLS,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';
import {
  CEILING_BANDS,
  expectGradientLimitHolds,
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

  it('one smooth stroke fully relaxes a 15-band stamped plateau (the pass-cap repro)', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS - 1);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('a fully clamped smooth stroke still relaxes the cliffs under the brush', () => {
    const map = createHeightmap(SIZE);
    // One extra stamp: the first hard stamp from the sea only reaches the
    // shore, so clamping the plateau at MAX_HEIGHT takes CEILING_BANDS + 1.
    stampPlateau(map, C, C, CEILING_BANDS + 1);
    expect(heightAt(map, C, C)).toBe(MAX_HEIGHT);
    applySculpt(map, C, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
  });

  it('converges across the full height range: MAX plateau beside a MIN moat', () => {
    const map = createHeightmap(SIZE);
    stampPlateau(map, C, C, CEILING_BANDS);
    for (let s = 0; s < 16; s++) {
      applySculpt(map, C + 8, C, 4, -DEFAULT_SCULPT_AMOUNT, STAMP);
    }
    applySculpt(map, C + 4, C, 4, DEFAULT_SCULPT_AMOUNT, SMOOTH_HARD);
    expectGradientLimitHolds(map);
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
      it(`one click moves the clicked cell by at most one band at radius ${radius}`, () => {
        for (let t = 0; t < 60; t++) {
          const map = rollingHills();
          const cx = 30 + ((t * 11) % 68);
          const cy = 30 + ((t * 17) % 68);
          const centre = cellIndex(map, cx, cy);
          const before = drawnBandOfSample(map.cells[centre]);
          // Band -1 spans 25 heights against a 16-unit stroke, so one click
          // from its depths cannot always cross a drawn band;
          // break-the-surface tests pin sea entry.
          if (before === -1) continue;

          applySculpt(map, cx, cy, radius, dir * DEFAULT_SCULPT_AMOUNT, wireSmooth);

          const after = drawnBandOfSample(map.cells[centre]);
          expect([before, before + dir]).toContain(after);
        }
      });
    }
  }

  it('relaxation never moves the CLICKED cell more than one band', () => {
    for (const dir of [1, -1] as const) {
      for (const radius of LADDER) {
        const map = rollingHills();
        const cx = 61;
        const cy = 47;
        const centre = cellIndex(map, cx, cy);
        const before = drawnBandOfSample(map.cells[centre]);
        const amount = dir * DEFAULT_SCULPT_AMOUNT;
        applySculpt(map, cx, cy, radius, amount, wireSmooth);

        const after = drawnBandOfSample(map.cells[centre]);
        expect([before, before + dir]).toContain(after);
      }
    }
  });

  it('still spills beyond its footprint — smooth has not become stamp', () => {
    for (const radius of LADDER) {
      const map = createHeightmap(WORLD);
      for (let y = 0; y < WORLD; y++) {
        for (let x = 61; x < WORLD; x++) map.cells[y * WORLD + x] = 4 * BAND_HEIGHT;
      }
      const before = Int16Array.from(map.cells);
      const cx = 61;
      const cy = 47;
      const footprint = new Set<number>();
      forEachFootprintOffset(radius, (dx, dy) => {
        footprint.add(cellIndex(map, cx + dx, cy + dy));
      });

      applySculpt(map, cx, cy, radius, DEFAULT_SCULPT_AMOUNT, wireSmooth);

      let movedOutside = 0;
      for (let i = 0; i < map.cells.length; i++) {
        if (map.cells[i] !== before[i] && !footprint.has(i)) movedOutside++;
      }
      expect(movedOutside).toBeGreaterThan(0);
    }
  });
});

describe('an anchored smooth melts a wall from wherever it is clicked', () => {
  const SIZE = 64;
  const WALL_X = 32;
  const ROW = 32;
  const LOW = 320;
  const RADIUS = 4;
  const PRESSES = 10;
  const REACHING_CLICKS = [WALL_X, WALL_X + 1, WALL_X + 2];

  function wall(bands: number): Heightmap {
    const map = createHeightmap(SIZE);
    const high = LOW + bands * BAND_HEIGHT;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) map.cells[cellIndex(map, x, y)] = x < WALL_X ? high : LOW;
    }
    return map;
  }

  function press(map: Heightmap, cx: number): number {
    const options = sculptOptionsOf({
      type: 'sculpt', x: cx, y: ROW, radius: RADIUS, dir: 1, tool: 'smooth',
    });
    return applySculpt(map, cx, ROW, RADIUS, DEFAULT_SCULPT_AMOUNT, options).length;
  }

  function footprintOfPress(map: Heightmap, cx: number): Set<number> {
    const cells = new Set<number>();
    forEachFootprintOffset(RADIUS, (dx, dy) => {
      cells.add(cellIndex(map, cx + dx, ROW + dy));
    });
    return cells;
  }

  for (const bands of [1, 2, 3]) {
    it(`a ${bands}-band step melts and converges from every click that reaches it`, () => {
      const high = LOW + bands * BAND_HEIGHT;
      for (const cx of REACHING_CLICKS) {
        const map = wall(bands);
        const before = Int16Array.from(map.cells);
        const footprint = footprintOfPress(map, cx);

        expect(press(map, cx)).toBeGreaterThan(0);
        let movedUnderBrush = 0;
        for (const i of footprint) if (map.cells[i] !== before[i]) movedUnderBrush++;
        expect(movedUnderBrush).toBeGreaterThan(0);

        let last = -1;
        for (let k = 1; k < PRESSES; k++) last = press(map, cx);
        expect(last).toBe(0);

        expect(heightAt(map, WALL_X, ROW)).toBeGreaterThan(LOW);
        // nothing outside every footprint is cut, and a raise never digs
        expect(heightAt(map, WALL_X - RADIUS - 2, ROW)).toBe(high);
        for (let x = 0; x < SIZE; x++) {
          expect(heightAt(map, x, ROW)).toBeGreaterThanOrEqual(LOW);
          expect(heightAt(map, x, ROW)).toBeLessThanOrEqual(high);
        }
      }
    });
  }
});
