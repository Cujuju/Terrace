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
 * Seabed stops — one per terrace band BELOW the waterline, darkening with
 * depth, before the land ramp begins (owner report, 2026-08-14: "we need more
 * contrast on the layers underneath the water because they're difficult to
 * see" — with a single seabed colour, underwater terraces differed only by
 * their cliff skirts, and through the water plane that all but vanished).
 *
 * FOUR stops because that is the world's own underwater anatomy: the h = 0
 * waterline flats, then the three genesis strata (shelf −1, ring −2, deep −3;
 * see the server's fresh-world genesis). Band −3 is also exactly where deep
 * water — monster habitat — begins, so everything at that depth and below
 * sharing the darkest stop is a statement, not a truncation: past the light,
 * the deep is one material.
 */
export const SEABED_DEPTH_STOPS = 4;

/**
 * Index 0 is the SHALLOWEST seabed (the h = 0 flats — also every cell of a
 * freshly created world); deeper bands take the next indices, then the land
 * ramp, one step per terrace band starting at band 0 (the first above sea).
 */
export const SEABED_PALETTE_INDEX = 0;
export const FIRST_LAND_PALETTE_INDEX = SEABED_DEPTH_STOPS;

/**
 * The ramp: four seabed depth stops, then ten land stops — sand and soil at
 * the shoreline, grass from band 3, rock, then snowcap. Bands at or above the
 * last stop all render as snow — a band-9 peak is already 576 height units of
 * relief, unambiguously a mountain top, so there is nothing above it that
 * needs its own colour.
 *
 * The seabed stops keep the established muddy-green family (the old single
 * seabed sat between today's 0 and 1) but step ~20% darker and bluer per
 * band, sized so the difference still reads through the translucent water
 * tint that compresses whatever contrast the treads have.
 */
export const TERRAIN_PALETTE: readonly Rgb[] = [
  rgb(0x6a7f68), // 0 seabed, waterline flats (h = 0)
  rgb(0x50705d), // 1 seabed, band −1 — the shelf
  rgb(0x3a5b52), // 2 seabed, band −2 — the ring
  rgb(0x274347), // 3 seabed, band −3 and deeper — deep water, monster country
  // Three sand-and-soil stops before any green (owner, 2026-08-14: "multiple
  // layers of sand and soil color near the water. Greener layers should start
  // higher up") — the coast reads as coast for two full terraces before
  // vegetation takes over at band 3.
  rgb(0xd9c89a), // 4 band 0 — wet beach sand at the waterline
  rgb(0xc0a468), // 5 band 1 — dry sand
  rgb(0x96774a), // 6 band 2 — bare soil
  rgb(0x8fc25a), // 7 band 3 — bright lowland grass
  rgb(0x69a244), // 8 band 4 — grass
  rgb(0x467a33), // 9 band 5 — dark highland grass
  rgb(0x736f61), // 10 band 6 — dark exposed rock
  rgb(0x908c80), // 11 band 7 — rock
  rgb(0xb3aea2), // 12 band 8 — pale high rock
  rgb(0xf2f4f6), // 13 band 9+ — snow
];

/**
 * Smallest summed-RGB luminance gap between ADJACENT land stops (owner,
 * 2026-08-14: "more contrast on the layers above ground as well" — the first
 * ramp's neighbours sat ~0.2 apart and adjacent terraces blurred together at
 * play distance). 0.3 is ~10% of the 0..3 scale: comfortably visible on a lit
 * tread, and holdable across the whole ramp without breaking the sand → grass
 * → rock → snow story. The land ramp is deliberately NOT monotonic (sand is
 * brighter than the grass above it; rock climbs back toward snow), so the gap
 * is the contract — direction is the palette's own business. Enforced by
 * test, so a future recolour cannot quietly blur two bands back together.
 */
export const MIN_ADJACENT_LAND_LUMINANCE_GAP = 0.3;

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
  if (isWater(height)) {
    // One stop per band of depth: bandOf(0) = 0 (the flats), bandOf(−1) = −1
    // (the shelf), and so on down; depths past the ramp clamp to the deepest
    // stop rather than wrapping into the land colours. `0 -` rather than the
    // unary minus so the flats index as +0, not -0 (equal as an index, but a
    // strict-equality landmine for every consumer that compares indices).
    const depth = 0 - bandOf(height);
    return depth >= SEABED_DEPTH_STOPS ? SEABED_DEPTH_STOPS - 1 : depth;
  }
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

// ---------------------------------------------------------------------------
// Seabed rims — the OPPOSITE derivation, and deliberately so (owner,
// 2026-08-14: "I can't see the outline seams of the layers against the
// reflection of the water. maybe ... a really slight border outline ...
// slightly a different colour"). On land, darkening a cut face works because
// the sun does too. Underwater every colour arrives pre-dimmed by the water
// tint, so a darkened seam is exactly what vanishes. A rim LIGHTER than both
// treads it separates — nudged toward a pale aqua, the colour depth actually
// silts an edge with — reads from above as a thin outline around each terrace,
// which is the requested border without any new geometry: the one-band cliff
// skirt already runs along precisely the seam being outlined.
// ---------------------------------------------------------------------------

/** The pale silt-aqua a seabed rim is pulled toward. */
const SEABED_RIM_TINT: Rgb = rgb(0x9fd4c8);

/**
 * How much of the rim tint replaces the tread colour. 0.55 keeps a residue of
 * the terrace's own colour (a deep rim still reads darker than a shelf rim)
 * while committing the face to the silt line.
 */
export const SEABED_RIM_TINT_MIX = 0.55;

/**
 * Brightness applied after the tint. Sized against the VIEWING GEOMETRY, not
 * just the treads: from the game's usual high camera a one-band skirt is a
 * few pixels of slanted sliver, dimmed twice — by the water tint and by the
 * lighting rig's weak side-light on vertical faces (first pass at 1.25 was
 * confirmed invisible from above, 2026-08-14). 1.5 with the deeper tint mix
 * pushes the rim to roughly double a shelf tread's luminance, which survives
 * both dimmings as a clear outline while the clamp keeps it short of white.
 */
export const SEABED_RIM_BRIGHTEN_FACTOR = 1.5;

/** Tint toward silt-aqua, then brighten — never past white. */
export function seabedRimColor(top: Rgb): Rgb {
  const mix = (channel: number, tint: number): number => {
    const lifted =
      (channel * (1 - SEABED_RIM_TINT_MIX) + tint * SEABED_RIM_TINT_MIX) *
      SEABED_RIM_BRIGHTEN_FACTOR;
    return lifted > 1 ? 1 : lifted;
  };
  return [
    mix(top[0], SEABED_RIM_TINT[0]),
    mix(top[1], SEABED_RIM_TINT[1]),
    mix(top[2], SEABED_RIM_TINT[2]),
  ];
}

/**
 * The cliff ramp, index-for-index with TERRAIN_PALETTE so a wall can be looked
 * up with the very same `bandPaletteIndex` the tread above it used. Seabed
 * entries take the rim derivation, land entries the rock one — the waterline
 * is the material boundary between the two regimes. Derived once at module
 * load; the renderer converts it to linear alongside the top palette, so no
 * per-vertex colour maths happens on the patch path.
 */
export const CLIFF_PALETTE: readonly Rgb[] = TERRAIN_PALETTE.map((top, index) =>
  index < SEABED_DEPTH_STOPS ? seabedRimColor(top) : cliffFaceColor(top),
);

/** Bands the ramp covers explicitly, i.e. before snow clamping kicks in. */
export const RAMP_BAND_COUNT = LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX;

/** Sanity bound used by tests: the tallest possible peak's band. */
export const MAX_BAND = bandOf(MAX_HEIGHT);
