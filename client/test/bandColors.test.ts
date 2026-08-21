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
    // The flats (h = 0) are stop 0; each band down takes the next stop —
    // mirroring how the dry side steps at band edges. Since the 2026-08-19
    // full-column ramp, no two depths share a stop; since Deep Strata (same
    // day) the ladder continues past the blue column through basalt and
    // obsidian to the lava floor at band −24, whose floor IS MIN_HEIGHT, so
    // the deepest stop is reached exactly and the clamp guards nothing
    // in-range (a belt against a future MIN_HEIGHT change, not behaviour).
    expect(bandPaletteIndex(SEA_LEVEL)).toBe(SEABED_PALETTE_INDEX);
    expect(bandPaletteIndex(SEA_LEVEL - 1)).toBe(SEABED_PALETTE_INDEX + 1);
    expect(bandPaletteIndex(-BAND_HEIGHT)).toBe(SEABED_PALETTE_INDEX + 1);
    expect(bandPaletteIndex(-BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 2);
    expect(bandPaletteIndex(-2 * BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 3);
    expect(bandPaletteIndex(-3 * BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 4);
    expect(bandPaletteIndex(-15 * BAND_HEIGHT - 1)).toBe(SEABED_PALETTE_INDEX + 16);
    expect(bandPaletteIndex(MIN_HEIGHT)).toBe(SEABED_DEPTH_STOPS - 1);
    // The floor is the BOTTOM lava stop. Lava is a stratum DEPTH, so at a
    // finer BAND_HEIGHT it spans several stops and the world's floor is the
    // last of them, not the first.
    expect(SEABED_DEPTH_STOPS - 1).toBeGreaterThanOrEqual(FIRST_LAVA_STOP);
  });

  it('keeps every seabed stop below the land ramp', () => {
    for (let h = MIN_HEIGHT; h <= SEA_LEVEL; h++) {
      expect(bandPaletteIndex(h)).toBeLessThan(FIRST_LAND_PALETTE_INDEX);
    }
  });

  it('keeps adjacent land MATERIALS a visible luminance gap apart', () => {
    // The above-ground half of the same owner-reported contrast: every land
    // material must differ from its neighbour by at least the named gap, in
    // EITHER direction — the ramp's shape (bright sand, darkening grass,
    // rock climbing to snow) is not the contract; the gap is.
    //
    // AN ANCHOR CONTRACT SINCE 2026-08-20 (owner chose the interpolated ramp):
    // it used to be pinned stop-to-stop, which only worked while one stop WAS
    // one material. With four times the bands, adjacent stops are a quarter of
    // a material apart and the gap lives between the anchors instead.
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
    // The other half of the same decision: no two adjacent land stops may be
    // identical, or the finer terracing would buy geometry without colour and
    // a mountainside would band into visible plateaus again.
    for (let i = FIRST_LAND_PALETTE_INDEX + 1; i <= LAST_PALETTE_INDEX; i++) {
      expect(TERRAIN_PALETTE[i]).not.toEqual(TERRAIN_PALETTE[i - 1]);
    }
  });

  it('lands every material anchor exactly on a band floor', () => {
    // The anchors are stated in HEIGHT UNITS; the stops are sampled at band
    // floors. If an anchor fell between two floors its colour would never
    // actually be rendered — the material would be a colour the world cannot
    // show. Exact today for every stratum; this is the guard for a future
    // BAND_HEIGHT that stops dividing the stack evenly.
    for (const [height] of LAND_RAMP_ANCHORS) {
      expect(height % BAND_HEIGHT).toBe(0);
    }
  });

  it('lightens each underwater riser face over its own tread, and nothing more (owner, 2026-08-19)', () => {
    // Supersedes the 2026-08-14 "rim brighter than both treads" pin: the
    // silt-aqua outline gave way to faces that are "roughly the same color as
    // the level they represent, but slightly lightened" — the seam line moved
    // into the geometry (capEmission.ts's top-edge border sliver). So each
    // seabed cliff entry must sit ABOVE its own tread ("lightened") and track
    // the exact derivation ("the same color") — while land cliffs keep
    // darkening, as ever. The waterline still splits the regimes.
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
    // "Roughly the same color as the level" also means the faces inherit the
    // depth ramp: strictly darker at every stop, so the side of a deep
    // terrace can never outshine the side of a shallow one. Since Deep Strata
    // the contract holds PER REGIME — within the blue column, and within the
    // rock below it — because the blue→basalt boundary is a deliberate
    // brightness break and the lava face glows (see the tread test below).
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
    // The owner-reported contrast (2026-08-14): through the water tint the
    // treads themselves must differ, strictly, at every stop — within the
    // blue column. Deep Strata ended the column at band −16; the crust below
    // gets its own regime, pinned in the next test.
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
    // The regime break: the first basalt stop is BRIGHTER than the blue floor
    // above it — breaking through the seabed must read as a material change,
    // not as more darkness.
    expect(luminance(TERRAIN_PALETTE[FIRST_BASALT_STOP])).toBeGreaterThan(
      luminance(TERRAIN_PALETTE[BLUE_SEABED_STOPS - 1]),
    );
    // Within the rock the strict descent resumes: basalt darkens into
    // obsidian, ending at the darkest material in the game.
    for (let stop = FIRST_BASALT_STOP + 1; stop < FIRST_LAVA_STOP; stop++) {
      expect(luminance(TERRAIN_PALETTE[stop])).toBeLessThan(
        luminance(TERRAIN_PALETTE[stop - 1]),
      );
    }
    // The lava floor is the brightest thing under the sea, full stop — it is
    // the palette's one light source and is rendered self-lit.
    for (let stop = FIRST_LAVA_STOP; stop < SEABED_DEPTH_STOPS; stop++) {
      expect(isEmissivePaletteIndex(stop)).toBe(true);
      // Every lava stop is the same glow: the floor is a light, not a ramp.
      expect(TERRAIN_PALETTE[stop]).toEqual(TERRAIN_PALETTE[FIRST_LAVA_STOP]);
    }
    for (let stop = 0; stop < FIRST_LAVA_STOP; stop++) {
      expect(luminance(TERRAIN_PALETTE[FIRST_LAVA_STOP])).toBeGreaterThan(
        luminance(TERRAIN_PALETTE[stop]),
      );
      expect(isEmissivePaletteIndex(stop)).toBe(false);
    }
    // Land is lit by the scene, never self-lit — the glow is the floor's alone.
    expect(isEmissivePaletteIndex(FIRST_LAND_PALETTE_INDEX)).toBe(false);
    expect(isEmissivePaletteIndex(LAST_PALETTE_INDEX)).toBe(false);
    // The strata boundaries derive from shared's stack — the palette cannot
    // drift from the world model that defines it.
    expect(SEABED_DEPTH_STOPS).toBe(BLUE_SEABED_STOPS + DEEP_STRATA_BANDS);
    expect(bandPaletteIndex(MIN_HEIGHT)).toBe(SEABED_DEPTH_STOPS - 1);
    expect(bandPaletteIndex(-SEA_COLUMN_BANDS * BAND_HEIGHT - 1)).toBe(
      FIRST_BASALT_STOP,
    );
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

describe('the 8-bit vertex format the ramp is stored in (2026-08-20)', () => {
  // The terrain colour attribute is a byte per channel now, which is only safe
  // because the ramp is stored in the sRGB values it was AUTHORED in. These
  // tests are the reason that choice is not arbitrary — and the guard against
  // anyone "simplifying" it back to linear.
  const toByte = (channel: number): number => Math.round(channel * 255);
  const linear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  const bytes = (entry: Rgb, encode: (c: number) => number): number[] =>
    [0, 1, 2].map((ch) => toByte(encode(entry[ch])));
  const sum = (v: number[]): number => v[0] + v[1] + v[2];

  it('keeps the depth ramp strictly darkening after sRGB quantisation', () => {
    // THE CONTRACT THE FORMAT MUST NOT COST US. Every adjacent pair in the blue
    // column, and within the rock, must still fall once stored as bytes — the
    // float-level version of this is pinned above, and it would be worth
    // nothing if the buffer could not carry it.
    for (let stop = 1; stop < BLUE_SEABED_STOPS; stop++) {
      expect(sum(bytes(TERRAIN_PALETTE[stop], (c) => c))).toBeLessThan(
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
    // The measurement that decided the format, kept executable rather than
    // written in a comment. Storing the linear values (the obvious move, since
    // that is the space three works in) ties a large share of the deep column
    // into repeated colours: the abyssal tail steps by as little as 1/255 in
    // sRGB, and linear encoding crushes exactly that end toward zero.
    let linearTies = 0;
    for (let stop = 1; stop < BLUE_SEABED_STOPS; stop++) {
      const here = bytes(TERRAIN_PALETTE[stop], linear);
      const above = bytes(TERRAIN_PALETTE[stop - 1], linear);
      if (here.every((v, ch) => v === above[ch])) linearTies++;
    }
    // Not pinned to an exact count — the point is that it is a large fraction,
    // and that the sRGB path above has none at all.
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
    // Regression guard. A new world is an all-zero Int16Array and every cell
    // is water by shared's definition; an earlier band-sign test rendered the
    // whole thing as beach sand instead.
    expect(bandColorOf(0)).toBe(TERRAIN_PALETTE[SEABED_PALETTE_INDEX]);
  });
});
