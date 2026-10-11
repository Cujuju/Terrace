import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, WORLD_UNIT_CELLS, bandOf } from '@terrace/shared';
import {
  CHART_LAND,
  CHART_UNKNOWN,
  CHART_WATER,
  KRAKEN_MIN_DEPTH_CELLS,
  SINGE_RANGE_CELLS,
  WINDOW_PAD_CELLS,
  buildChartModel,
  chartWindow,
  hash01,
  type ChartSource,
} from '../src/terrain/chart.ts';

function sourceOf(
  size: number,
  height: (x: number, y: number) => number,
  revealed: (x: number, y: number) => boolean,
): ChartSource {
  return { size, heightAt: height, revealedAt: revealed };
}

describe('hash01', () => {
  it('is deterministic and in [0, 1)', () => {
    for (let x = -3; x < 40; x += 7) {
      for (let y = -3; y < 40; y += 5) {
        const a = hash01(x, y);
        expect(a).toBe(hash01(x, y));
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
      }
    }
  });

  it('separates neighbouring cells (no visible banding)', () => {
    expect(hash01(10, 10)).not.toBe(hash01(11, 10));
    expect(hash01(10, 10)).not.toBe(hash01(10, 11));
  });
});

describe('buildChartModel — classification', () => {
  it('classifies water at the shared waterline and land above it', () => {
    const size = 4;
    const model = buildChartModel(
      sourceOf(size, (x) => (x < 2 ? 0 : 1), () => true),
    );
    expect(model.kind[0]).toBe(CHART_WATER);
    expect(model.kind[2]).toBe(CHART_LAND);
    expect(model.revealedCount).toBe(size * size);
  });

  it('records bandOf(height) for revealed cells', () => {
    const h = 3 * BAND_HEIGHT + 5;
    const model = buildChartModel(sourceOf(2, () => h, () => true));
    expect(model.band[0]).toBe(bandOf(h));
  });

  it('marks unrevealed cells unknown and never reads their heights', () => {
    const model = buildChartModel(
      sourceOf(
        2,
        () => {
          throw new Error('height of an unrevealed cell was read');
        },
        () => false,
      ),
    );
    expect(model.kind.every((k) => k === CHART_UNKNOWN)).toBe(true);
    expect(model.revealedCount).toBe(0);
  });
});

describe('buildChartModel — the singed frontier', () => {
  const size = 24 * WORLD_UNIT_CELLS;
  const revealedSpan = 8 * WORLD_UNIT_CELLS;
  const revealed = (x: number, y: number): boolean => x < revealedSpan && y < revealedSpan;
  const model = buildChartModel(sourceOf(size, () => 1, revealed));

  it('is zero on revealed cells', () => {
    expect(model.singe[0]).toBe(0);
    expect(model.singe[(revealedSpan - 1) * size + revealedSpan - 1]).toBe(0);
  });

  it('steps 1, 2, … away from the frontier and stops at SINGE_RANGE_CELLS', () => {
    for (let step = 1; step <= SINGE_RANGE_CELLS; step++) {
      expect(model.singe[revealedSpan - 1 + step]).toBe(step);
    }
    expect(model.singe[revealedSpan + SINGE_RANGE_CELLS]).toBe(0);
  });

  it('anchors the kraken at the deepest unknown cell, deterministically', () => {
    expect(model.krakenCell).toBe(size * size - 1);
  });

  it('withholds the kraken when no unknown cell is deep enough', () => {
    const fringeSize = 24 * WORLD_UNIT_CELLS;
    const fringeDepth = 2;
    const fringe = buildChartModel(
      sourceOf(fringeSize, () => 1, (x, y) => x < fringeSize - fringeDepth && y < fringeSize),
    );
    expect(KRAKEN_MIN_DEPTH_CELLS).toBeGreaterThan(fringeDepth);
    expect(fringe.krakenCell).toBe(-1);
  });

  it('withholds the kraken on fully revealed and fully unknown worlds', () => {
    expect(buildChartModel(sourceOf(8, () => 1, () => true)).krakenCell).toBe(-1);
    expect(buildChartModel(sourceOf(8, () => 1, () => false)).krakenCell).toBe(-1);
  });
});

describe('bounds and chartWindow', () => {
  it('bounds is the inclusive bbox of revealed cells, null when none', () => {
    const model = buildChartModel(
      sourceOf(16, () => 1, (x, y) => x >= 3 && x <= 5 && y >= 7 && y <= 12),
    );
    expect(model.bounds).toEqual({ x0: 3, y0: 7, x1: 5, y1: 12 });
    expect(buildChartModel(sourceOf(4, () => 1, () => false)).bounds).toBeNull();
  });

  it('windows to a padded square around the revealed territory', () => {
    const size = 512;
    const model = buildChartModel(
      sourceOf(size, () => 1, (x, y) => x >= 200 && x < 240 && y >= 300 && y < 320),
    );
    const win = chartWindow(model);
    expect(win.span).toBe(40 + 2 * WINDOW_PAD_CELLS);
    expect(win.x0).toBeLessThanOrEqual(200 - SINGE_RANGE_CELLS);
    expect(win.y0).toBeLessThanOrEqual(300 - SINGE_RANGE_CELLS);
    expect(win.x0 + win.span).toBeGreaterThanOrEqual(240 + SINGE_RANGE_CELLS);
    expect(win.y0 + win.span).toBeGreaterThanOrEqual(320 + SINGE_RANGE_CELLS);
  });

  it('clamps the window into the world at corners and caps span at world size', () => {
    const corner = chartWindow(
      buildChartModel(sourceOf(64, () => 1, (x, y) => x < 4 && y < 4)),
    );
    expect(corner.x0).toBe(0);
    expect(corner.y0).toBe(0);
    const everywhere = chartWindow(
      buildChartModel(sourceOf(32, () => 1, () => true)),
    );
    expect(everywhere).toEqual({ x0: 0, y0: 0, span: 32 });
    const nothing = chartWindow(
      buildChartModel(sourceOf(32, () => 1, () => false)),
    );
    expect(nothing).toEqual({ x0: 0, y0: 0, span: 32 });
  });
});

describe('buildChartModel — determinism', () => {
  it('two builds over the same source are byte-identical', () => {
    const height = (x: number, y: number): number =>
      ((x * 31 + y * 17) % 5) * BAND_HEIGHT - BAND_HEIGHT;
    const revealed = (x: number, y: number): boolean => (x + y) % 3 !== 0 && x < 20;
    const a = buildChartModel(sourceOf(32, height, revealed));
    const b = buildChartModel(sourceOf(32, height, revealed));
    expect(a.kind).toEqual(b.kind);
    expect(a.band).toEqual(b.band);
    expect(a.singe).toEqual(b.singe);
    expect(a.krakenCell).toBe(b.krakenCell);
    expect(a.revealedCount).toBe(b.revealedCount);
  });
});
