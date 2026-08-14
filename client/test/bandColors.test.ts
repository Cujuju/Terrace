import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL, bandOf } from '@terrace/shared';
import {
  FIRST_LAND_PALETTE_INDEX,
  LAST_PALETTE_INDEX,
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
  it('maps everything at or below sea level to the seabed', () => {
    expect(bandPaletteIndex(SEA_LEVEL - 1)).toBe(SEABED_PALETTE_INDEX);
    expect(bandPaletteIndex(-BAND_HEIGHT)).toBe(SEABED_PALETTE_INDEX);
    expect(bandPaletteIndex(MIN_HEIGHT)).toBe(SEABED_PALETTE_INDEX);
  });

  it('puts the first band above sea level on the first land colour', () => {
    // bandOf(0) is 0, the first land band — sea level itself is dry ground's
    // floor, matching shared's isWater(h) = h <= SEA_LEVEL boundary.
    expect(bandPaletteIndex(SEA_LEVEL)).toBe(FIRST_LAND_PALETTE_INDEX);
    expect(bandPaletteIndex(BAND_HEIGHT - 1)).toBe(FIRST_LAND_PALETTE_INDEX);
  });

  it('advances one palette step per terrace band', () => {
    for (let band = 0; band <= LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX; band++) {
      expect(bandPaletteIndex(band * BAND_HEIGHT)).toBe(
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

  it('agrees with shared bandOf about where the band boundaries are', () => {
    // A colour change must coincide exactly with a band change, otherwise the
    // colour steps and the geometric terraces would be offset from each other.
    for (let h = 1; h <= MAX_HEIGHT; h++) {
      const colourChanged = bandPaletteIndex(h) !== bandPaletteIndex(h - 1);
      const bandChanged = bandOf(h) !== bandOf(h - 1);
      if (colourChanged) expect(bandChanged).toBe(true);
    }
  });
});

describe('bandColorOf', () => {
  it('returns the palette entry the index selects', () => {
    expect(bandColorOf(-1)).toBe(TERRAIN_PALETTE[SEABED_PALETTE_INDEX]);
    expect(bandColorOf(0)).toBe(TERRAIN_PALETTE[FIRST_LAND_PALETTE_INDEX]);
    expect(bandColorOf(MAX_HEIGHT)).toBe(TERRAIN_PALETTE[LAST_PALETTE_INDEX]);
  });
});
