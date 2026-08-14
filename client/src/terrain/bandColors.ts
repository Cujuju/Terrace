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

// ---------------------------------------------------------------------------
// Cliff faces
//
// Terraced rendering draws VERTICAL skirts between bands — one band tall, along
// each band's smoothed outline (terrain/vertexGrid.ts). It also uses this ramp
// for the fine step at the waterline and for the per-cell walls of the blocky
// fallback, so "cliff" here means every cut face, whatever drew it.
// Painting those faces with the top-face colour makes a cliff read as stretched
// grass; what the Godus look needs is exposed rock — the same ground, but CUT.
// So every palette entry gets a derived cliff entry: pulled toward bare rock,
// then darkened. Both moves are needed. Darkening alone keeps the grass hue and
// just reads as shadow; tinting alone keeps a snow cliff as bright as the snow
// above it and the crease disappears.
// ---------------------------------------------------------------------------

/**
 * The bare-rock colour every cliff face is pulled toward: damp cut earth. One
 * shared hue across the whole ramp is what makes cliffs read as one material —
 * the rock under a meadow and the rock under a snowfield are the same rock.
 */
const CLIFF_ROCK_TINT: Rgb = rgb(0x6b5a49);

/**
 * How much of that rock hue replaces the band's own colour. 0.4 keeps enough
 * of the band to tell which terrace a cliff belongs to (a sand cliff is still
 * sandy, a snow cliff still cold) while committing the face to rock.
 */
export const CLIFF_ROCK_TINT_MIX = 0.4;

/**
 * Brightness the tinted face keeps. 0.68 rather than something heavier because
 * the lighting rig already does part of the work: the sun is high (see
 * render/scene.ts) so a vertical face receives markedly less of it than a
 * tread, and two cliff orientations out of four get no direct sun at all.
 * Multiplying those by a harsh factor as well would crush them to black.
 */
export const CLIFF_FACE_DARKEN_FACTOR = 0.68;

/** Tint toward rock, then darken — the derivation described above. */
export function cliffFaceColor(top: Rgb): Rgb {
  const mix = (channel: number, tint: number): number =>
    (channel * (1 - CLIFF_ROCK_TINT_MIX) + tint * CLIFF_ROCK_TINT_MIX) *
    CLIFF_FACE_DARKEN_FACTOR;
  return [
    mix(top[0], CLIFF_ROCK_TINT[0]),
    mix(top[1], CLIFF_ROCK_TINT[1]),
    mix(top[2], CLIFF_ROCK_TINT[2]),
  ];
}

/**
 * The cliff ramp, index-for-index with TERRAIN_PALETTE so a wall can be looked
 * up with the very same `bandPaletteIndex` the tread above it used. Derived
 * once at module load; the renderer converts it to linear alongside the top
 * palette, so no per-vertex colour maths happens on the patch path.
 */
export const CLIFF_PALETTE: readonly Rgb[] = TERRAIN_PALETTE.map(cliffFaceColor);

/** Bands the ramp covers explicitly, i.e. before snow clamping kicks in. */
export const RAMP_BAND_COUNT = LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX;

/** Sanity bound used by tests: the tallest possible peak's band. */
export const MAX_BAND = bandOf(MAX_HEIGHT);
