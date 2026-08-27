// Height-based terrace colour ramp. Pure — no Three.js, no DOM.
//
// Split into "which palette entry" (bandPaletteIndex) and "the palette itself"
// so the renderer can pre-convert the palette to Three's linear working colour
// space ONCE at start-up and then select per vertex with a plain array index.
// Without that split the renderer would either repeat the selection logic or
// run an sRGB→linear pow() per vertex per patch.

import {
  BAND_HEIGHT,
  DEEP_BASALT_BANDS,
  DEEP_BASALT_DEPTH,
  DEEP_LAVA_BANDS,
  DEEP_LAVA_DEPTH,
  DEEP_OBSIDIAN_BANDS,
  DEEP_OBSIDIAN_DEPTH,
  DEEP_STRATA_BANDS,
  MAX_HEIGHT,
  SEA_COLUMN_BANDS,
  SEA_COLUMN_DEPTH,
  SEA_LEVEL,
  bandOf,
  isWater,
} from '@terrace/shared';
import { ORDINARY_SEA_FLOOR_HEIGHT } from '../config.ts';

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
 * to band −16, the bottom of the sea column — so no two depths share a colour
 * and the descent ends in a very dark blue rather than plateauing at the old
 * deep-water stop. The first four stops are unchanged (waterline, shelf, ring,
 * and the old deep stop, which is now simply band −3's own), so worlds that
 * never dig past genesis depth render exactly as before this change.
 *
 * DEEP STRATA AMENDMENT (2026-08-19, mechanics card 41): below the sea
 * column's very-dark-blue floor the world now continues into CRUST — basalt
 * (bands −17..−20), obsidian (−21..−23), and one lava band at MIN_HEIGHT
 * (−24). The blue ramp's strict darkening contract deliberately ENDS at the
 * sea column: the first basalt stop is BRIGHTER than the blue floor, because
 * the material change is the message — breaking through the seabed must read
 * as arriving somewhere, not as more of the same darkness. Within the rock
 * the strict descent resumes (basalt darkens into obsidian), and the lava
 * stop breaks every darkness rule on purpose: it is the one entry in this
 * palette that is a light SOURCE (drawn self-lit — see LAVA_PALETTE_INDEX and
 * capEmission.ts), so the bottom of the deepest dig glows.
 */

/** Stops of the blue water column: the flats plus one per sea band. */
export const BLUE_SEABED_STOPS = SEA_COLUMN_BANDS + 1;

/** All underwater stops: the blue column plus the crust strata under it. */
export const SEABED_DEPTH_STOPS = BLUE_SEABED_STOPS + DEEP_STRATA_BANDS;

/** First palette index of each crust stratum, derived from the shared stack. */
export const FIRST_BASALT_STOP = BLUE_SEABED_STOPS;
export const FIRST_OBSIDIAN_STOP = FIRST_BASALT_STOP + DEEP_BASALT_BANDS;
export const FIRST_LAVA_STOP = FIRST_OBSIDIAN_STOP + DEEP_OBSIDIAN_BANDS;

/**
 * True for the lava floor's stops: the palette entries rendered as a light
 * source. The geometry builder keys cap self-lighting off this
 * (capEmission.ts), the same way seabed risers key off isSeabedPaletteIndex —
 * one predicate per regime decision, stated here beside the palette that
 * defines it.
 *
 * A RANGE since the 2026-08-20 re-terrace, not the single index it was: lava
 * is a stratum DEPTH (DEEP_LAVA_DEPTH), and at a finer BAND_HEIGHT that same
 * depth is several bands. The old `index === LAVA_PALETTE_INDEX` was the band
 * -count conflation this whole change exists to remove — it would have lit
 * only the topmost lava band and left the world's actual floor dark.
 */
export function isEmissivePaletteIndex(index: number): boolean {
  return index >= FIRST_LAVA_STOP && index < SEABED_DEPTH_STOPS;
}

/**
 * Index 0 is the SHALLOWEST seabed (the h = 0 flats — also every cell of a
 * freshly created world); deeper bands take the next indices, then the land
 * ramp, one step per terrace band starting at band 0 (the first above sea).
 */
export const SEABED_PALETTE_INDEX = 0;
export const FIRST_LAND_PALETTE_INDEX = SEABED_DEPTH_STOPS;

// ---------------------------------------------------------------------------
// The ramp is GENERATED, not authored (2026-08-20).
//
// It used to be a hand-written list of one hex literal per band. That made the
// palette a function of BAND_HEIGHT — the render quantum — so re-terracing the
// world (BAND_HEIGHT 64 → 16) indexed straight off the end of it. Same
// conflation the strata stack had, same fix: the colours are anchored to the
// HEIGHTS the world is actually made of, and the per-band stops are derived by
// sampling those anchors. A future BAND_HEIGHT change now re-samples the ramp
// instead of breaking it.
//
// WHAT CHANGED VISUALLY, and what deliberately did not. Every anchor colour
// below is the exact colour the old ramp used, placed at the exact height the
// old ramp put it at, so the world's materials sit where they always sat: sand
// still gives way to soil at 128 units, grass to rock at 384, snow still caps
// at SNOW_LINE_HEIGHT, the seabed still ends in very dark blue at the sea
// column's floor. What is new is what happens BETWEEN two anchors: the stops
// interpolate (owner, 2026-08-20), so each of the four bands that now stand
// where one band used to stand gets its own shade rather than repeating its
// neighbour's. Above water that turns the old ten-step staircase into a
// gradation under crisp terrace geometry; below water it is not a choice at
// all — the depth-contrast contract demands a STRICTLY darker colour at every
// stop, which no held-flat ramp can satisfy.
// ---------------------------------------------------------------------------

/**
 * One named colour and the world HEIGHT it belongs to. Heights are signed
 * (positive above sea, negative below) and an anchor list runs top-down.
 */
type ColorAnchor = readonly [height: number, color: Rgb];

/**
 * Spread named colours evenly down a height span, HIGHEST HEIGHT FIRST. The
 * even spacing IS the statement: these colours were authored as a sequence of
 * equal steps through a material, and the span they cross is the material's
 * own depth.
 *
 * Every anchor list in this file is stored top-down, so one sampler serves the
 * whole palette; a ramp whose colours read naturally bottom-up (the land ramp)
 * reverses its colours at the call site rather than teaching the sampler a
 * second order.
 */
function evenlySpaced(
  topHeight: number,
  bottomHeight: number,
  colors: readonly Rgb[],
): readonly ColorAnchor[] {
  // A one-colour material (lava) has no span to spread across — it is a flat
  // fill, and dividing by its zero gaps would produce NaN heights.
  if (colors.length === 1) return [[topHeight, colors[0]]];
  const gaps = colors.length - 1;
  return colors.map((color, i) => [
    topHeight + ((bottomHeight - topHeight) * i) / gaps,
    color,
  ]);
}

/**
 * Piecewise-linear sample of a top-down anchor list at one height. Heights
 * outside the anchored span clamp to the end anchors, which is what makes a
 * stratum's first stop take its top colour even when the stratum boundary
 * falls between two band floors.
 */
function sampleAnchors(anchors: readonly ColorAnchor[], height: number): Rgb {
  const last = anchors.length - 1;
  if (height >= anchors[0][0]) return anchors[0][1];
  if (height <= anchors[last][0]) return anchors[last][1];
  let upper = 0;
  while (anchors[upper + 1][0] > height) upper++;
  const [topHeight, topColor] = anchors[upper];
  const [bottomHeight, bottomColor] = anchors[upper + 1];
  const t = (topHeight - height) / (topHeight - bottomHeight);
  return [
    topColor[0] + (bottomColor[0] - topColor[0]) * t,
    topColor[1] + (bottomColor[1] - topColor[1]) * t,
    topColor[2] + (bottomColor[2] - topColor[2]) * t,
  ];
}

/**
 * The blue water column, waterline to sea floor — the seventeen colours the
 * seabed history above describes, now anchored to the depths they were
 * authored for rather than to band indices.
 *
 * TWO SPANS, NOT ONE (2026-08-26). Spread evenly down the whole
 * SEA_COLUMN_DEPTH, the ninth colour — authored as "about as deep as a genesis
 * ocean reaches" — landed at 512 units, and the ocean the world actually has
 * reaches 240 (config.ts's ORDINARY_SEA_DEPTH_BANDS, measured). So the first
 * half of this ramp, the half written to tell the ordinary sea's depths apart,
 * was spent on depths the sea never has, and the depths it does have — bands
 * 10 through 14, 83% of all water — fell on one twelfth of it, adjacent stops
 * two parts in 255 apart. Owner: "There is no difference between the shallows
 * and the depths." The ramp now honours its own annotation: the ocean colours
 * run waterline → ORDINARY_SEA_FLOOR_HEIGHT, and the abyssal colours run from
 * there → the sea column's floor. Same seventeen colours, same order, same
 * ends; only the depth each one sits at has moved to where it was meant to be.
 *
 * The two properties that history states — luminance falling STRICTLY with
 * depth (front-loaded, so the abyssal tail steps small), and the hue crossing
 * to blue-dominant on the way to 0x030813 — survive interpolation for free:
 * a sum of linearly interpolated channels is itself linear, so every stop
 * sampled between two strictly-darkening anchors is strictly darker than the
 * stop above it.
 */
const OCEAN_COLORS: readonly Rgb[] = [
  rgb(0x6a7f68), // the waterline flats (h = 0)
  rgb(0x50705d), // the genesis shelf
  rgb(0x3a5b52), // the genesis ring
  rgb(0x274347), // deep water begins — monster country
  rgb(0x1f3a44),
  rgb(0x183243),
  rgb(0x122a40),
  rgb(0x0d233c),
  rgb(0x0a1d37), // about as deep as a genesis ocean reaches: ORDINARY_SEA_FLOOR_HEIGHT
];
const ABYSS_COLORS: readonly Rgb[] = [
  OCEAN_COLORS[OCEAN_COLORS.length - 1], // shared join, so the ramp has no seam
  rgb(0x081931),
  rgb(0x07152b),
  rgb(0x061226),
  rgb(0x050f21),
  rgb(0x040d1d),
  rgb(0x040b19),
  rgb(0x030916),
  rgb(0x030813), // the very dark blue: the sea column's floor
];
const BLUE_COLUMN_ANCHORS: readonly ColorAnchor[] = [
  ...evenlySpaced(SEA_LEVEL, ORDINARY_SEA_FLOOR_HEIGHT, OCEAN_COLORS),
  // Drop the abyss's first anchor: it is the ocean's last, at the same height.
  ...evenlySpaced(ORDINARY_SEA_FLOOR_HEIGHT, -SEA_COLUMN_DEPTH, ABYSS_COLORS).slice(1),
];

// The crust, per the Deep Strata amendment above. Each stratum's span comes
// straight from shared's stack, so the colours cannot drift off the material
// boundaries they are meant to mark.

const CRUST_TOP = -SEA_COLUMN_DEPTH;
const BASALT_FLOOR = CRUST_TOP - DEEP_BASALT_DEPTH;
const OBSIDIAN_FLOOR = BASALT_FLOOR - DEEP_OBSIDIAN_DEPTH;
const LAVA_FLOOR = OBSIDIAN_FLOOR - DEEP_LAVA_DEPTH;

/** Dark volcanic gray, hue-neutral against the blue column above it. */
const BASALT_ANCHORS = evenlySpaced(CRUST_TOP, BASALT_FLOOR, [
  rgb(0x3a3b41),
  rgb(0x323338),
  rgb(0x2a2b2f),
  rgb(0x232427),
]);

/** Glass-black with a violet cast, ending in the darkest material in the game. */
const OBSIDIAN_ANCHORS = evenlySpaced(BASALT_FLOOR, OBSIDIAN_FLOOR, [
  rgb(0x1a1820),
  rgb(0x121017),
  rgb(0x0b0a10),
]);

/** Molten glow — one colour, because the floor is a light, not a gradient. */
const LAVA_ANCHORS = evenlySpaced(OBSIDIAN_FLOOR, LAVA_FLOOR, [rgb(0xf25c1a)]);

/**
 * Height at which the land ramp reaches snow; bands at or above it all render
 * as snowcap.
 *
 * 576 units is nine of the pre-2026-08-20 terrace bands, which is where the
 * hand-authored ramp put its snow stop, and it is kept EXACTLY there so
 * re-terracing the world does not move the treeline: a peak that wore snow
 * before the change wears snow after it. It is also plainly a mountain top —
 * 576 units of relief above the sea — so nothing above it needs a colour of
 * its own.
 */
export const SNOW_LINE_HEIGHT = 576;

/** Bands the land ramp colours explicitly, before snow clamping kicks in. */
export const LAND_RAMP_BANDS = SNOW_LINE_HEIGHT / BAND_HEIGHT;

/**
 * The land ramp: sand and soil at the shoreline, grass, rock, then snowcap.
 *
 * Three sand-and-soil anchors before any green (owner, 2026-08-14: "multiple
 * layers of sand and soil color near the water. Greener layers should start
 * higher up") — the coast reads as coast for two full materials before
 * vegetation takes over. The ramp is deliberately NOT monotonic in luminance
 * (sand is brighter than the grass above it; rock climbs back toward snow):
 * the CONTRAST between neighbouring materials is the contract, and direction
 * is the palette's own business.
 */
const LAND_RAMP_SHORELINE_UP: readonly Rgb[] = [
  rgb(0xd9c89a), // wet beach sand at the waterline
  rgb(0xc0a468), // dry sand
  rgb(0x96774a), // bare soil
  rgb(0x8fc25a), // bright lowland grass
  rgb(0x69a244), // grass
  rgb(0x467a33), // dark highland grass
  rgb(0x736f61), // dark exposed rock
  rgb(0x908c80), // rock
  rgb(0xb3aea2), // pale high rock
  rgb(0xf2f4f6), // snow
];

/** The same ramp as anchors, stored top-down like every other list here. */
export const LAND_RAMP_ANCHORS = evenlySpaced(SNOW_LINE_HEIGHT, SEA_LEVEL, [
  ...LAND_RAMP_SHORELINE_UP,
].reverse());

/**
 * A contiguous run of underwater stops and the anchors that colour it. One
 * entry per material, so the regime break at each boundary is structural: two
 * neighbouring stops in different regimes sample different anchor lists and
 * therefore step, where two stops inside one regime interpolate.
 */
const SEABED_REGIMES: readonly { stops: number; anchors: readonly ColorAnchor[] }[] = [
  { stops: BLUE_SEABED_STOPS, anchors: BLUE_COLUMN_ANCHORS },
  { stops: DEEP_BASALT_BANDS, anchors: BASALT_ANCHORS },
  { stops: DEEP_OBSIDIAN_BANDS, anchors: OBSIDIAN_ANCHORS },
  { stops: DEEP_LAVA_BANDS, anchors: LAVA_ANCHORS },
];

/**
 * The stops, sampled once at module load: every underwater regime top-down,
 * then the land ramp bottom-up. A stop stands for one terrace band and is
 * sampled at that band's FLOOR — the height at which the band's tread is
 * drawn — so the colour a player sees on a tread is the colour the ramp
 * names at the height that tread sits.
 */
function buildPalette(): Rgb[] {
  const stops: Rgb[] = [];
  for (const regime of SEABED_REGIMES) {
    for (let i = 0; i < regime.stops; i++) {
      stops.push(sampleAnchors(regime.anchors, -stops.length * BAND_HEIGHT));
    }
  }
  for (let band = 0; band <= LAND_RAMP_BANDS; band++) {
    stops.push(sampleAnchors(LAND_RAMP_ANCHORS, band * BAND_HEIGHT));
  }
  return stops;
}

export const TERRAIN_PALETTE: readonly Rgb[] = buildPalette();

/**
 * Smallest summed-RGB luminance gap between ADJACENT land ANCHORS (owner,
 * 2026-08-14: "more contrast on the layers above ground as well" — the first
 * ramp's neighbours sat ~0.2 apart and adjacent terraces blurred together at
 * play distance). 0.3 is ~10% of the 0..3 scale: comfortably visible on a lit
 * tread, and holdable across the whole ramp without breaking the sand → grass
 * → rock → snow story.
 *
 * AN ANCHOR-TO-ANCHOR CONTRACT SINCE 2026-08-20, where it used to be a
 * stop-to-stop one. With the ramp interpolating, adjacent STOPS are a quarter
 * of a material apart and cannot be a tenth of the scale apart as well — the
 * gap between two anchors is now spent gradually across the bands between
 * them. The owner's ask survives intact because it was always about
 * MATERIALS reading apart, and the anchors are the materials; what is gone is
 * the guarantee that two neighbouring terraces differ by colour alone, which
 * the interpolated ramp trades for a smooth mountainside. Enforced by test,
 * so a future recolour cannot quietly blur two materials back together.
 */
export const MIN_LAND_ANCHOR_LUMINANCE_GAP = 0.3;

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
