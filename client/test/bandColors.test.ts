import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  DEEP_STRATA_BANDS,
  MAX_HEIGHT,
  MIN_HEIGHT,
  SEA_COLUMN_BANDS,
  SEA_LEVEL,
  bandOf,
  isWater,
} from '@terrace/shared';
import { ORDINARY_SEA_DEPTH_BANDS } from '../src/config.ts';
import {
  BLUE_SEABED_STOPS,
  CLIFF_PALETTE,
  FIRST_BASALT_STOP,
  FIRST_LAND_PALETTE_INDEX,
  LAST_PALETTE_INDEX,
  FIRST_LAVA_STOP,
  LAND_RAMP_ANCHORS,
  MIN_LAND_ANCHOR_LUMINANCE_GAP,
  SEABED_DEPTH_STOPS,
  SEABED_PALETTE_INDEX,
  TERRAIN_PALETTE,
  bandColorOf,
  type Rgb,
  bandPaletteIndex,
  isEmissivePaletteIndex,
  seabedRiserFaceColor,
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
  it('steps one seabed stop per band of depth, all the way to MIN_HEIGHT', () => {
    expect(bandPaletteIndex(SEA_LEVEL)).toBe(SEABED_PALETTE_INDEX);
    expect(bandPaletteIndex(SEA_LEVEL - 1)).toBe(SEABED_PALETTE_INDEX + 1);
    expect(bandPaletteIndex(-BAND_HEIGHT)).toBe(SEABED_PALETTE_INDEX + 1);
    expect(bandPaletteIndex(-BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 2);
    expect(bandPaletteIndex(-2 * BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 3);
    expect(bandPaletteIndex(-3 * BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 4);
    expect(bandPaletteIndex(-15 * BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 16);
    expect(bandPaletteIndex(MIN_HEIGHT)).toBe(SEABED_DEPTH_STOPS - 1);
    expect(SEABED_DEPTH_STOPS - 1).toBeGreaterThanOrEqual(FIRST_LAVA_STOP);
  });

  it('keeps every seabed stop below the land ramp', () => {
    for (let h = MIN_HEIGHT; h <= SEA_LEVEL; h++) {
      expect(bandPaletteIndex(h)).toBeLessThan(FIRST_LAND_PALETTE_INDEX);
    }
  });

  it('keeps adjacent land MATERIALS a visible luminance gap apart', () => {
    const luminance = ([r, g, b]: readonly [number, number, number]): number =>
      r + g + b;
    for (let i = 1; i < LAND_RAMP_ANCHORS.length; i++) {
      expect(
        Math.abs(
          luminance(LAND_RAMP_ANCHORS[i][1]) - luminance(LAND_RAMP_ANCHORS[i - 1][1]),
        ),
      ).toBeGreaterThanOrEqual(MIN_LAND_ANCHOR_LUMINANCE_GAP);
    }
  });

  it('interpolates between land materials instead of holding them flat', () => {
    for (let i = FIRST_LAND_PALETTE_INDEX + 1; i <= LAST_PALETTE_INDEX; i++) {
      expect(TERRAIN_PALETTE[i]).not.toEqual(TERRAIN_PALETTE[i - 1]);
    }
  });

  it('lands every material anchor exactly on a band floor', () => {
    for (const [height] of LAND_RAMP_ANCHORS) {
      expect(height % BAND_HEIGHT).toBe(0);
    }
  });

  it('lightens each underwater riser face over its own tread, and nothing more (owner, 2026-08-19)', () => {
    const luminance = ([r, g, b]: readonly [number, number, number]): number =>
      r + g + b;
    for (let stop = 0; stop < SEABED_DEPTH_STOPS; stop++) {
      expect(luminance(CLIFF_PALETTE[stop])).toBeGreaterThan(
        luminance(TERRAIN_PALETTE[stop]),
      );
      const derived = seabedRiserFaceColor(TERRAIN_PALETTE[stop]);
      expect(CLIFF_PALETTE[stop][0]).toBeCloseTo(derived[0], 10);
      expect(CLIFF_PALETTE[stop][1]).toBeCloseTo(derived[1], 10);
      expect(CLIFF_PALETTE[stop][2]).toBeCloseTo(derived[2], 10);
    }
    for (let i = FIRST_LAND_PALETTE_INDEX; i <= LAST_PALETTE_INDEX; i++) {
      expect(luminance(CLIFF_PALETTE[i])).toBeLessThan(
        luminance(TERRAIN_PALETTE[i]),
      );
    }
  });

  it('keeps underwater riser faces darkening with depth, like the treads they represent', () => {
    const luminance = ([r, g, b]: readonly [number, number, number]): number =>
      r + g + b;
    for (let stop = 1; stop < BLUE_SEABED_STOPS; stop++) {
      expect(luminance(CLIFF_PALETTE[stop])).toBeLessThan(
        luminance(CLIFF_PALETTE[stop - 1]),
      );
    }
    for (let stop = FIRST_BASALT_STOP + 1; stop < FIRST_LAVA_STOP; stop++) {
      expect(luminance(CLIFF_PALETTE[stop])).toBeLessThan(
        luminance(CLIFF_PALETTE[stop - 1]),
      );
    }
  });

  it('darkens the seabed with depth, so underwater terraces read apart', () => {
    const luminance = ([r, g, b]: readonly [number, number, number]): number =>
      r + g + b;
    for (let stop = 1; stop < BLUE_SEABED_STOPS; stop++) {
      expect(luminance(TERRAIN_PALETTE[stop])).toBeLessThan(
        luminance(TERRAIN_PALETTE[stop - 1]),
      );
    }
  });

  it('breaks regime at the crust, darkens through it, and glows at the floor (Deep Strata)', () => {
    const luminance = ([r, g, b]: readonly [number, number, number]): number =>
      r + g + b;
    expect(luminance(TERRAIN_PALETTE[FIRST_BASALT_STOP])).toBeGreaterThan(
      luminance(TERRAIN_PALETTE[BLUE_SEABED_STOPS - 1]),
    );
    for (let stop = FIRST_BASALT_STOP + 1; stop < FIRST_LAVA_STOP; stop++) {
      expect(luminance(TERRAIN_PALETTE[stop])).toBeLessThan(
        luminance(TERRAIN_PALETTE[stop - 1]),
      );
    }
    for (let stop = FIRST_LAVA_STOP; stop < SEABED_DEPTH_STOPS; stop++) {
      expect(isEmissivePaletteIndex(stop)).toBe(true);
      expect(TERRAIN_PALETTE[stop]).toEqual(TERRAIN_PALETTE[FIRST_LAVA_STOP]);
    }
    for (let stop = 0; stop < FIRST_LAVA_STOP; stop++) {
      expect(luminance(TERRAIN_PALETTE[FIRST_LAVA_STOP])).toBeGreaterThan(
        luminance(TERRAIN_PALETTE[stop]),
      );
      expect(isEmissivePaletteIndex(stop)).toBe(false);
    }
    expect(isEmissivePaletteIndex(FIRST_LAND_PALETTE_INDEX)).toBe(false);
    expect(isEmissivePaletteIndex(LAST_PALETTE_INDEX)).toBe(false);
    expect(SEABED_DEPTH_STOPS).toBe(BLUE_SEABED_STOPS + DEEP_STRATA_BANDS);
    expect(bandPaletteIndex(MIN_HEIGHT)).toBe(SEABED_DEPTH_STOPS - 1);
    expect(bandPaletteIndex(-SEA_COLUMN_BANDS * BAND_HEIGHT - 1)).toBe(
      FIRST_BASALT_STOP,
    );
  });

  it('treats sea level itself as water, agreeing with shared isWater', () => {
    expect(isWater(SEA_LEVEL)).toBe(true);
    expect(bandPaletteIndex(SEA_LEVEL)).toBe(SEABED_PALETTE_INDEX);
  });

  it('colours the dry remainder of band 0 as land', () => {
    expect(bandPaletteIndex(1)).toBe(FIRST_LAND_PALETTE_INDEX);
    expect(bandPaletteIndex(BAND_HEIGHT - 1)).toBe(FIRST_LAND_PALETTE_INDEX);
  });

  it('advances one palette step per terrace band', () => {
    for (let band = 0; band <= LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX; band++) {
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

describe('the 8-bit vertex format the ramp is stored in (2026-08-20)', () => {
  const toByte = (channel: number): number => Math.round(channel * 255);
  const linear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  const bytes = (entry: Rgb, encode: (c: number) => number): number[] =>
    [0, 1, 2].map((ch) => toByte(encode(entry[ch])));
  const sum = (v: number[]): number => v[0] + v[1] + v[2];

  it('keeps the depth ramp strictly darkening after sRGB quantisation', () => {
    for (let stop = 1; stop <= ORDINARY_SEA_DEPTH_BANDS; stop++) {
      expect(sum(bytes(TERRAIN_PALETTE[stop], (c) => c))).toBeLessThan(
        sum(bytes(TERRAIN_PALETTE[stop - 1], (c) => c)),
      );
    }
    for (let stop = ORDINARY_SEA_DEPTH_BANDS + 1; stop < BLUE_SEABED_STOPS; stop++) {
      expect(sum(bytes(TERRAIN_PALETTE[stop], (c) => c))).toBeLessThanOrEqual(
        sum(bytes(TERRAIN_PALETTE[stop - 1], (c) => c)),
      );
    }
    for (let stop = FIRST_BASALT_STOP + 1; stop < FIRST_LAVA_STOP; stop++) {
      expect(sum(bytes(TERRAIN_PALETTE[stop], (c) => c))).toBeLessThan(
        sum(bytes(TERRAIN_PALETTE[stop - 1], (c) => c)),
      );
    }
  });

  it('would LOSE that ramp if the bytes were linear instead — which is why they are not', () => {
    let linearTies = 0;
    for (let stop = 1; stop < BLUE_SEABED_STOPS; stop++) {
      const here = bytes(TERRAIN_PALETTE[stop], linear);
      const above = bytes(TERRAIN_PALETTE[stop - 1], linear);
      if (here.every((v, ch) => v === above[ch])) linearTies++;
    }
    expect(linearTies).toBeGreaterThan(BLUE_SEABED_STOPS / 4);
  });

  it('gives every land stop its own byte triple too', () => {
    for (let i = FIRST_LAND_PALETTE_INDEX + 1; i <= LAST_PALETTE_INDEX; i++) {
      expect(bytes(TERRAIN_PALETTE[i], (c) => c)).not.toEqual(
        bytes(TERRAIN_PALETTE[i - 1], (c) => c),
      );
    }
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
    expect(bandColorOf(0)).toBe(TERRAIN_PALETTE[SEABED_PALETTE_INDEX]);
  });
});
