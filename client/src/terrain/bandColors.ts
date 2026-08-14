// Height-based terrace colour ramp. Pure — no Three.js, no DOM.
//
// Split into "which palette entry" (bandPaletteIndex) and "the palette itself"
// so the renderer can pre-convert the palette to Three's linear working colour
// space ONCE at start-up and then select per vertex with a plain array index.
// Without that split the renderer would either repeat the selection logic or
// run an sRGB→linear pow() per vertex per patch.

import { MAX_HEIGHT, bandOf, isWater } from '@terrace/shared';

/** Colour components in the 0..1 range. Interpreted as sRGB. */
export type Rgb = readonly [r: number, g: number, b: number];

/** 0xRRGGBB → normalised triple. Keeps the palette readable as hex. */
function rgb(hex: number): Rgb {
  return [((hex >> 16) & 0xff) / 0xff, ((hex >> 8) & 0xff) / 0xff, (hex & 0xff) / 0xff];
}

/**
 * Palette index 0 is the seabed — everything at or below SEA_LEVEL, seen
 * through the translucent water plane. Indices 1..N are the land ramp, one
 * step per terrace band starting at band 0 (the first band above sea level).
 */
export const SEABED_PALETTE_INDEX = 0;
export const FIRST_LAND_PALETTE_INDEX = 1;

/**
 * The ramp. Eight land stops: sand at the shoreline, grass, rock, then
 * snowcap. Bands at or above the last stop all render as snow — a band-7 peak
 * is already 448 height units of relief, unambiguously a mountain top, so
 * there is nothing above it that needs its own colour.
 */
export const TERRAIN_PALETTE: readonly Rgb[] = [
  rgb(0x4a5f52), // 0 seabed
  rgb(0xd9c89a), // 1 band 0 — beach sand at the waterline
  rgb(0x7fae52), // 2 band 1 — bright lowland grass
  rgb(0x689a45), // 3 band 2 — grass
  rgb(0x52863b), // 4 band 3 — highland grass
  rgb(0x7d7a6e), // 5 band 4 — exposed rock
  rgb(0x8f8c82), // 6 band 5 — rock
  rgb(0xa8a49a), // 7 band 6 — pale high rock
  rgb(0xf2f4f6), // 8 band 7+ — snow
];

/** Highest valid index; bands beyond the ramp clamp here. */
export const LAST_PALETTE_INDEX = TERRAIN_PALETTE.length - 1;

/**
 * Palette index for a RAW (un-quantised) height.
 *
 * The water test is shared's own `isWater` (h <= SEA_LEVEL), NOT `bandOf(h) <
 * 0`. Those two disagree at exactly one height and it is the most common one
 * in the world: band 0 spans h ∈ [0, 63], which straddles the waterline —
 * h = 0 is water, h = 1..63 is dry land. Using the band sign would colour a
 * freshly generated world (every cell at 0, and therefore entirely water by
 * the shared model) as solid beach sand.
 *
 * This must be fed the raw height rather than the quantised one, because
 * quantisation destroys exactly the distinction being made here:
 * quantizeToBand(1) === 0, so a quantised input would call dry land water.
 */
export function bandPaletteIndex(height: number): number {
  if (isWater(height)) return SEABED_PALETTE_INDEX;
  const index = FIRST_LAND_PALETTE_INDEX + bandOf(height);
  return index > LAST_PALETTE_INDEX ? LAST_PALETTE_INDEX : index;
}

/** Convenience for tests and any non-rendering consumer. */
export function bandColorOf(height: number): Rgb {
  return TERRAIN_PALETTE[bandPaletteIndex(height)];
}

/** Bands the ramp covers explicitly, i.e. before snow clamping kicks in. */
export const RAMP_BAND_COUNT = LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX;

/** Sanity bound used by tests: the tallest possible peak's band. */
export const MAX_BAND = bandOf(MAX_HEIGHT);
