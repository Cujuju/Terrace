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
 *
 * AMENDMENT (owner request, 2026-08-19: "the sea bottom to get progressively
 * darker as you go down the layers until it ends in a very dark blue"). The
 * four-stop truncation above is superseded: the ramp now runs the FULL water
 * column — seventeen stops, one per band from the h = 0 flats (band 0) down
 * to band −16 at MIN_HEIGHT — so no two depths share a colour and the descent
 * ends in a very dark blue rather than plateauing at the old deep-water stop.
 * The first four stops are unchanged (waterline, shelf, ring, and the old
 * deep stop, which is now simply band −3's own), so worlds that never dig
 * past genesis depth render exactly as before this change.
 */
export const SEABED_DEPTH_STOPS = 17;

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
 * The shallow seabed stops keep the established muddy-green family (the old
 * single seabed sat between today's 0 and 1) and step ~20% darker and bluer
 * per band, sized so the difference still reads through the translucent
 * water tint that compresses whatever contrast the treads have. Below the
 * genesis strata the descent continues to MIN_HEIGHT with two properties,
 * both judged through the water plane rather than on the raw swatches:
 *
 *   * luminance falls STRICTLY at every stop (the depth-contrast contract,
 *     pinned by test), front-loaded — bigger steps through the bands a
 *     worldgen ocean actually shows (−4..−8, the deepest genesis floor is
 *     ~band −8), smaller steps in the abyssal tail a player has to dig for,
 *     because equal dark-end steps read as nothing through the tint;
 *   * the hue crosses from the shallow muddy-teal to BLUE-dominant (b > g
 *     from band −3 down), ending at 0x030813 — the requested very dark blue,
 *     kept a hair above black so the self-lit silt rims still have a tread
 *     to outline rather than a void.
 */
export const TERRAIN_PALETTE: readonly Rgb[] = [
  rgb(0x6a7f68), // 0 seabed, waterline flats (h = 0)
  rgb(0x50705d), // 1 seabed, band −1 — the shelf
  rgb(0x3a5b52), // 2 seabed, band −2 — the ring
  rgb(0x274347), // 3 seabed, band −3 — deep water begins, monster country
  rgb(0x1f3a44), // 4 seabed, band −4
  rgb(0x183243), // 5 seabed, band −5
  rgb(0x122a40), // 6 seabed, band −6
  rgb(0x0d233c), // 7 seabed, band −7
  rgb(0x0a1d37), // 8 seabed, band −8 — the deepest a genesis ocean reaches
  rgb(0x081931), // 9 seabed, band −9
  rgb(0x07152b), // 10 seabed, band −10
  rgb(0x061226), // 11 seabed, band −11
  rgb(0x050f21), // 12 seabed, band −12
  rgb(0x040d1d), // 13 seabed, band −13
  rgb(0x040b19), // 14 seabed, band −14
  rgb(0x030916), // 15 seabed, band −15
  rgb(0x030813), // 16 seabed, band −16 (MIN_HEIGHT) — the very dark blue
  // Three sand-and-soil stops before any green (owner, 2026-08-14: "multiple
  // layers of sand and soil color near the water. Greener layers should start
  // higher up") — the coast reads as coast for two full terraces before
  // vegetation takes over at band 3.
  rgb(0xd9c89a), // 17 band 0 — wet beach sand at the waterline
  rgb(0xc0a468), // 18 band 1 — dry sand
  rgb(0x96774a), // 19 band 2 — bare soil
  rgb(0x8fc25a), // 20 band 3 — bright lowland grass
  rgb(0x69a244), // 21 band 4 — grass
  rgb(0x467a33), // 22 band 5 — dark highland grass
  rgb(0x736f61), // 23 band 6 — dark exposed rock
  rgb(0x908c80), // 24 band 7 — rock
  rgb(0xb3aea2), // 25 band 8 — pale high rock
  rgb(0xf2f4f6), // 26 band 9+ — snow
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

/**
 * True for the palette indices BELOW the waterline — the seabed regime.
 *
 * The waterline is the material boundary this module is organised around, and
 * three decisions hang off it: which derivation a cut face takes (rim or rock,
 * below), and — because a rim is an OUTLINE rather than a lit surface —
 * whether the geometry builder flags that face SELF-LIT and whether the
 * renderer draws it that way (terrain/vertexGrid.ts, render/terrainMeshes.ts).
 * One predicate, so those three cannot drift apart.
 */
export function isSeabedPaletteIndex(index: number): boolean {
  return index < SEABED_DEPTH_STOPS;
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
 * Brightness the tinted face keeps. The lighting rig already does part of the
 * work — a vertical face receives less sun than a tread — so this factor only
 * needs to state "cut earth is a little darker than the ground above it".
 * 0.68 was tuned against the old 2.2-intensity sun and, stacked on the rig's
 * own side-light falloff, crushed shadow-side cliffs to black (owner,
 * 2026-08-14: "too much shadow. The world is too dark"). 0.78 is the lightest
 * value that still clears the "visibly darker than the tread" contract
 * (vertexGrid.test.ts pins every land cliff below 0.85× its tread's
 * luminance, and the darkest grass stop is the binding case) under the
 * rebalanced fill-led rig in scene.ts.
 */
export const CLIFF_FACE_DARKEN_FACTOR = 0.78;

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
//
// AND THE PALETTE IS ONLY HALF OF IT (owner, 2026-08-14, second report with a
// low-angle screenshot: the rims read from overhead and disappear from a low
// camera). A rim face is VERTICAL, and the terrain material is lit by one
// directional sun plus a hemisphere fill, so the two skirt orientations facing
// away from the sun receive almost no direct light and render dark no matter
// how bright their vertex colour is. That is a LIGHTING dependence, and no
// palette value can remove it: brightening further would only scale a number
// that is about to be multiplied by ~0.15 on half the faces and ~1.0 on the
// other half, so the rim would still read as four different lines depending on
// which way the terrace happens to turn.
//
// So a seabed rim is drawn SELF-LIT — its rendered colour is exactly the entry
// below, before any light touches it (render/terrainMeshes.ts patches the
// terrain material to do this for flagged vertices only; land cliffs keep the
// lit look, which is correct for them because a cliff IS a surface). Two
// consequences worth stating: the factors below are now judged against the
// colour that actually reaches the screen rather than against a guess at how
// much light a sliver catches, and a future change to the lighting rig can no
// longer make the outlines vanish again.
//
// AMENDMENT (owner, 2026-08-19, after the depth ramp landed): the whole-face
// silt-aqua rim above is SUPERSEDED. With every band now carrying its own
// depth colour, a uniform bright rim on the full riser fought the ramp — the
// side walls read as one glowing material at every depth. The owner's spec:
// "the sidebands for the terrain in the water need to be roughly the same
// color as the level they represent, but slightly lightened, and ... a single
// one pixel border at the top edge of that band ... the same color as the
// next layer down." So an underwater riser FACE is now its own band's tread
// nudged toward white (seabedRiserFaceColor below) — risers darken with depth
// alongside their treads — and the thin top-edge border (a geometry sliver,
// capEmission.ts) takes the NEXT BAND DOWN's tread colour straight from
// TERRAIN_PALETTE, no derivation of its own. The SELF-LIT decision above is
// KEPT and matters more, not less: the face must track its tread on all four
// orientations, which a sun-lit vertical face cannot do. seabedRimColor and
// its factors remain below, unreferenced, as the record of the 2026-08-14
// treatment this replaces.
// ---------------------------------------------------------------------------

/**
 * How far an underwater riser face is nudged toward white over its own tread
 * (owner, 2026-08-19: "roughly the same color as the level they represent,
 * but slightly lightened").
 *
 * A LERP TOWARD WHITE rather than a multiplicative brighten, deliberately:
 * the deep half of the ramp lives near black (band −16 is 0x030813), where a
 * multiplier changes nothing a screen can show — lerping adds a floor of
 * lift that survives the abyss AND the translucent water tint over it. 0.16
 * keeps the face unmistakably "the same colour as the level": the lift is
 * smaller than the ramp's own step between adjacent bands at the shallow end,
 * so a riser never reads brighter than the tread one band up.
 */
export const SEABED_RISER_LIGHTEN_MIX = 0.16;

/** The band's own tread, slightly lightened — the underwater riser face. */
export function seabedRiserFaceColor(top: Rgb): Rgb {
  const lift = (channel: number): number =>
    channel + (1 - channel) * SEABED_RISER_LIGHTEN_MIX;
  return [lift(top[0]), lift(top[1]), lift(top[2])];
}

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
 * few pixels of slanted sliver, dimmed by the translucent water tint over it
 * (first pass at 1.25 was confirmed invisible from above, 2026-08-14). 1.5
 * with the deeper tint mix pushes the rim to roughly double a shelf tread's
 * luminance, which survives that dimming as a clear outline while the clamp
 * keeps it short of white.
 *
 * The rig's weak side-light on vertical faces WAS the second dimming this
 * factor had to cover, and it no longer is: a rim is self-lit (see the section
 * header), so this factor now describes the colour that reaches the screen
 * rather than an input to a light calculation that varies per orientation.
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
 * entries take the lightened-tread riser derivation (owner, 2026-08-19 — see
 * the amendment above; they took the silt-aqua rim before that), land entries
 * the rock one — the waterline is the material boundary between the two
 * regimes. Derived once at module load; the renderer converts it to linear
 * alongside the top palette, so no per-vertex colour maths happens on the
 * patch path.
 */
export const CLIFF_PALETTE: readonly Rgb[] = TERRAIN_PALETTE.map((top, index) =>
  isSeabedPaletteIndex(index) ? seabedRiserFaceColor(top) : cliffFaceColor(top),
);

/** Bands the ramp covers explicitly, i.e. before snow clamping kicks in. */
export const RAMP_BAND_COUNT = LAST_PALETTE_INDEX - FIRST_LAND_PALETTE_INDEX;

/** Sanity bound used by tests: the tallest possible peak's band. */
export const MAX_BAND = bandOf(MAX_HEIGHT);
