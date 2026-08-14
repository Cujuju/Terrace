import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  SEA_LEVEL,
  bandOf,
  isWater,
} from '@terrace/shared';
import {
  FIRST_LAND_PALETTE_INDEX,
  LAST_PALETTE_INDEX,
  SEABED_DEPTH_STOPS,
  SEABED_PALETTE_INDEX,
  TERRAIN_PALETTE,
  bandColorOf,
  bandPaletteIndex,
} from '../src/terrain/bandColors.ts';

describe('TERRAIN_PALETTE', () => {
  it('holds normalised components only', () => {
    for (const entry of TERRAIN_PALETTE) {
      expect(entry).toHaveLength(3);
      for (const component of entry) {
        expect(component).toBeGreaterThanOrEqual(0);
        expect(component).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gets brighter from sand to snow, so the ramp reads as elevation', () => {
    const luminance = (i: number): number => {
      const [r, g, b] = TERRAIN_PALETTE[i];
      return r + g + b;
    };
    expect(luminance(LAST_PALETTE_INDEX)).toBeGreaterThan(
      luminance(FIRST_LAND_PALETTE_INDEX),
    );
  });
});

describe('bandPaletteIndex', () => {
  it('steps one seabed stop per band of depth, clamping at the deepest', () => {
    // The flats (h = 0) are stop 0; each band down takes the next stop —
    // mirroring how the dry side steps at band edges — and everything past
    // the ramp shares the deepest stop rather than wrapping into land colours.
    expect(bandPaletteIndex(SEA_LEVEL)).toBe(SEABED_PALETTE_INDEX);
    expect(bandPaletteIndex(SEA_LEVEL - 1)).toBe(SEABED_PALETTE_INDEX + 1);
    expect(bandPaletteIndex(-BAND_HEIGHT)).toBe(SEABED_PALETTE_INDEX + 1);
    expect(bandPaletteIndex(-BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 2);
    expect(bandPaletteIndex(-2 * BAND_HEIGHT - 1)).toBe(SEABED_DEPTH_STOPS - 1);
    expect(bandPaletteIndex(-3 * BAND_HEIGHT - 1)).toBe(SEABED_DEPTH_STOPS - 1);
    expect(bandPaletteIndex(MIN_HEIGHT)).toBe(SEABED_DEPTH_STOPS - 1);
  });

  it('keeps every seabed stop below the land ramp', () => {
    for (let h = MIN_HEIGHT; h <= SEA_LEVEL; h++) {
      expect(bandPaletteIndex(h)).toBeLessThan(FIRST_LAND_PALETTE_INDEX);
    }
  });

  it('darkens the seabed with depth, so underwater terraces read apart', () => {
    // The owner-reported contrast (2026-08-14): through the water tint the
    // treads themselves must differ, strictly, at every stop.
    const luminance = ([r, g, b]: readonly [number, number, number]): number =>
      r + g + b;
    for (let stop = 1; stop < SEABED_DEPTH_STOPS; stop++) {
      expect(luminance(TERRAIN_PALETTE[stop])).toBeLessThan(
        luminance(TERRAIN_PALETTE[stop - 1]),
      );
    }
  });

  it('treats sea level itself as water, agreeing with shared isWater', () => {
    // THE case band arithmetic gets wrong: bandOf(0) is 0, a land band, but
    // shared defines isWater(h) as h <= SEA_LEVEL. A fresh world is entirely
    // zeros, so getting this backwards paints the whole map beach sand.
    expect(isWater(SEA_LEVEL)).toBe(true);
    expect(bandPaletteIndex(SEA_LEVEL)).toBe(SEABED_PALETTE_INDEX);
  });

  it('colours the dry remainder of band 0 as land', () => {
    // Band 0 straddles the waterline: 0 is sea, 1..BAND_HEIGHT-1 is beach.
    expect(bandPaletteIndex(1)).toBe(FIRST_LAND_PALETTE_INDEX);
    expect(bandPaletteIndex(BAND_HEIGHT - 1)).toBe(FIRST_LAND_PALETTE_INDEX);
  });

  it('advances one palette step per terrace band', () => {
    for (let band = 0; band <= LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX; band++) {
      // +1 so band 0 is sampled on its dry side; every other band is entirely
      // above water anyway.
      expect(bandPaletteIndex(band * BAND_HEIGHT + 1)).toBe(
        FIRST_LAND_PALETTE_INDEX + band,
      );
    }
  });

  it('clamps peaks above the ramp to the snow cap', () => {
    expect(bandPaletteIndex(MAX_HEIGHT)).toBe(LAST_PALETTE_INDEX);
    expect(bandPaletteIndex(MAX_HEIGHT * 10)).toBe(LAST_PALETTE_INDEX);
  });

  it('never leaves the palette, across the whole sculptable range', () => {
    for (let h = MIN_HEIGHT; h <= MAX_HEIGHT; h += 7) {
      const index = bandPaletteIndex(h);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(LAST_PALETTE_INDEX);
    }
  });

  it('is monotonic in height above sea level', () => {
    let previous = -1;
    for (let h = 0; h <= MAX_HEIGHT; h += 1) {
      const index = bandPaletteIndex(h);
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });

  it('changes colour only at a band edge or at the waterline', () => {
    // Colour steps must line up with the geometric terraces, or the ramp would
    // visibly slide against the steps. The single exception is the waterline
    // inside band 0, which is a material change (sea → beach) at a height
    // where the geometry does not step.
    for (let h = MIN_HEIGHT + 1; h <= MAX_HEIGHT; h++) {
      if (bandPaletteIndex(h) === bandPaletteIndex(h - 1)) continue;
      const atBandEdge = bandOf(h) !== bandOf(h - 1);
      const atWaterline = isWater(h - 1) && !isWater(h);
      expect(atBandEdge || atWaterline).toBe(true);
    }
  });

  it('puts the waterline colour change exactly at shared SEA_LEVEL', () => {
    expect(bandPaletteIndex(SEA_LEVEL)).toBe(SEABED_PALETTE_INDEX);
    expect(bandPaletteIndex(SEA_LEVEL + 1)).not.toBe(SEABED_PALETTE_INDEX);
  });
});

describe('bandColorOf', () => {
  it('returns the palette entry the index selects', () => {
    expect(bandColorOf(-1)).toBe(TERRAIN_PALETTE[SEABED_PALETTE_INDEX + 1]);
    expect(bandColorOf(0)).toBe(TERRAIN_PALETTE[SEABED_PALETTE_INDEX]);
    expect(bandColorOf(1)).toBe(TERRAIN_PALETTE[FIRST_LAND_PALETTE_INDEX]);
    expect(bandColorOf(MAX_HEIGHT)).toBe(TERRAIN_PALETTE[LAST_PALETTE_INDEX]);
  });

  it('paints a freshly generated world entirely as sea', () => {
    // Regression guard. A new world is an all-zero Int16Array and every cell
    // is water by shared's definition; an earlier band-sign test rendered the
    // whole thing as beach sand instead.
    expect(bandColorOf(0)).toBe(TERRAIN_PALETTE[SEABED_PALETTE_INDEX]);
  });
});
