import { describe, expect, it } from 'vitest';
import {
  bandOf,
  BAND_HEIGHT,
  cellIndex,
  cellX,
  cellY,
  createHeightmap,
  DEEP_BASALT_BANDS,
  DEEP_BASALT_DEPTH,
  DEEP_LAVA_BANDS,
  DEEP_LAVA_DEPTH,
  DEEP_OBSIDIAN_BANDS,
  DEEP_OBSIDIAN_DEPTH,
  DEEP_STRATA_BANDS,
  DEEP_STRATA_DEPTH,
  isValidHeight,
  isWater,
  LIBRARY_SCULPT_TOOL,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  quantizeToBand,
  RAMP_CELLS_PER_BAND,
  sculptReachCells,
  sculptSweepRadius,
  SEA_COLUMN_BANDS,
  SEA_COLUMN_DEPTH,
  SMOOTH_REACH_MARGIN_CELLS,
  smoothCascadeReachCells,
  SMOOTH_SPREAD_CELLS,
  WORLD_UNIT_CELLS,
} from '../src/index.ts';

describe('createHeightmap', () => {
  it('allocates a zeroed size×size grid', () => {
    const map = createHeightmap(64);
    expect(map.size).toBe(64);
    expect(map.cells.length).toBe(64 * 64);
    expect(map.cells.every((h) => h === 0)).toBe(true);
  });

  it('rejects non-positive and non-integer sizes', () => {
    expect(() => createHeightmap(0)).toThrow(RangeError);
    expect(() => createHeightmap(-4)).toThrow(RangeError);
    expect(() => createHeightmap(2.5)).toThrow(RangeError);
  });
});

describe('water and terracing', () => {
  it('height <= 0 is water', () => {
    expect(isWater(0)).toBe(true);
    expect(isWater(-5)).toBe(true);
    expect(isWater(1)).toBe(false);
  });

  it('bands use floor division so underwater heights band correctly', () => {
    expect(bandOf(0)).toBe(0);
    expect(bandOf(BAND_HEIGHT - 1)).toBe(0);
    expect(bandOf(BAND_HEIGHT)).toBe(1);
    expect(bandOf(-1)).toBe(-1);
    expect(bandOf(-BAND_HEIGHT)).toBe(-1);
    expect(bandOf(-BAND_HEIGHT - 1)).toBe(-2);
  });

  it('quantizes to the band floor', () => {
    expect(quantizeToBand(BAND_HEIGHT + 5)).toBe(BAND_HEIGHT);
    expect(quantizeToBand(-1)).toBe(-BAND_HEIGHT);
  });
});

describe('deep strata constants', () => {
  it('derives MIN_HEIGHT from the strata stack (Deep Strata, 2026-08-19)', () => {
    expect(SEA_COLUMN_DEPTH).toBe(MAX_HEIGHT);
    expect(DEEP_STRATA_DEPTH).toBe(
      DEEP_BASALT_DEPTH + DEEP_OBSIDIAN_DEPTH + DEEP_LAVA_DEPTH,
    );
    expect(MIN_HEIGHT).toBe(-(SEA_COLUMN_DEPTH + DEEP_STRATA_DEPTH));
    expect(MIN_HEIGHT).toBe(-1536);
    expect(isValidHeight(-SEA_COLUMN_DEPTH)).toBe(true);
    expect(isValidHeight(MIN_HEIGHT)).toBe(true);
    expect(isValidHeight(MIN_HEIGHT - 1)).toBe(false);
  });

  it('keeps the strata DEPTHS fixed while their band counts follow BAND_HEIGHT', () => {
    expect(SEA_COLUMN_BANDS).toBe(SEA_COLUMN_DEPTH / BAND_HEIGHT);
    expect(DEEP_BASALT_BANDS).toBe(DEEP_BASALT_DEPTH / BAND_HEIGHT);
    expect(DEEP_OBSIDIAN_BANDS).toBe(DEEP_OBSIDIAN_DEPTH / BAND_HEIGHT);
    expect(DEEP_LAVA_BANDS).toBe(DEEP_LAVA_DEPTH / BAND_HEIGHT);
    expect(DEEP_STRATA_BANDS).toBe(
      DEEP_BASALT_BANDS + DEEP_OBSIDIAN_BANDS + DEEP_LAVA_BANDS,
    );
    for (const bands of [
      SEA_COLUMN_BANDS,
      DEEP_BASALT_BANDS,
      DEEP_OBSIDIAN_BANDS,
      DEEP_LAVA_BANDS,
    ]) {
      expect(Number.isInteger(bands)).toBe(true);
    }
    expect(DEEP_BASALT_DEPTH / DEEP_LAVA_DEPTH).toBe(4);
    expect(DEEP_OBSIDIAN_DEPTH / DEEP_LAVA_DEPTH).toBe(3);
  });

  it('scales the smoothing budget with the range AND the gradient limit', () => {
    expect(SMOOTH_SPREAD_CELLS).toBe(
      Math.floor((MAX_HEIGHT - MIN_HEIGHT) / MAX_STEP),
    );
    expect(SMOOTH_SPREAD_CELLS).toBe(160 * WORLD_UNIT_CELLS);
  });

  it('caps the player smooth cascade at the brush that started it', () => {
    expect(RAMP_CELLS_PER_BAND).toBe(BAND_HEIGHT / MAX_STEP);
    // A stamp edge converges at radius + 2 cells; the margin is exactly that.
    for (const radius of [1, 2, 4, 8, MAX_BRUSH_RADIUS]) {
      expect([radius, smoothCascadeReachCells(radius)])
        .toEqual([radius, radius + SMOOTH_REACH_MARGIN_CELLS]);
    }
    expect(smoothCascadeReachCells(MAX_BRUSH_RADIUS)).toBeLessThan(SMOOTH_SPREAD_CELLS);
  });
});

describe('sculptReachCells — one statement of how far a stroke can write', () => {
  const RADIUS = 4;

  it('gives every relaxing tool its own cascade bound and the rest their sweep', () => {
    for (const radius of [1, RADIUS, MAX_BRUSH_RADIUS]) {
      expect([radius, sculptReachCells(radius, 'hard', 'smooth', 'clicked')])
        .toEqual([radius, 2 * radius + SMOOTH_REACH_MARGIN_CELLS]);
    }
    expect(sculptReachCells(RADIUS, 'soft', LIBRARY_SCULPT_TOOL, 'free'))
      .toBe(RADIUS + SMOOTH_SPREAD_CELLS);
    for (const tool of ['stamp', 'drag', 'carve'] as const) {
      for (const profile of ['soft', 'hard'] as const) {
        for (const anchor of ['clicked', 'free', 'band'] as const) {
          expect(sculptReachCells(RADIUS, profile, tool, anchor))
            .toBe(sculptSweepRadius(RADIUS, profile, tool, anchor));
        }
      }
    }
  });
});

describe('cellX/cellY — the exported inverse of cellIndex (#14)', () => {
  it('round-trips every cell of a small map', () => {
    const map = createHeightmap(7);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const i = cellIndex(map, x, y);
        expect(cellX(map.size, i)).toBe(x);
        expect(cellY(map.size, i)).toBe(y);
      }
    }
  });
});
