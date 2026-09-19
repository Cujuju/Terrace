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
  spanCapBand,
  spanCapHeight,
  spanUndersideLevel,
  stepTowardBand,
} from '../src/index.ts';

describe('drawn-band contract (lane A)', () => {
  it('band floors are uniform: band k starts at 16k+1, the shore', () => {
    expect(bandFloorHeight(0)).toBe(DRAWN_SHORE_HEIGHT);
    for (const band of [-4, -2, -1, 1, 2, 7]) {
      expect(bandFloorHeight(band)).toBe(band * BAND_HEIGHT + DRAWN_SHORE_HEIGHT);
    }
  });

  it('band levels are the canonical writes: the band midpoint, 9 at the shore', () => {
    expect(bandLevelHeight(0)).toBe(DRAWN_SHORE_HEIGHT + BAND_HEIGHT / 2);
    for (const band of [-4, -2, -1, 1, 2, 7]) {
      expect(bandLevelHeight(band)).toBe(band * BAND_HEIGHT + DRAWN_SHORE_HEIGHT + BAND_HEIGHT / 2);
    }
  });

  it('drawnLevelThreshold reads the biased field: the canonical level', () => {
    expect(drawnLevelThreshold(0)).toBe(DRAWN_SHORE_HEIGHT + BAND_HEIGHT / 2);
    expect(drawnLevelThreshold(3)).toBe(3 * BAND_HEIGHT + DRAWN_SHORE_HEIGHT + BAND_HEIGHT / 2);
  });

  it('drawnBandOfSample pins the band edges, sea included', () => {
    expect(drawnBandOfSample(0)).toBe(-1);
    expect(drawnBandOfSample(1)).toBe(0);
    expect(drawnBandOfSample(7)).toBe(0);
    expect(drawnBandOfSample(8)).toBe(0);
    expect(drawnBandOfSample(23)).toBe(1);
    expect(drawnBandOfSample(24)).toBe(1);
    expect(drawnBandOfSample(-1)).toBe(-1);
    expect(drawnBandOfSample(-24)).toBe(-2);
    expect(drawnBandOfSample(-25)).toBe(-2);
  });

  it('bandFloorHeight is the lowest height drawn as its band', () => {
    for (let band = -6; band <= 6; band++) {
      const floor = bandFloorHeight(band);
      expect(drawnBandOfSample(floor)).toBe(band);
      expect(drawnBandOfSample(floor - 1)).toBe(band - 1);
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

  it('a raise from mid-band-0 reaches band 1', () => {
    for (let h = 8; h <= 15; h++) {
      expect(drawnBandOfSample(h)).toBe(0);
      const next = stepTowardBand(h, true);
      expect(next).toBe(bandLevelHeight(1));
      expect(drawnBandOfSample(next)).toBe(1);
    }
  });

  it('a raise out of the sea breaks the surface at the shore band level', () => {
    expect(stepTowardBand(0, true)).toBe(bandLevelHeight(0));
    expect(stepTowardBand(-7, true)).toBe(bandLevelHeight(0));
  });

  it('span caps read the drawn grid; undersides are exact band levels', () => {
    expect(spanCapHeight({ floorBand: 0, ceiling: 15 })).toBe(bandLevelHeight(0));
    expect(spanCapHeight({ floorBand: 0, ceiling: 7 })).toBe(bandLevelHeight(0));
    expect(spanCapBand({ floorBand: 0, ceiling: 15 })).toBe(0);
    expect(spanUndersideLevel({ floorBand: 1, ceiling: 32 })).toBe(bandLevelHeight(0));
    expect(spanUndersideLevel({ floorBand: 3, ceiling: 48 })).toBe(bandLevelHeight(2));
  });

  it('a shore sliver is drawn, and covering agrees with drawing', () => {
    expect(isSpanDrawn({ floorBand: 0, ceiling: 7 })).toBe(true);
    expect(isSpanDrawn({ floorBand: 1, ceiling: 17 })).toBe(true);
    expect(isSpanDrawn({ floorBand: 2, ceiling: 15 })).toBe(false);
    const map = createHeightmap(1);
    map.cells[0] = 17;
    expect(columnCoversBand(map, 0, 0, 1)).toBe(true);
    expect(drawnBandOfSample(17)).toBe(1);
  });
});
