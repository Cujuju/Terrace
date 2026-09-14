import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  bandFloorHeight,
  bandLevelHeight,
  createHeightmap,
  columnCoversBand,
  drawnBandOfSample,
  drawnLevelThreshold,
  DRAWN_SHORE_HEIGHT,
  isHeightInBand,
  isSpanDrawn,
  spanCapHeight,
  spanLowestBandHeight,
  stepTowardBand,
} from '../src/index.ts';

describe('drawn-band contract (lane A)', () => {
  it('band 0 starts at the shore; every other band floor sits 8 below its raw level', () => {
    expect(bandFloorHeight(0)).toBe(DRAWN_SHORE_HEIGHT);
    for (const band of [-4, -2, -1, 1, 2, 7]) {
      expect(bandFloorHeight(band)).toBe(band * BAND_HEIGHT - BAND_HEIGHT / 2);
    }
  });

  it('band levels are the canonical writes: raw k*16, 1 at the shore', () => {
    expect(bandLevelHeight(0)).toBe(DRAWN_SHORE_HEIGHT);
    for (const band of [-4, -2, -1, 1, 2, 7]) {
      expect(bandLevelHeight(band)).toBe(band * BAND_HEIGHT);
    }
  });

  it('drawnLevelThreshold reads the biased field, with the shore exception at band 0', () => {
    expect(drawnLevelThreshold(0)).toBe(DRAWN_SHORE_HEIGHT + BAND_HEIGHT / 2);
    expect(drawnLevelThreshold(3)).toBe(3 * BAND_HEIGHT);
  });

  it('drawnBandOfSample pins the band edges, sea included', () => {
    expect(drawnBandOfSample(0)).toBe(-1);
    expect(drawnBandOfSample(1)).toBe(0);
    expect(drawnBandOfSample(7)).toBe(0);
    expect(drawnBandOfSample(8)).toBe(1);
    expect(drawnBandOfSample(23)).toBe(1);
    expect(drawnBandOfSample(24)).toBe(2);
    expect(drawnBandOfSample(-1)).toBe(-1);
    expect(drawnBandOfSample(-24)).toBe(-1);
    expect(drawnBandOfSample(-25)).toBe(-2);
  });

  it('bandFloorHeight is the lowest height drawn as its band', () => {
    for (let band = -6; band <= 6; band++) {
      const floor = bandFloorHeight(band);
      expect(drawnBandOfSample(floor)).toBe(band);
      if (band !== 0) expect(drawnBandOfSample(floor - 1)).toBe(band - 1);
    }
    expect(drawnBandOfSample(bandFloorHeight(0) - 1)).toBe(-1);
  });

  it('isHeightInBand is drawn-equality across the near field', () => {
    for (let h = -64; h <= 64; h++) {
      const band = drawnBandOfSample(h);
      expect(isHeightInBand(h, band)).toBe(true);
      expect(isHeightInBand(h, band + 1)).toBe(false);
      expect(isHeightInBand(h, band - 1)).toBe(false);
    }
  });

  it('stepTowardBand crosses exactly one drawn band per press', () => {
    for (let h = -64; h <= 64; h++) {
      const band = drawnBandOfSample(h);
      expect(drawnBandOfSample(stepTowardBand(h, true))).toBe(band + 1);
      expect(drawnBandOfSample(stepTowardBand(h, false))).toBe(band - 1);
    }
  });

  it('the 8-to-15 class now moves: a raise from mid-band-1 reaches band 2', () => {
    for (let h = 8; h <= 15; h++) {
      expect(drawnBandOfSample(h)).toBe(1);
      const next = stepTowardBand(h, true);
      expect(next).toBe(2 * BAND_HEIGHT);
      expect(drawnBandOfSample(next)).toBe(2);
    }
  });

  it('a raise out of the sea breaks the surface at the shore', () => {
    expect(stepTowardBand(0, true)).toBe(DRAWN_SHORE_HEIGHT);
    expect(stepTowardBand(-7, true)).toBe(DRAWN_SHORE_HEIGHT);
  });

  it('span caps and lowest heights read the drawn grid', () => {
    expect(spanCapHeight({ floor: 8, ceiling: 15 })).toBe(BAND_HEIGHT);
    expect(spanCapHeight({ floor: 1, ceiling: 7 })).toBe(DRAWN_SHORE_HEIGHT);
    expect(spanLowestBandHeight({ floor: 9, ceiling: 32 })).toBe(BAND_HEIGHT);
    expect(spanLowestBandHeight({ floor: 1, ceiling: 7 })).toBe(DRAWN_SHORE_HEIGHT);
  });

  it('a shore sliver is drawn, and covering agrees with drawing', () => {
    expect(isSpanDrawn({ floor: 1, ceiling: 7 })).toBe(true);
    expect(isSpanDrawn({ floor: 8, ceiling: 15 })).toBe(true);
    const map = createHeightmap(1);
    map.cells[0] = 15;
    expect(columnCoversBand(map, 0, 0, 1)).toBe(true);
    expect(drawnBandOfSample(15)).toBe(1);
  });
});
