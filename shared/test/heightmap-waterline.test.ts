import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandFloorHeight,
  bandLevelHeight,
  BAND_HEIGHT,
  cellIndex,
  columnCoversBand,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  DRAWN_SHORE_HEIGHT,
  heightAt,
  SEA_LEVEL,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';

describe('applySculpt — raises out of the sea break the surface', () => {
  const SIZE = 32;
  const CX = 16;
  const CY = 16;
  const flat = (h: number): Heightmap => {
    const map = createHeightmap(SIZE);
    map.cells.fill(h);
    return map;
  };
  const at = (map: Heightmap): number => map.cells[cellIndex(map, CX, CY)]!;
  // What the client sends for a single-span stamp raise (no spanBand).
  const STAMP_RAISE: SculptOptions = {
    tool: 'stamp',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
    targetBand: null,
    spanBand: null,
    sweepFrom: null,
  };

  it('a stamp raise from h=-7 lands at the shore height, not at 0', () => {
    const map = flat(-7);
    applySculpt(map, CX, CY, 2, DEFAULT_SCULPT_AMOUNT, STAMP_RAISE);
    expect(at(map)).toBe(DRAWN_SHORE_HEIGHT);
  });

  it('the raised cell draws as beach (band 0), not sea (band -1)', () => {
    const map = flat(-7);
    applySculpt(map, CX, CY, 2, DEFAULT_SCULPT_AMOUNT, STAMP_RAISE);
    expect(drawnBandOfSample(at(map))).toBe(0);
  });

  it('a stamp raise from the waterline reaches the shore, not raw 16', () => {
    const map = flat(0);
    applySculpt(map, CX, CY, 2, DEFAULT_SCULPT_AMOUNT, STAMP_RAISE);
    expect(at(map)).toBe(DRAWN_SHORE_HEIGHT);
  });

  it('a stamp raise from the beach still reaches the next raw band', () => {
    const map = flat(2);
    applySculpt(map, CX, CY, 2, DEFAULT_SCULPT_AMOUNT, STAMP_RAISE);
    expect(at(map)).toBe(BAND_HEIGHT);
  });

  it('a stamp lower from the waterline lands on band -2, at its canonical level', () => {
    // -BAND_HEIGHT still draws as sea: the old raw-band step was invisible.
    const map = flat(0);
    applySculpt(map, CX, CY, 2, -DEFAULT_SCULPT_AMOUNT, STAMP_RAISE);
    expect(drawnBandOfSample(at(map))).toBe(-2);
    expect(at(map)).toBe(bandLevelHeight(-2));
  });

  it('every anchored press lands ON a canonical band level, sea band included', () => {
    for (const dir of [1, -1] as const) {
      for (let h = bandFloorHeight(-2); h <= 2 * BAND_HEIGHT; h++) {
        const map = flat(h);
        applySculpt(map, CX, CY, 2, dir * DEFAULT_SCULPT_AMOUNT, STAMP_RAISE);
        const landed = at(map);
        expect([h, dir, landed]).toEqual([h, dir, bandLevelHeight(drawnBandOfSample(h) + dir)]);
      }
    }
  });

  it('every height in the sea band moves exactly one DRAWN band per press', () => {
    for (const profile of ['soft', 'hard'] as const) {
      for (const dir of [1, -1] as const) {
        for (let h = bandFloorHeight(-1); h <= SEA_LEVEL; h++) {
          const map = flat(h);
          applySculpt(map, CX, CY, 3, dir * DEFAULT_SCULPT_AMOUNT, { ...STAMP_RAISE, profile });
          expect([profile, dir, h, drawnBandOfSample(at(map))]).toEqual([
            profile, dir, h, drawnBandOfSample(h) + dir,
          ]);
        }
      }
    }
  });

  it('a drag-raise toward band 0 extends the beach to the shore height', () => {
    // Drag spreads from an edge: beach west, sea east.
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] = x < CX ? 2 : -7;
      }
    }
    applySculpt(map, CX, CY, 2, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'soft',
      spill: 'banded',
      anchor: 'band',
      targetBand: 0,
      spanBand: null,
      sweepFrom: null,
    });
    expect(at(map)).toBe(DRAWN_SHORE_HEIGHT);
    expect(drawnBandOfSample(at(map))).toBe(0);
  });
});

describe('band coverage agrees with drawing at the waterline (2026-09-12)', () => {
  const NEAR_BANDS = 2;
  const HEIGHT_REACH = 3 * BAND_HEIGHT;

  it('band floors are drawn floors: the shore, then 8 below every raw level', () => {
    expect(bandFloorHeight(0)).toBe(DRAWN_SHORE_HEIGHT);
    for (const band of [-NEAR_BANDS, -1, 1, NEAR_BANDS]) {
      expect(bandFloorHeight(band)).toBe(band * BAND_HEIGHT - BAND_HEIGHT / 2);
    }
    for (const band of [-NEAR_BANDS, -1, 0, 1, NEAR_BANDS]) {
      expect(bandLevelHeight(band)).toBe(band === 0 ? DRAWN_SHORE_HEIGHT : band * BAND_HEIGHT);
    }
  });

  it('a column that covers a band draws at that band or above', () => {
    const map = createHeightmap(1);
    for (let h = -HEIGHT_REACH; h <= HEIGHT_REACH; h++) {
      map.cells[0] = h;
      for (let band = -NEAR_BANDS; band <= NEAR_BANDS; band++) {
        if (columnCoversBand(map, 0, 0, band)) expect(drawnBandOfSample(h)).toBeGreaterThanOrEqual(band);
      }
    }
  });

  it('a band-0 drag lifts sea-level cells to the shore, not only cells below the sea', () => {
    const SIZE = 16;
    const SHORE_EDGE_X = 4;
    const DEEP_X = 6;
    const ROW = 8;
    const END_X = 8;
    const RADIUS = 3;
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] =
          x < SHORE_EDGE_X ? DRAWN_SHORE_HEIGHT : x === DEEP_X ? -BAND_HEIGHT : SEA_LEVEL;
      }
    }
    applySculpt(map, END_X, ROW, RADIUS, DEFAULT_SCULPT_AMOUNT, {
      tool: 'drag',
      profile: 'hard',
      anchor: 'band',
      targetBand: 0,
      sweepFrom: { x: SHORE_EDGE_X, y: ROW },
    });
    for (let x = SHORE_EDGE_X; x <= END_X; x++) {
      expect(heightAt(map, x, ROW)).toBe(DRAWN_SHORE_HEIGHT);
      expect(drawnBandOfSample(heightAt(map, x, ROW))).toBe(0);
    }
  });
});
