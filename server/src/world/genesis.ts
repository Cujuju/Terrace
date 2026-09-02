// FRESH-WORLD GENESIS — an archipelago, drawn once per world from one seed.
//
// A brand-new world is an OCEAN WITH ISLANDS IN IT: a seeded, multi-octave
// height field over the whole map, then three guarantee passes that only fire
// where the field fell short of something a plugin (or a player) needs on day
// one.
//
// ─── WHAT CAME BEFORE, AND WHY IT IS GONE (owner, 2026-08-25) ────────────────
//
// Until today genesis had TWO zones. Inside the starter unlock square it drew a
// fixed shelf/slope/abyss profile — the same three concentric terraces in every
// world ever generated — and clamped the noise underneath it so the wildlife
// plugin's day-one census could assert EXACT cell counts. Outside it drew one
// octave of value noise.
//
// The owner's verdict: "New worlds should not have just a single starter
// square; they should have islands — not just a single island. They should also
// have some random trenches, and the depth of the sea should vary."
//
// So the fixed profile and its clamp are gone, the noise runs edge to edge, and
// the exact-census contract is replaced by MINIMA (see the habitat pass). See
// docs/DESIGN.md, "Decisions made 2026-08-25 (archipelago genesis)".
//
// ─── THE SHAPE OF A FRESH WORLD ──────────────────────────────────────────────
//
//   1. NOISE, everywhere. GENESIS_NOISE_OCTAVES octaves of integer value noise
//      at 256/128/64/32/16-cell lattice spacings, each at half the amplitude of
//      the one before it. The coarse octave decides where the continents and
//      basins are; the fine ones give their coasts a ragged edge — which is
//      what turns "one big landmass" into an archipelago. The `baseline` and
//      `roughness` draws survive from the
//      single-octave version and still mean the same thing, so a flat world
//      remains possible (owner, 2026-08-18: "it's OK to create flat worlds").
//
//   2. THE ISLAND PASS. The starter unlock square must contain at least
//      GENESIS_MIN_STARTER_ISLANDS separate islands of at least
//      GENESIS_MIN_ISLAND_CELLS each, because that square is the entire world a
//      player can touch on day one and an all-ocean one gives them nothing to
//      stand on. Where the noise already drew them, this pass does nothing.
//
//   3. THE HABITAT PASS. The same square must hold enough shallow water for the
//      fish schools and enough deep water for the whale pair the wildlife
//      plugin asks for on day one (see GENESIS_MIN_STARTER_SHALLOW_CELLS and
//      GENESIS_MIN_STARTER_DEEP_CELLS). Where the noise already holds them,
//      this pass does nothing.
//
//   4. THE TRENCH PASS. One kraken-qualifying trench (owner-ratified
//      2026-08-19, rule unchanged) plus GENESIS_EXTRA_TRENCH_* more for
//      texture, each cut through open ocean along a seed-chosen axis.
//
// Every genesis height, everywhere, is an exact multiple of BAND_HEIGHT (a
// "band floor") and lies inside [MIN_HEIGHT, MAX_HEIGHT]: the field is built
// from integer band offsets rather than raw heights, so nothing here needs a
// quantising pass. This is a TERRACED game whose default brush cuts sheer
// faces, so a genesis surface that steps rather than ramps is the house style.
//
// THE SEED. `World.createFresh` draws one random 32-bit seed per world (the ONE
// intentionally non-deterministic moment in genesis) and every height in the
// map is a pure function of `(size, seed)` from then on — same inputs, same
// world, byte for byte.
//
// THE PASS CONTRACT. All three guarantee passes obey the same four rules the
// 2026-08-19 trench pass established:
//   * derived from `(size, seed)` by integer arithmetic, drawing NOTHING more
//     from the world's RNG — so adding a pass cannot shift the noise field a
//     previously-pinned seed produced;
//   * a byte-for-byte no-op on a world whose noise already qualified;
//   * fixed iteration order, every tie broken by a TOTAL order on cells, so no
//     result depends on the order a flood fill happened to visit cells in;
//   * every height they write is still an exact band floor.
//
// RESIDUAL, NAMED. Genesis does NOT generally satisfy the terrain gradient
// invariant (MAX_STEP per cell): the noise field can put a large lattice swing
// across neighbouring cells, so a `smooth` sculpt that reaches such a boundary
// will slump it once, bounded by SMOOTH_PASS_LIMIT. Accepted, exactly as it was
// for the fixed coast this replaces. The parts genesis MANUFACTURES — island
// flanks and trench walls — do satisfy it (see
// GENESIS_TERRACE_WALL_CELLS_PER_BAND), because those are the surfaces a
// guarantee rests on and a slumping guarantee is not one.

import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  NEIGHBOURHOOD_CELLS,
  SEA_LEVEL,
  WORLD_UNIT_CELLS,
  cellsOverArea,
  createSeededRng,
  type Heightmap,
} from '@terrace/shared';
import { initialUnlockFootprint } from './initial-unlock.ts';

// ── Depths genesis knows by name ─────────────────────────────────────────────

/**
 * Depth of open ocean, in height units below sea level — and the line between
 * shallow and deep water for every habitat consumer.
 *
 * Chosen to satisfy `FRESH_SEABED_DEPTH_BELOW_SEA >= DEEP_WATER_DEPTH`. Core
 * cannot import a plugin constant — plugins depend on core, never the reverse —
 * so the relation is asserted from the plugin side instead
 * (plugins/wildlife/test/wildlife.test.ts). If either number moves, that test
 * fails rather than the ocean silently going shallow again.
 *
 * It is also the SHALLOWEST depth that satisfies the relation, which is what we
 * want: every extra unit of depth is more sculpting a player must spend to
 * raise land out there.
 */
export const FRESH_SEABED_DEPTH_BELOW_SEA = 192;
export const FRESH_SEABED_BANDS_BELOW_SEA = FRESH_SEABED_DEPTH_BELOW_SEA / BAND_HEIGHT;

/**
 * Depth of the shallow water genesis writes when a pass has to MANUFACTURE
 * some — one third of the seabed's depth, so it sits comfortably inside the
 * shallow band rather than one rounding away from the deep line.
 *
 * A THIRD, in height units, is what survives of the old fixed coast: the
 * shelf/slope/abyss staircase was 1 : 2 : 3 thirds of the seabed depth, and the
 * proportion is the part worth keeping now that the staircase itself is gone.
 * It is also the shallowest STEP up to dry land, so an island raised here is
 * the cheapest land in the world to finish.
 */
export const FRESH_SHELF_DEPTH_BELOW_SEA = FRESH_SEABED_DEPTH_BELOW_SEA / 3;
export const FRESH_SHELF_BANDS_BELOW_SEA = FRESH_SHELF_DEPTH_BELOW_SEA / BAND_HEIGHT;

/** Height of a cell `bands` terrace bands below sea level. */
function heightAtBandsBelowSea(bands: number): number {
  return SEA_LEVEL - bands * BAND_HEIGHT;
}

/** The open-ocean floor as a height: -192. Also the deep-water line. */
export const FRESH_SEABED_HEIGHT = heightAtBandsBelowSea(FRESH_SEABED_BANDS_BELOW_SEA);

/** The manufactured-shallows height: -64. */
export const FRESH_SHELF_HEIGHT = heightAtBandsBelowSea(FRESH_SHELF_BANDS_BELOW_SEA);

/**
 * Cells of horizontal run per band of descent on any wall GENESIS ITSELF cuts —
 * island flanks and trench walls.
 *
 * DERIVED, not chosen: BAND_HEIGHT / MAX_STEP is the shortest run over which a
 * one-band step still satisfies the terrain gradient invariant, so these are
 * the steepest slopes the sculpt rules call stable. A wall that did not satisfy
 * it would slump the first time a smooth stroke reached it, and the guarantee
 * resting on that wall would quietly shallow out.
 */
const GENESIS_TERRACE_WALL_CELLS_PER_BAND = BAND_HEIGHT / MAX_STEP;

/**
 * A one-line duplicate of shared/src/heightmap.ts's own (unexported)
 * `clampHeight`. Both sides are exactly `MAX_HEIGHT`/`MIN_HEIGHT` clamping and
 * nothing else; if that ever needs to change it changes in two places, which is
 * the honest cost of not exporting a private helper from shared.
 */
function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

// ── Seeded randomness ────────────────────────────────────────────────────────

/**
 * Draws the one intentionally non-deterministic value in genesis: a fresh
 * unsigned 32-bit seed, used only when a caller doesn't supply its own.
 * Everything downstream of the returned value is a pure function of it.
 */
export function drawGenesisSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

/**
 * mulberry32 — a small, public-domain 32-bit seeded PRNG (Tommy Ettinger). Not
 * cryptographic and doesn't need to be: genesis only needs "looks random and is
 * fully determined by a 32-bit seed". `seed` is coerced with `>>> 0` so any
 * finite JS number — including a negative one, or one out of 32-bit range, both
 * of which a test may reasonably pass — is a valid seed rather than a silent
 * NaN cascade.
 *
 * FROM @terrace/shared NOW, where the same eight lines that seven files carried
 * moved. The body here differed from the others in one keystroke — it carried
 * its state as `| 0` where they carried it as `>>> 0` — and the two forms take
 * the same low 32 bits, so the STREAM IS BIT-IDENTICAL: verified over 200 000
 * draws each from nine seeds including negative, zero and 0xffffffff before this
 * call replaced the body. That matters more here than anywhere else in the repo:
 * an existing world regenerates from its saved seed, so a stream that shifted by
 * one bit would silently rewrite everyone's terrain.
 */
function mulberry32Rng(seed: number): () => number {
  return createSeededRng(seed).next;
}

/**
 * An integer avalanche of two numbers — the whole of genesis's "derive a choice
 * from (seed, something) without touching the RNG" toolkit.
 *
 * The xorshift-multiply pair from Murmur3's finaliser, rather than `seed % n`,
 * because seeds are not always random: the test suites — and any operator
 * pinning a world — use small consecutive integers, whose low bits would march
 * through any list in lockstep.
 *
 * The two inputs are mixed SEPARATELY and then combined, rather than XORed
 * together first: `a ^ b` maps the pair (0, 0) — cell zero of a world seeded
 * zero, which is exactly a test's first world — onto the smallest value there
 * is, handing the corner every tie-break it is involved in.
 */
function genesisMix(a: number, b: number): number {
  let mixed = (Math.imul(a + 1, 0x27d4_eb2d) ^ Math.imul(b + 1, 0x9e37_79b9)) >>> 0;
  mixed = (mixed ^ (mixed >>> 15)) >>> 0;
  return Math.imul(mixed, 0x85eb_ca6b) >>> 0;
}

// ── The noise field ──────────────────────────────────────────────────────────

/**
 * Lattice spacing of the COARSEST noise octave, in cells — one sample per four
 * neighbourhoods.
 *
 * This is the feature size of a fresh world's continents and basins. It is NOT
 * what MIN_WORLD_SIZE is derived against — see that constant's comment in
 * config.ts for why a ring of this would forbid the design's own smallest
 * playable map.
 */
const GENESIS_COARSEST_LATTICE_SPACING_CELLS = NEIGHBOURHOOD_CELLS * 4;

/**
 * The octaves, coarsest first, as (lattice spacing in cells, amplitude
 * divisor).
 *
 * FIVE OCTAVES, each at HALF the spacing and HALF the amplitude of the one
 * before it — ordinary fractal noise, and both halvings are the point.
 *
 * THE SPACINGS run 256, 128, 64, 32, 16 cells: from four neighbourhoods (the
 * scale a continent or an ocean basin is drawn at) down to a quarter of one,
 * which is four world units — the smallest patch of ground a player can see the
 * shape of from the default camera. Stopping any coarser was measured and
 * rejected: at a 64-cell floor an island's whole coastline sat inside a single
 * lattice square, so every coast came out as a smooth arc and a raised island
 * came out as a perfect circle. Going finer would draw speckle on the beach
 * rather than a coastline.
 *
 * THE AMPLITUDES halve with them, which is what makes an ARCHIPELAGO rather
 * than either a smooth blob or static: the coarse octave decides where the sea
 * floor and the continents are, and the two finer ones carry enough relief on
 * top to break a landmass into islands and to ripple the sea floor, without
 * being loud enough to drown the shape underneath. The single octave this
 * replaced could only ever draw ONE smooth bowl per 64 cells, which is why a
 * fresh world looked like one shelf and one continent (owner, 2026-08-25).
 *
 * THEY ARE SUMMED, NOT AVERAGED, and that is a correction rather than a
 * preference: the first version of this pass averaged them by weight, which
 * shrinks the field's relief by the same factor averaging shrinks any variance
 * — measured, 1.2% of a fresh world's cells came out above sea level and the
 * "archipelago" was whatever the island pass had raised. Summed, each octave
 * adds its own relief and the amplitude limits stay the limits.
 *
 * Integer divisors on purpose: every lattice value is an integer band offset,
 * so the combine step is one integer add per octave and the field stays exactly
 * reproducible with no float accumulation.
 */
const GENESIS_NOISE_OCTAVES: readonly {
  readonly spacingCells: number;
  readonly amplitudeDivisor: number;
}[] = [
  { spacingCells: GENESIS_COARSEST_LATTICE_SPACING_CELLS, amplitudeDivisor: 1 },
  { spacingCells: NEIGHBOURHOOD_CELLS * 2, amplitudeDivisor: 2 },
  { spacingCells: NEIGHBOURHOOD_CELLS, amplitudeDivisor: 4 },
  { spacingCells: NEIGHBOURHOOD_CELLS / 2, amplitudeDivisor: 8 },
  { spacingCells: NEIGHBOURHOOD_CELLS / 4, amplitudeDivisor: 16 },
];

/**
 * Deepest and highest a noise lattice point can reach, in height units either
 * side of sea level — the AMPLITUDE of the genesis field.
 *
 * -640 is dramatic ocean-trench territory while staying inside the sea column,
 * so `clampHeight` is a backstop that should never fire rather than a value
 * this range depends on. +256 buys hills and islands without turning every
 * fresh world into a mountain range: deliberately modest against MAX_HEIGHT's
 * 1024 units of headroom, because genesis is a starting point, not the most
 * dramatic terrain a world will ever have.
 */
const GENESIS_NOISE_MIN_DEPTH_BELOW_SEA = 640;
const GENESIS_NOISE_MAX_HEIGHT_ABOVE_SEA = 256;
const GENESIS_NOISE_MIN_BAND_OFFSET = -(GENESIS_NOISE_MIN_DEPTH_BELOW_SEA / BAND_HEIGHT);
const GENESIS_NOISE_MAX_BAND_OFFSET = GENESIS_NOISE_MAX_HEIGHT_ABOVE_SEA / BAND_HEIGHT;

/**
 * How much of the amplitude the per-world BASELINE — the height a calm world is
 * flat at, and the height a rough one's octaves wander either side of — may be
 * drawn from, as a divisor of the positive half.
 *
 * FOUR, i.e. the baseline ceiling is one quarter of the noise ceiling, and the
 * asymmetry is what makes islands. Drawn across the full range the baseline
 * alone decided a world: land-dominant if it landed above sea level, ocean-
 * dominant if below, with an archipelago the rare middle. Drawn from [seabed,
 * a quarter of the noise ceiling] the TYPICAL world is an ocean whose floor
 * sits between the deep-water line and the shallows, and the octaves' full
 * amplitude is what lifts parts of it into islands — which is the world the
 * design has always described ("an ocean with a coast") and the one the
 * owner asked for.
 *
 * The floor is the seabed depth rather than a number of its own, because that
 * IS what "open ocean" means everywhere else in this file.
 */
/**
 * The exponent the raw `roughness` draw is raised to before it scales the
 * octave amplitudes — ONE HALF, i.e. a square root, which skews the draw toward
 * rough.
 *
 * WHY IT IS NOT 1 (a uniform draw). Roughness is the dial between "calm sea"
 * and "full relief", and drawn uniformly it puts a FIFTH of all worlds in the
 * bottom fifth of the range — measured over 200 seeds — where the field's whole
 * relief is a few bands and the only land in the world is what the island pass
 * raised. That is a fresh world with no archipelago in it, which is the defect
 * this change exists to fix, repeated on 20% of worlds.
 */
const GENESIS_ROUGHNESS_SKEW_EXPONENT = 1 / 2;

/**
 * The least relief any fresh world may have, as a fraction of the noise
 * amplitude — and the end of "it's OK to create flat worlds" (owner,
 * 2026-08-18), retired by the owner's own later decisions.
 *
 * DERIVED, not chosen: it is the roughness at which the COARSE OCTAVE ALONE
 * spans the distance from the deep-water line to sea level. Below that no lift
 * of the field can satisfy both of genesis's whole-world guarantees at once,
 * because they sit on opposite sides of that distance — a world flatter than
 * this either has no dry land (GENESIS_MIN_LAND_PERCENT) or no basin deep
 * enough for a kraken (2026-08-19, owner-ratified), and lifting the field to
 * fix one breaks the other. A genuinely featureless world can keep neither
 * promise, so genesis stopped drawing one.
 *
 * The world at this floor is still very calm: gentle relief, a shallow sea, one
 * basin. It is "flat" in the sense the owner meant and no longer flat in the
 * sense that leaves a player nothing.
 */
const GENESIS_MIN_ROUGHNESS =
  FRESH_SEABED_BANDS_BELOW_SEA /
  ((GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_NOISE_MIN_BAND_OFFSET) / 2);

const GENESIS_BASELINE_CEILING_DIVISOR = 4;
const GENESIS_BASELINE_MIN_BAND_OFFSET = -FRESH_SEABED_BANDS_BELOW_SEA;
const GENESIS_BASELINE_MAX_BAND_OFFSET =
  GENESIS_NOISE_MAX_BAND_OFFSET / GENESIS_BASELINE_CEILING_DIVISOR;

/**
 * Fixed-point units in ONE terrace band, for the octave sum — and the fix for
 * the faceted coasts of GH #204.
 *
 * THE DEFECT. `octaveBandAt` used to floor EACH octave to whole bands before
 * `genesisNoiseRawBandAt` summed them. The two finest octaves have amplitudes
 * of at most 3.5 and 1.75 bands, so flooring them individually turned each into
 * a staircase of 0/±1 plateaus, and the EDGE of such a plateau is a level set
 * of the bilinear interpolant on that octave's 32- or 16-cell lattice — a
 * straight line along a lattice row, column or diagonal. Every coastline in the
 * world inherited those lines and came out as a mosaic of triangles.
 *
 * THE FIX. Every octave is summed at 1/256 of a band and the sum is floored
 * ONCE, in `genesisNoiseRawBandAt`. Each octave then contributes its real
 * fractional wander to the total instead of a quantised plateau, so a band
 * boundary falls where the SUM crosses it rather than where one octave's
 * lattice does.
 *
 * 256 = 2^8, so the scaling is exact in binary and nothing accumulates a float
 * error: the offsets are integers, the interpolation products are integers (the
 * largest is 28 bands × 256 × 256 × 256 ≈ 4.7e8, well inside exact integer
 * range), and the two divisions are floors. The determinism contract is
 * unchanged.
 */
const GENESIS_BAND_FIXED_POINT_ONE = 256;

/**
 * One octave's lattice: row-major integer band offsets in
 * GENESIS_BAND_FIXED_POINT_ONE units per band, `cols` wide and tall. The
 * offsets are ZERO-MEAN WANDER, not heights — the world's baseline is added
 * once, by `genesisNoiseBandAt`, rather than once per octave.
 *
 * Int32Array rather than Int16Array because the fixed-point scaling multiplies
 * every offset by 256: the coarsest octave's ±28 bands become ±7168, which
 * still fits an Int16, but a future amplitude change should not silently wrap.
 */
interface GenesisNoiseOctave {
  readonly spacingCells: number;
  readonly bandOffsets: Int32Array;
  readonly cols: number;
}

/** A whole world's noise field — the baseline it settles at, and every octave. */
export interface GenesisNoiseField {
  /** The band offset a perfectly calm world would be flat at, everywhere. */
  readonly baselineBandOffset: number;
  /**
   * Whole bands the land pass lifted the whole field by — zero on a world whose
   * own noise already cleared GENESIS_MIN_LAND_PERCENT. See the land pass.
   */
  readonly landLiftBands: number;
  readonly octaves: readonly GenesisNoiseOctave[];
}

/**
 * Draws the field for one world. THE ONLY CONSUMER OF THE RNG in genesis, and
 * its draw order is fixed and size-independent so that the same seed consumes
 * it the same way whatever the caller later does:
 *
 *   1. `baseline`  — one draw
 *   2. `roughness` — one draw
 *   3. every lattice point of every octave, octaves in GENESIS_NOISE_OCTAVES
 *      order, points row-major within each.
 *
 * ROUGHNESS AND BASELINE, TOGETHER. `roughness`, in
 * [GENESIS_MIN_ROUGHNESS, 1), scales how far every lattice point may wander
 * from `baseline`: at 1 the coarse octave alone spans the full amplitude, and
 * at the floor it spans just enough for the world to keep both of genesis's
 * whole-world guarantees — one continuum, with a floor under it rather than a
 * special-cased calm mode bolted on beside the noise.
 *
 * `baseline` is drawn PER WORLD and is why this is two draws rather than one.
 * An earlier version collapsed roughness toward the noise range's own zero
 * point (sea level): every sufficiently calm seed produced the same flat world
 * regardless of what the seed was, so distinct seeds could produce byte-
 * identical worlds. Drawing the flat point means a calm world is flat at a
 * height the SEED chose, so two calm seeds essentially never coincide.
 *
 * THE WANDER IS SYMMETRIC about zero, which matters because the amplitude range
 * is deliberately lopsided (-640 below sea level against +256 above it, since
 * oceans are deeper than islands are tall). Drawing each point UNIFORMLY FROM
 * THAT RANGE and pulling it toward the baseline settles the field at the
 * range's own mean instead of at the baseline: measured, that version put land
 * on 1.2% of a fresh world's cells. Symmetric wander means `baseline` is the
 * height the world really averages, and the amplitude limits are what they
 * claim to be — limits, applied as the clamp in `genesisNoiseBandAt`.
 */
function buildGenesisNoiseField(size: number, rng: () => number): GenesisNoiseField {
  const halfSpan = (GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_NOISE_MIN_BAND_OFFSET) / 2;
  const baselineSpan = GENESIS_BASELINE_MAX_BAND_OFFSET - GENESIS_BASELINE_MIN_BAND_OFFSET;
  const baselineBandOffset = Math.round(
    GENESIS_BASELINE_MIN_BAND_OFFSET + rng() * baselineSpan,
  );
  const roughness =
    GENESIS_MIN_ROUGHNESS +
    (1 - GENESIS_MIN_ROUGHNESS) * Math.pow(rng(), GENESIS_ROUGHNESS_SKEW_EXPONENT);

  const octaves = GENESIS_NOISE_OCTAVES.map(({ spacingCells, amplitudeDivisor }) => {
    const amplitude = (halfSpan * roughness) / amplitudeDivisor;
    // +2, not +1: interpolation reads lattice[gx + 1], so the grid needs one
    // more column/row than the number of spacing-steps across the world.
    const cols = Math.floor((size - 1) / spacingCells) + 2;
    const bandOffsets = new Int32Array(cols * cols);
    for (let j = 0; j < cols; j++) {
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        // Rounded to GENESIS_BAND_FIXED_POINT_ONE units of a band, not to whole
        // bands: the fine octaves' whole amplitude is a few bands, and rounding
        // them to bands here is half of what faceted the coasts (#204). Same
        // draw, same order, same count — only the scale changed.
        bandOffsets[row + i] = Math.round(
          (rng() * 2 - 1) * amplitude * GENESIS_BAND_FIXED_POINT_ONE,
        );
      }
    }
    return { spacingCells, bandOffsets, cols };
  });

  return { baselineBandOffset, landLiftBands: 0, octaves };
}

/**
 * Bilinearly interpolated wander of ONE octave at one cell, in
 * GENESIS_BAND_FIXED_POINT_ONE units per band — NOT in whole bands. The caller
 * sums the octaves at this scale and floors the total once; see
 * GENESIS_BAND_FIXED_POINT_ONE for why flooring here instead was #204.
 *
 * Entirely integer arithmetic: the interpolation weights are the integer
 * cell-within-lattice-square offsets `fx`/`fy` (each in `[0, spacing)`) rather
 * than a `[0, 1)` float, so every intermediate product is an exact integer and
 * the one division at the end is the only place rounding happens — and it now
 * rounds at 1/256 of a band rather than at a whole one.
 */
function octaveBandAt(octave: GenesisNoiseOctave, x: number, y: number): number {
  const spacing = octave.spacingCells;
  const cols = octave.cols;
  const offsets = octave.bandOffsets;

  const gx = Math.floor(x / spacing);
  const gy = Math.floor(y / spacing);
  const fx = x - gx * spacing;
  const fy = y - gy * spacing;

  const topLeft = offsets[gy * cols + gx]!;
  const topRight = offsets[gy * cols + gx + 1]!;
  const bottomLeft = offsets[(gy + 1) * cols + gx]!;
  const bottomRight = offsets[(gy + 1) * cols + gx + 1]!;

  const top = topLeft * (spacing - fx) + topRight * fx;
  const bottom = bottomLeft * (spacing - fx) + bottomRight * fx;
  return Math.floor((top * (spacing - fy) + bottom * fy) / (spacing * spacing));
}

/**
 * The field's UNCLAMPED band sum at one cell: the baseline, the land pass's
 * lift, and every octave's wander.
 *
 * Exposed separately from the clamped form because the land pass reasons about
 * the whole world at every candidate lift at once (a histogram, and one flood
 * fill per candidate), and it can only do that on values the amplitude clamp
 * has not already folded together.
 */
function genesisNoiseRawBandAt(field: GenesisNoiseField, x: number, y: number): number {
  // The octaves are summed at GENESIS_BAND_FIXED_POINT_ONE units per band and
  // floored ONCE, here. The baseline and the land lift are already whole bands
  // and stay outside the division, so a lift still moves the field by exactly
  // the bands it says it does.
  let wanderFixed = 0;
  for (const octave of field.octaves) wanderFixed += octaveBandAt(octave, x, y);
  return (
    field.baselineBandOffset +
    field.landLiftBands +
    Math.floor(wanderFixed / GENESIS_BAND_FIXED_POINT_ONE)
  );
}

/**
 * The whole field's band offset at one cell — the raw sum, clamped to the
 * amplitude limits.
 *
 * THE CLAMP IS ON THE SUM, not on the octaves, which is what makes the limits
 * mean what they say: no cell of a fresh world is ever more than
 * GENESIS_NOISE_MAX_HEIGHT_ABOVE_SEA above sea level or
 * GENESIS_NOISE_MIN_DEPTH_BELOW_SEA below it, however the octaves stack. It
 * also gives a very rough world flat-topped mesas and flat-floored abyssal
 * plains where the sum runs past a limit, which reads as terrain rather than as
 * clipping precisely because the world is terraced anyway.
 *
 * It never moves a value ACROSS sea level or across the seabed line, both of
 * which lie strictly inside the amplitude range — which is what lets the land
 * pass classify cells from the raw sums alone.
 */
function genesisNoiseBandAt(field: GenesisNoiseField, x: number, y: number): number {
  return clampNoiseBand(genesisNoiseRawBandAt(field, x, y));
}

function clampNoiseBand(bands: number): number {
  if (bands > GENESIS_NOISE_MAX_BAND_OFFSET) return GENESIS_NOISE_MAX_BAND_OFFSET;
  if (bands < GENESIS_NOISE_MIN_BAND_OFFSET) return GENESIS_NOISE_MIN_BAND_OFFSET;
  return bands;
}

// ── The island pass ──────────────────────────────────────────────────────────
//
// THE PROBLEM. With the fixed starter shelf gone, whether the square a player
// starts inside contains any dry land at all is a property of the seed. Half of
// all seeds would hand a new player an unbroken sheet of water and a bill of
// several hundred sculpts before anything could stand on it.
//
// THE PASS. Measure the island-sized land the noise already drew inside the
// starter square. If it is short of GENESIS_MIN_STARTER_LAND_CELLS, LIFT the
// field around the shallowest candidate site and measure again — so the number
// the pass stops on is the land the world really has, not the land it
// intended.
//
// IT LIFTS THE FIELD; IT DOES NOT STAMP A SHAPE. The lift is added to the
// noise's band offset before the waterline is applied, so the island's coast is
// where the seed's own terrain crosses sea level once raised — see
// islandLiftBandsAt for why maxing a cone over the finished height instead is
// what produced the discs-with-haloes the owner rejected on 2026-08-26.
//
// REJECTED ALTERNATIVE 1: bias the noise so land is likelier. That is the LAND
// PASS below, and it is a different guarantee: it fixes the world's land
// FRACTION, and cannot promise that any of that land is inside the square the
// player starts in.
// REJECTED ALTERNATIVE 2: stamp a fixed archipelago template into every starter
// square. Deterministic, but every world would wear the same islands in the
// same places, which is the defect this whole change exists to fix.
// REJECTED ALTERNATIVE 3: raise islands ANYWHERE in the world rather than in
// the starter square. Prettier on a map and useless on day one: only unlocked
// cells are reachable, so an island the player cannot walk to is scenery.

/**
 * How many separate islands a fresh world's starter square must contain.
 *
 * TWO — from the owner's words, "islands, not just a single island".
 *
 * It multiplies GENESIS_MIN_ISLAND_CELLS to give GENESIS_MIN_STARTER_LAND_CELLS,
 * which is what the pass actually measures; see that constant for why the
 * guarantee counts LAND rather than counting landmasses.
 */
export const GENESIS_MIN_STARTER_ISLANDS = 2;


/**
 * How much land a landmass needs before genesis counts it as an island, in
 * cells.
 *
 * A DELIBERATE RESTATEMENT of the wildlife plugin's MIN_FOUNDING_HABITAT_CELLS
 * (plugins/wildlife/server/census.ts) — the smallest habitat that gets a
 * founding population at all — not an import, because core must not depend on a
 * plugin. The agreement is pinned from the plugin side
 * (plugins/wildlife/test/wildlife.test.ts), exactly as
 * FRESH_SEABED_DEPTH_BELOW_SEA's relation to that plugin is.
 *
 * Restating it as half a neighbourhood squared rather than as the literal 1 024
 * keeps it a fact about the GROUND: an island a player can put a pair of
 * grazers on is one they can put a settlement on, and anything smaller is a
 * rock.
 */
export const GENESIS_MIN_ISLAND_CELLS = (NEIGHBOURHOOD_CELLS / 2) * (NEIGHBOURHOOD_CELLS / 2);

/**
 * How much usable land the starter square must hold, in cells: room for
 * GENESIS_MIN_STARTER_ISLANDS islands, counted only over landmasses that are
 * themselves at least GENESIS_MIN_ISLAND_CELLS.
 *
 * COUNTING LAND RATHER THAN LANDMASSES, and the reason is that a landmass count
 * is not something a lift can deliver. Genesis raises islands by lifting the
 * field; on a seed whose starter square is one continent, every extra lift
 * joins that continent and the count never moves — measured, the pass burned
 * all nine of its sites and still reported one landmass. Counting land instead
 * terminates, and it asks the question that matters: has the player got enough
 * ground to build on, in pieces big enough to be worth building on. Whether
 * that arrives as two islands or one coastline is the seed's business, and the
 * "not just a single island" half of the owner's request is answered by the
 * whole map — the land pass and the noise put islands across all of it.
 *
 * The per-landmass floor is what stops a scatter of rocks counting: a hundred
 * one-cell islets are not a place to live, which is the same judgement
 * GENESIS_MIN_ISLAND_CELLS already encodes.
 */
export const GENESIS_MIN_STARTER_LAND_CELLS =
  GENESIS_MIN_STARTER_ISLANDS * GENESIS_MIN_ISLAND_CELLS;

/**
 * How far above sea level a raised island's summit is LIFTED TO, in bands.
 *
 * DERIVED, not chosen: the lift falls one band per
 * GENESIS_TERRACE_WALL_CELLS_PER_BAND cells, so on ground of uniform depth an
 * island of summit height P encloses a disc of radius `P * WALL`. This is the
 * smallest P whose disc clears GENESIS_MIN_ISLAND_CELLS, plus one band of
 * margin for the fact that real ground is not uniform — the noise the island is
 * lifted out of slopes, so the coastline is never a circle and the area moves
 * with it.
 */
const GENESIS_ISLAND_PEAK_BANDS =
  Math.ceil(
    Math.sqrt(GENESIS_MIN_ISLAND_CELLS / Math.PI) / GENESIS_TERRACE_WALL_CELLS_PER_BAND,
  ) + 1;

/**
 * Radius of a raised island's flat summit, in cells — two world units, so the
 * summit is four world units across.
 *
 * Small on purpose. The summit is a place to put the first building, not the
 * island; almost all of an island's area comes from the terraced flanks below
 * it.
 */
const GENESIS_ISLAND_PLATEAU_RADIUS_CELLS = 2 * WORLD_UNIT_CELLS;

/**
 * The most bands genesis will lift a site by — enough to raise a summit out of
 * the DEEPEST ground the amplitude range allows, so every candidate site can
 * become an island however deep the water over it.
 *
 * IT CAPS THE LIFT; IT DOES NOT REJECT THE SITE. An uncapped lift on abyssal
 * ground would raise a mountain three hundred cells across whose flanks are the
 * only thing for miles — the "world object that does not belong on the ground it
 * sits on" the fidelity bar refuses — and it would also run past
 * GENESIS_ISLAND_REACH_CELLS, which is derived from this and is what makes the
 * per-cell bounding-box reject correct.
 *
 * Capping rather than dropping is a correction, and so is the size of the cap.
 * Dropping unaffordable sites left one seed in twenty with a single candidate,
 * so the pass raised one island and had nowhere else to try; capping at the
 * seabed depth then left nine sites that all failed to break the surface,
 * because the ground under them was abyss. At this value a site always CAN
 * become an island, and the cost of a large lift is paid only where it has to
 * be: sites are tried shallowest-first (see `genesisIslandSites`), so the
 * gentlest ground in the square is always used first.
 */
const GENESIS_ISLAND_MAX_LIFT_BANDS =
  GENESIS_ISLAND_PEAK_BANDS - GENESIS_NOISE_MIN_BAND_OFFSET;

/**
 * How far a raised island's lift reaches at all, in cells: the distance at
 * which the largest permitted lift has fallen back to zero. A bounding-box
 * reject, so it is an upper bound and not a shape.
 */
const GENESIS_ISLAND_REACH_CELLS =
  GENESIS_ISLAND_PLATEAU_RADIUS_CELLS +
  GENESIS_ISLAND_MAX_LIFT_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND;

/**
 * A lower bound on the land one raised island encloses, in cells — a disc of
 * radius `PEAK_BANDS * WALL` with π bounded below by 3.
 *
 * It must clear GENESIS_MIN_ISLAND_CELLS or the pass would raise islands its
 * own survey then refuses to count, and would work through its whole site list
 * on every world. Stated as a bound rather than as an exact area because the
 * area is NOT exact any more: an island is a lift applied to the seed's own
 * terrain, so its coast follows that terrain's contours and its size moves with
 * them. The guarantee does not rest on this number — the pass re-surveys and
 * tries another site — it is here so a change to the geometry that would make
 * the pass structurally useless fails a test instead.
 */
export const GENESIS_ISLAND_MIN_LAND_CELLS =
  3 * (GENESIS_ISLAND_PEAK_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND) ** 2;

/**
 * Candidate sites per axis inside the starter square — a 3 × 3 grid, so nine.
 *
 * THREE because of what has to fit between them: two islands whose land touches
 * would be one island to the survey, so sites have to be further apart than one
 * island's land diameter. At the shipped starter span the pitch is 92 cells
 * against a typical land diameter of 48, which leaves open water between
 * neighbouring sites without pushing them into the square's corners.
 *
 * NINE SITES FOR TWO ISLANDS, deliberately: the pass re-surveys after every
 * island it raises, and a site that lands on top of land the noise already drew
 * adds no new island. The spare sites are what let it keep trying.
 */
const GENESIS_ISLAND_SLOTS_PER_AXIS = 3;

/**
 * One island genesis decided to raise: where its summit is, and how many bands
 * the field has to be lifted there to put that summit above water.
 *
 * The lift is stored rather than recomputed because it depends on the noise at
 * the anchor, and `freshGenesisHeightAt` must stay a pure function of
 * `(terrain, x, y)` that never re-derives the field it is already evaluating.
 */
export interface GenesisIsland {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly liftBands: number;
}

/**
 * The islands' contribution at one cell, IN BANDS AND BEFORE THE WATERLINE IS
 * APPLIED — this is added to the noise's own band offset, not maximed over the
 * finished height.
 *
 * THAT DISTINCTION IS THE WHOLE POINT (owner review, 2026-08-26). Taking the
 * maximum of the terrain and a cone stamps the cone: its coastline is the
 * cone's own contour, so it renders as a disc with a halo, no matter how the
 * cone is jittered. ADDING the lift to the field instead moves the field's own
 * contour lines — the resulting coast is where `noise + lift` crosses sea
 * level, which follows the seed's terrain and comes out as ragged as everything
 * around it. Two islands lifted by the same amount on different ground are
 * different shapes, which is what "noise-shaped, not stamped" means.
 *
 * The falloff is terraced at GENESIS_TERRACE_WALL_CELLS_PER_BAND, the steepest
 * run the relaxation invariant calls stable, so a smooth stroke cannot slump
 * the island the guarantee rests on. Overlapping lifts take the larger rather
 * than summing: two sites close together should make one island, not a tower.
 *
 * A EUCLIDEAN radius, with the single `Math.sqrt` floored on the spot — the
 * same "integer-only, or an exactly-specified IEEE op with an immediate floor"
 * rule the trench walls follow.
 */
function islandLiftBandsAt(
  islands: readonly GenesisIsland[],
  x: number,
  y: number,
): number {
  let lift = 0;
  for (const island of islands) {
    const dx = x - island.anchorX;
    const dy = y - island.anchorY;
    if (dx > GENESIS_ISLAND_REACH_CELLS || dx < -GENESIS_ISLAND_REACH_CELLS) continue;
    if (dy > GENESIS_ISLAND_REACH_CELLS || dy < -GENESIS_ISLAND_REACH_CELLS) continue;

    const radius = Math.floor(Math.sqrt(dx * dx + dy * dy));
    const beyondPlateau = radius - GENESIS_ISLAND_PLATEAU_RADIUS_CELLS;
    const bands =
      island.liftBands -
      (beyondPlateau > 0 ? Math.floor(beyondPlateau / GENESIS_TERRACE_WALL_CELLS_PER_BAND) : 0);
    if (bands > lift) lift = bands;
  }
  return lift;
}

/** One connected landmass inside the starter square, as the island survey saw it. */
interface GenesisLandmass {
  /** Dry-land cells in it. */
  readonly cells: number;
  /** Every cell index (world-space, `y * size + x`), for the protection set. */
  readonly indices: number[];
}

/**
 * Labels every 8-connected landmass inside the starter square.
 *
 * EIGHT-CONNECTED, unlike the ocean survey's four: an ocean is measured for
 * whether something can SWIM through it, where a diagonal pinch is not water;
 * an island is measured for whether it reads as one piece of ground, and two
 * terraces touching at a corner plainly do.
 */
function surveyStarterLandmasses(
  terrain: FreshGenesisTerrain,
  heights: Int16Array,
): GenesisLandmass[] {
  const { size, unlockMinCell: lo, unlockMaxCell: hi } = terrain;
  const span = hi - lo + 1;
  const visited = new Uint8Array(span * span);
  const landmasses: GenesisLandmass[] = [];
  const stack: number[] = [];

  const isLandAt = (local: number): boolean => {
    const ly = (local / span) | 0;
    const lx = local - ly * span;
    return heights[(lo + ly) * size + lo + lx]! > SEA_LEVEL;
  };

  for (let start = 0; start < visited.length; start++) {
    if (visited[start] === 1 || !isLandAt(start)) continue;

    const indices: number[] = [];
    visited[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const local = stack.pop()!;
      const ly = (local / span) | 0;
      const lx = local - ly * span;
      indices.push((lo + ly) * size + lo + lx);

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = lx + ox;
          const ny = ly + oy;
          if (nx < 0 || ny < 0 || nx >= span || ny >= span) continue;
          const neighbour = ny * span + nx;
          if (visited[neighbour] === 1 || !isLandAt(neighbour)) continue;
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    landmasses.push({ cells: indices.length, indices });
  }

  return landmasses;
}

/**
 * The nine candidate sites inside the starter square, in the order this world
 * will try them, each carrying the lift its own ground needs.
 *
 * ORDERED SHALLOWEST GROUND FIRST, which is both the cheapest and the most
 * honest rule: an island wants to be where the sea floor already comes closest
 * to the surface, the lift it needs there is smallest, and a small lift
 * disturbs the least terrain around it. The seed still decides everything —
 * WHICH site is shallowest is a property of the field the seed drew — and an
 * avalanche of (site index, seed) breaks ties so a flat starter square, where
 * every site sits on identical ground, does not always pick the same corner.
 *
 * Sites needing more than GENESIS_ISLAND_MAX_LIFT_BANDS are dropped, unless
 * that would leave nothing to try, in which case the shallowest survives: a
 * world whose starter square is all abyss gets its islands rather than an
 * exception.
 */
function genesisIslandSites(terrain: FreshGenesisTerrain, seed: number): GenesisIsland[] {
  const span = terrain.unlockMaxCell - terrain.unlockMinCell + 1;
  // Inset by the reach of a typical island so its land stays inside the square
  // it is being raised for; a site on a tiny world can still overlap its
  // neighbours, which the re-survey loop then simply reads as "no new island".
  const inset = Math.min(
    GENESIS_ISLAND_PEAK_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND,
    Math.floor((span - 1) / 2),
  );
  const usable = span - 2 * inset;
  const pitch = Math.max(1, Math.floor(usable / GENESIS_ISLAND_SLOTS_PER_AXIS));

  const sites: { island: GenesisIsland; index: number; score: number }[] = [];
  for (let sy = 0; sy < GENESIS_ISLAND_SLOTS_PER_AXIS; sy++) {
    for (let sx = 0; sx < GENESIS_ISLAND_SLOTS_PER_AXIS; sx++) {
      const index = sy * GENESIS_ISLAND_SLOTS_PER_AXIS + sx;
      const anchorX = terrain.unlockMinCell + inset + sx * pitch + (pitch >> 1);
      const anchorY = terrain.unlockMinCell + inset + sy * pitch + (pitch >> 1);
      // The lift that puts THIS site's summit GENESIS_ISLAND_PEAK_BANDS above
      // sea level, given the ground the noise put under it. At least one band,
      // so a site already above water still gains a summit rather than nothing.
      const ground = genesisNoiseBandAt(terrain.noise, anchorX, anchorY);
      const liftBands = Math.min(
        GENESIS_ISLAND_MAX_LIFT_BANDS,
        Math.max(1, GENESIS_ISLAND_PEAK_BANDS - ground),
      );
      sites.push({
        island: { anchorX, anchorY, liftBands },
        index,
        score: genesisMix(index, seed),
      });
    }
  }

  sites.sort(
    (a, b) => a.island.liftBands - b.island.liftBands || a.score - b.score || a.index - b.index,
  );
  return sites.map((site) => site.island);
}

// ── The land pass ────────────────────────────────────────────────────────────
//
// THE PROBLEM. Whether a fresh world has any dry land at all is a property of
// the seed, and a calm or low-baseline draw produces an unbroken sheet of
// water. Measured over the suite's own seed sample before this pass existed,
// half of them came out at 1.4% land — which was ENTIRELY the islands the
// guarantee pass had raised. That is not "it's OK to create flat worlds"
// (owner, 2026-08-18); that is the archipelago failing to appear.
//
// THE PASS, in one number: a whole-band LIFT applied to the noise field's
// baseline, chosen as the smallest that puts GENESIS_MIN_LAND_PERCENT of the
// world's cells above sea level. It is a monotone shift of the whole field, so
// nothing is stamped, no shape is invented, and every contour the seed drew is
// exactly where it was — the water is simply lower against it. A world that
// already has enough land is lifted by zero and is byte-identical to what the
// noise drew.
//
// IT IS COMPUTED FROM A HISTOGRAM, not by trial and error: the land count at
// lift k is the number of cells whose UNCLAMPED band sum is at least 1 - k, so
// one pass over the field answers the question for every k at once. The clamp
// in `genesisNoiseBandAt` cannot disturb that — it only pulls values toward
// zero from outside the amplitude range, and never across sea level.
//
// REJECTED ALTERNATIVE 1: stamp extra islands until the fraction is met. That
// is the disc-stamping the owner rejected, applied to the whole map.
// REJECTED ALTERNATIVE 2: raise the baseline's DRAW RANGE so land is likelier.
// Cheaper still, and it guarantees nothing while also removing the low-baseline
// deep-ocean worlds the sea's depth variation comes from.

/**
 * The least dry land a fresh world may have, as a percentage of its cells.
 *
 * EIGHT PER CENT. Earth is 29%, and a world of ISLANDS rather than continents
 * belongs well below that; the floor is set by what a player must be able to
 * find rather than by what looks generous. At 8% the default 512-world-unit map
 * carries roughly 340 000 cells of land — about two hundred islands of
 * GENESIS_MIN_ISLAND_CELLS — so wherever the reveal takes a player there is
 * land within sailing distance, and 92% of the map is still the ocean the
 * game's water mechanics need.
 *
 * IT IS A FLOOR, NOT A TARGET: a seed that drew 40% land keeps it.
 */
export const GENESIS_MIN_LAND_PERCENT = 8;

/** Per cent → cells, in integer arithmetic. */
function genesisMinLandCells(size: number): number {
  return Math.ceil((size * size * GENESIS_MIN_LAND_PERCENT) / 100);
}

/**
 * Chooses this world's land lift, in whole bands, from the unclamped band sums
 * the noise drew.
 *
 * THE LAND FLOOR sets the lift: the smallest k for which at least
 * `genesisMinLandCells` cells reach band 1. Smallest, because every extra band
 * of lift is sea floor the player did not ask to lose.
 *
 * THE KRAKEN DOES NOT COMPETE WITH IT, and an earlier version of this function
 * had them competing — it walked the lift back down until a lair-sized basin
 * appeared, which cost the land floor on the very seeds that needed it most.
 * The two guarantees pull in opposite directions on ONE dial, so they cannot
 * share one; the basin has its own pass now (see `genesisBasins`), and this
 * function answers only the land question.
 */
function genesisLandLiftBands(raw: Int16Array, size: number): number {
  // Histogram of unclamped band sums, offset so index 0 is the deepest value
  // the amplitude range plus a full baseline can reach. Anything beyond either
  // end is clamped into it, which is safe: those cells are unambiguously land
  // or unambiguously sea at every lift this function considers.
  const floorBand = GENESIS_NOISE_MIN_BAND_OFFSET + GENESIS_BASELINE_MIN_BAND_OFFSET;
  const ceilingBand = GENESIS_NOISE_MAX_BAND_OFFSET - GENESIS_BASELINE_MIN_BAND_OFFSET;
  const buckets = new Int32Array(ceilingBand - floorBand + 1);
  for (let index = 0; index < raw.length; index++) {
    let bands = raw[index]!;
    if (bands < floorBand) bands = floorBand;
    else if (bands > ceilingBand) bands = ceilingBand;
    buckets[bands - floorBand] += 1;
  }

  const wanted = genesisMinLandCells(size);
  const maxLift = -floorBand;
  let land = 0;
  let lift = maxLift;
  // Walk the histogram down from the top: after adding bucket b, `land` is the
  // number of cells at band >= b, which is exactly the land count at lift 1 - b.
  for (let bands = ceilingBand; bands > floorBand; bands--) {
    land += buckets[bands - floorBand]!;
    if (land >= wanted) {
      lift = 1 - bands;
      break;
    }
  }
  if (lift < 0) lift = 0;

  return lift;
}

// ── The trench pass ──────────────────────────────────────────────────────────
//
// THE PROBLEM. How deep a fresh world's deepest ocean gets is a property of the
// seed, so before this pass existed fewer than half of all worlds had a basin
// deep AND large enough to host the monsters plugin's kraken, and the rest owed
// their players a mandatory dig. The owner ratified the guarantee (2026-08-19):
// a fresh world always HAS one.
//
// THE PASS. After the noise and the islands, genesis surveys its own oceans. If
// none of them is both large enough and deep enough it gouges ONE trench along
// a seed-chosen axis through the deepest ocean it did produce. Then — owner,
// 2026-08-25, "they should also have some random trenches" — it cuts
// GENESIS_EXTRA_TRENCH_MIN..MAX more, purely for the shape of the sea floor,
// wherever the seed points them.
//
// WHY "ALREADY OCEAN" IS THE LOAD-BEARING RULE, for the guarantee trench and
// the extras alike. Because a trench only ever lowers cells already at or below
// FRESH_SEABED_HEIGHT, the SET of deep-water cells is bit-for-bit what the
// noise and the islands produced: no cell enters deep water, none leaves it, no
// region splits or merges. So the trenches cannot move the habitat counts the
// pass before them just repaired, and cannot gouge a canyon across an island.
//
// REJECTED ALTERNATIVE 1: stamp a fixed basin at a fixed place. Every world
// would wear the same rectangle in the same spot, cut through whatever island
// the noise had put there.
// REJECTED ALTERNATIVE 2: bias the noise itself — force one lattice point deep.
// A single deep lattice point is interpolated into a broad soft bowl that reads
// nothing like a trench, and it does not actually guarantee the result.
// REJECTED ALTERNATIVE 3, AND ITS REVERSAL (#205, 2026-08-26): make the
// trenches meander for looks. Rejected as "a second geometry to reason about",
// on the assumption that meandering meant a curve — a spline or a random walk,
// with its own distance function, its own bounds and its own float error. It
// did not. A POLYLINE IS THE SAME SEGMENT GEOMETRY APPLIED N TIMES UNDER A
// `min`: identical point-to-segment arithmetic, identical integer axes,
// identical band-exact floor, and the union of the capsules is one trench
// because a minimum of distances has no seam. So the cost the note weighed
// against the shape was never charged, and the shape was worth having: clipping
// to the ocean's outline stopped a straight gouge reading as a stamp, but it
// did not stop it reading as a BAR, which is what the owner saw.

/**
 * Cells the guarantee trench's chosen basin must have, as a multiple of a
 * neighbourhood's area.
 *
 * A DELIBERATE RESTATEMENT of the monsters plugin's KRAKEN_LAIR_MIN_AREA_CHUNKS
 * (plugins/monsters/server/kinds.ts), pinned from the plugin side
 * (plugins/monsters/test/monsters.test.ts).
 */
export const GENESIS_TRENCH_MIN_BASIN_CHUNKS = 9;

/** That area in cells: 36 864. */
export const GENESIS_TRENCH_MIN_BASIN_CELLS =
  GENESIS_TRENCH_MIN_BASIN_CHUNKS * NEIGHBOURHOOD_CELLS * NEIGHBOURHOOD_CELLS;

/**
 * How deep a trench's floor is cut, in height units below sea level.
 *
 * The same restatement arrangement: this is the monsters plugin's
 * GENESIS_DEEP_OCEAN_REFERENCE_BAND — "the band a world WITH a deep ocean is
 * taken to bottom out at", the reference its kraken bar is derived from.
 * Cutting to exactly that depth is the point: a trench is not a special deeper
 * thing the generator can make, it is the deep ocean floor the bar was written
 * against, placed where the noise failed to put one.
 */
export const GENESIS_TRENCH_FLOOR_DEPTH_BELOW_SEA = 512;
export const GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA =
  GENESIS_TRENCH_FLOOR_DEPTH_BELOW_SEA / BAND_HEIGHT;

/**
 * The depth a basin must already reach for the guarantee to leave the world
 * alone, in whole bands below sea level.
 *
 * A RESTATEMENT OF THE DERIVATION rather than of the number: the plugin's bar
 * is the reference floor with one band of relaxation margin taken off it,
 * counted in the whole bands its admission test counts. Restating the
 * derivation is what makes the two sides move together if the reference band is
 * ever retuned; that they agree TODAY is pinned plugin-side.
 */
export const GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA = Math.floor(
  (GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA * BAND_HEIGHT - MAX_STEP / 2) / BAND_HEIGHT,
);

/** That bar as a height. A basin at or below this needs no guarantee trench. */
export const GENESIS_TRENCH_QUALIFYING_HEIGHT = heightAtBandsBelowSea(
  GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA,
);

/**
 * Half the length of a trench's flat floor, in cells.
 *
 * DERIVED from the minimum basin: the side of the smallest square that would
 * meet GENESIS_TRENCH_MIN_BASIN_CELLS, halved — so the trench is exactly as
 * long as the shortest lair the kraken accepts is wide. Long enough to read as
 * a rift rather than a crater, and short enough to sit inside the starter
 * square, which on a calm world is the only ocean there is.
 *
 * Since #205 a trench is a polyline rather than one segment, so this is half of
 * its TOTAL floor run rather than a distance from a centre.
 */
const GENESIS_TRENCH_HALF_LENGTH_CELLS = Math.round(
  Math.sqrt(GENESIS_TRENCH_MIN_BASIN_CELLS) / 2,
);

/**
 * How many straight segments a trench's floor is broken into — the fix for the
 * straight bars of GH #205.
 *
 * THREE. One segment is a capsule, and a capsule on an open sea floor reads as
 * a bar somebody laid down. Three gives a trench two bends, which is enough for
 * it to read as a rift the sea floor tore rather than a stamp, and few enough
 * that the whole thing still runs roughly one way instead of coiling. It also
 * divides 2 × GENESIS_TRENCH_HALF_LENGTH_CELLS (192) exactly, so the total
 * floor run is unchanged at 192 cells and no segment length needs rounding.
 */
const GENESIS_TRENCH_SEGMENTS = 3;

/** One segment's floor run, in cells: 192 / 3 = 64, an exact integer. */
const GENESIS_TRENCH_SEGMENT_CELLS =
  (2 * GENESIS_TRENCH_HALF_LENGTH_CELLS) / GENESIS_TRENCH_SEGMENTS;

/**
 * How far from the floor a trench still has any effect, in cells: the point at
 * which its walls have climbed all the way back to sea level, plus a whole
 * trench's floor run of slack. A cheap bounding-box reject measured from EVERY
 * vertex of the polyline, so it is a deliberately loose upper bound and not a
 * shape.
 */
const GENESIS_TRENCH_REACH_CELLS =
  GENESIS_TRENCH_HALF_LENGTH_CELLS +
  GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA * GENESIS_TERRACE_WALL_CELLS_PER_BAND;

/**
 * How many EXTRA trenches a world gets beyond the kraken guarantee, as an
 * inclusive range the seed picks from.
 *
 * ONE TO THREE. At least one, because the owner asked for "some random
 * trenches" and a range whose floor is zero would leave a visible share of
 * worlds with none. At most three, because each is
 * GENESIS_TRENCH_HALF_LENGTH_CELLS × 2 of floor plus walls — on the smallest
 * shipped world four of them would be most of the sea floor, and a sea floor
 * that is all trench is a flat sea floor with extra steps.
 *
 * The count comes from an avalanche of the seed, NOT from the world's RNG, so
 * adding it left the noise field every previously-pinned seed produces exactly
 * where it was.
 */
export const GENESIS_EXTRA_TRENCH_MIN = 1;
export const GENESIS_EXTRA_TRENCH_MAX = 3;

/**
 * Salts that keep every seed-derived choice in genesis — where the basin pass
 * drops its floor, and which basin / which anchor inside it / which axis a
 * trench takes — from ever agreeing with another by accident. They are
 * arbitrary distinct constants and nothing but distinctness is asked of them;
 * they are named rather than inlined so a new derivation cannot silently reuse
 * one.
 */
const GENESIS_BASIN_SITE_SALT = 0x21;
const GENESIS_TRENCH_COUNT_SALT = 0x01;
const GENESIS_TRENCH_BASIN_SALT = 0x100;
const GENESIS_TRENCH_AXIS_SALT = 0x200;
const GENESIS_TRENCH_ANCHOR_SALT = 0x300;
/**
 * The next free block, one per (trench, joint): which way each bend in a
 * trench's polyline turns. GENESIS_TRENCH_SEGMENTS entries per trench and at
 * most 1 + GENESIS_EXTRA_TRENCH_MAX trenches, so the block it uses is
 * 0x400..0x40b — comfortably inside its own 0x100 stride.
 */
const GENESIS_TRENCH_BEND_SALT = 0x400;

/**
 * The bend-salt ordinal the kraken guarantee's trench uses; the extras take
 * 1 + k. Distinct per trench so two trenches in one world never bend alike.
 */
const GENESIS_GUARANTEE_TRENCH_ORDINAL = 0;

/**
 * The eight directions a trench may run, as PRIMITIVE INTEGER vectors.
 *
 * Integer directions rather than an angle keep the whole distance computation
 * exact: the dot and cross products below are integers, and the single
 * `Math.sqrt` per cell is floored immediately (the "integer-only, or an
 * exactly-specified IEEE op with an immediate floor" rule shared/ terrain math
 * follows). Eight is enough that a trench does not read as axis-aligned
 * furniture; the 2:1 diagonals are there so the set is not just the compass
 * rose. Order is fixed — it IS the mapping from seed to orientation.
 */
const GENESIS_TRENCH_AXES: readonly (readonly [number, number])[] = [
  [1, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 1],
  [-1, 2],
  [-1, 1],
  [-2, 1],
];

/** One straight run of a trench's floor, from `vertices[i]` to `vertices[i+1]`. */
export interface GenesisTrenchSegment {
  /** Index into GENESIS_TRENCH_AXES — kept so the next bend can step off it. */
  readonly axisIndex: number;
  /** Primitive integer direction this run goes in. */
  readonly axisX: number;
  readonly axisY: number;
  /** |axis|², an exact integer: the scale the dot/cross products carry. */
  readonly axisLengthSquared: number;
  /**
   * This run's length along the axis, pre-multiplied by |axis|² so it can be
   * compared against the raw dot product directly. It is the EXACT
   * vertex-to-vertex distance rather than a rounding of
   * GENESIS_TRENCH_SEGMENT_CELLS, so consecutive runs meet with neither a gap
   * nor an overhang at the vertex they share.
   */
  readonly lengthScaled: number;
}

/**
 * One planned trench: a polyline to cut along, and the bounding box its walls
 * can reach.
 *
 * `vertices` has GENESIS_TRENCH_SEGMENTS + 1 entries. VERTEX 0 IS THE ANCHOR
 * CELL — the deepest cell of the basin for the guarantee trench, a
 * seed-scattered cell for an extra — so the cell the pass was aimed at is
 * always on the floor, exactly as it was when the trench was one centred
 * segment.
 */
export interface GenesisTrench {
  readonly vertices: readonly { readonly x: number; readonly y: number }[];
  readonly segments: readonly GenesisTrenchSegment[];
  /** Every vertex grown by GENESIS_TRENCH_REACH_CELLS: the early-out box. */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * One connected region of a fresh world's open ocean, as the trench pass's own
 * survey measured it.
 *
 * The extreme cell is chosen by (lowest height, then lowest anchor score, then
 * lowest cell index), which is a TOTAL order on cells and therefore independent
 * of the order the flood fill happens to visit them in. That is what lets the
 * fill use a plain depth-first stack without the result depending on traversal.
 *
 * WHY THE SCORE IS IN THAT ORDER AND NOT JUST THE INDEX. A calm seed's ocean is
 * FLAT: tens of thousands of cells tie at the same height, so "lowest index"
 * resolves every tie to the world's top-left corner and half the trench falls
 * off the map. The score breaks those ties somewhere seed-dependent inside the
 * region instead, and does nothing at all when the basin has a genuine single
 * deepest point.
 *
 * `anchorsBySalt` is the same idea used deliberately: one cell per extra
 * trench, each the region's minimum under a DIFFERENTLY salted score, so the
 * extras start from cells scattered through the basin rather than all piling
 * onto its deepest point. Collected during the same single fill, at the cost of
 * GENESIS_EXTRA_TRENCH_MAX comparisons per ocean cell.
 */
interface GenesisOceanRegion {
  cells: number;
  extremeHeight: number;
  extremeScore: number;
  extremeIndex: number;
  anchorScores: Int32Array;
  anchorsBySalt: Int32Array;
}

/**
 * Labels every connected region of open ocean in a world's genesis field as it
 * stands BEFORE any trench. "Open ocean" is `<= FRESH_SEABED_HEIGHT`, which is
 * exactly the deep-water line every habitat consumer uses.
 *
 * CONNECTIVITY IS 4-NEIGHBOUR, matching the monsters plugin's own survey (a
 * diagonal pinch is not water a 7-cell-wide animal swims through). If the two
 * disagreed, genesis could hand the kraken a basin its own admission test would
 * then split in half.
 *
 * COST: one visited byte per cell over a heightmap the caller already built.
 */
function surveyGenesisOceanRegions(
  heights: Int16Array,
  size: number,
  seed: number,
): GenesisOceanRegion[] {
  const cellCount = size * size;
  const visited = new Uint8Array(cellCount);
  const regions: GenesisOceanRegion[] = [];
  const stack: number[] = [];

  for (let seedIndex = 0; seedIndex < cellCount; seedIndex++) {
    if (visited[seedIndex] === 1 || heights[seedIndex]! > FRESH_SEABED_HEIGHT) continue;

    const region: GenesisOceanRegion = {
      cells: 0,
      extremeHeight: Number.POSITIVE_INFINITY,
      extremeScore: Number.POSITIVE_INFINITY,
      extremeIndex: seedIndex,
      anchorScores: new Int32Array(GENESIS_EXTRA_TRENCH_MAX).fill(-1),
      anchorsBySalt: new Int32Array(GENESIS_EXTRA_TRENCH_MAX).fill(seedIndex),
    };
    visited[seedIndex] = 1;
    stack.push(seedIndex);

    while (stack.length > 0) {
      const index = stack.pop()!;
      const height = heights[index]!;
      region.cells++;

      const score = genesisMix(index, seed);
      if (
        height < region.extremeHeight ||
        (height === region.extremeHeight &&
          (score < region.extremeScore ||
            (score === region.extremeScore && index < region.extremeIndex)))
      ) {
        region.extremeHeight = height;
        region.extremeScore = score;
        region.extremeIndex = index;
      }

      for (let salt = 0; salt < GENESIS_EXTRA_TRENCH_MAX; salt++) {
        // `>>> 1` keeps the avalanche inside Int32Array's signed range without
        // losing the property that matters (a total, seed-dependent order).
        const salted = genesisMix(index, seed + GENESIS_TRENCH_ANCHOR_SALT + salt) >>> 1;
        const best = region.anchorScores[salt]!;
        if (
          best < 0 ||
          salted < best ||
          (salted === best && index < region.anchorsBySalt[salt]!)
        ) {
          region.anchorScores[salt] = salted;
          region.anchorsBySalt[salt] = index;
        }
      }

      const x = index % size;
      const y = (index - x) / size;
      if (x > 0) pushOceanNeighbour(heights, visited, stack, index - 1);
      if (x + 1 < size) pushOceanNeighbour(heights, visited, stack, index + 1);
      if (y > 0) pushOceanNeighbour(heights, visited, stack, index - size);
      if (y + 1 < size) pushOceanNeighbour(heights, visited, stack, index + size);
    }

    regions.push(region);
  }

  return regions;
}

function pushOceanNeighbour(
  heights: Int16Array,
  visited: Uint8Array,
  stack: number[],
  index: number,
): void {
  if (visited[index] === 1 || heights[index]! > FRESH_SEABED_HEIGHT) return;
  visited[index] = 1;
  stack.push(index);
}

/**
 * Builds one trench from an anchor cell index, a starting axis, and the seed —
 * a GENESIS_TRENCH_SEGMENTS-run polyline starting at the anchor.
 *
 * EACH BEND IS ONE STEP AROUND GENESIS_TRENCH_AXES, ±1 with the sign taken from
 * the seed. One step is 22.5°-ish on that eight-direction wheel, so a trench
 * wanders without ever doubling back: over three runs it can turn at most 45°
 * either way from where it started, which is a rift with a kink in it rather
 * than a squiggle. `trenchOrdinal` keeps two trenches in the same world from
 * drawing the same bends.
 *
 * EVERY STEP IS INTEGER. The axes are primitive integer vectors of differing
 * length, so a run of GENESIS_TRENCH_SEGMENT_CELLS along one is `axis` repeated
 * `floor(cells / |axis|)` times — one `Math.sqrt` floored on the spot, and the
 * vertex it lands on is an exact integer cell.
 */
function trenchAt(
  index: number,
  size: number,
  axisIndex: number,
  seed: number,
  trenchOrdinal: number,
): GenesisTrench {
  const anchorX = index % size;
  const anchorY = (index - anchorX) / size;

  const vertices: { x: number; y: number }[] = [{ x: anchorX, y: anchorY }];
  const segments: GenesisTrenchSegment[] = [];
  let nextAxisIndex = axisIndex;

  for (let i = 0; i < GENESIS_TRENCH_SEGMENTS; i++) {
    const [axisX, axisY] = GENESIS_TRENCH_AXES[nextAxisIndex]!;
    const axisLengthSquared = axisX * axisX + axisY * axisY;
    const steps = Math.floor(
      GENESIS_TRENCH_SEGMENT_CELLS / Math.sqrt(axisLengthSquared),
    );
    segments.push({
      axisIndex: nextAxisIndex,
      axisX,
      axisY,
      axisLengthSquared,
      // (steps · axis) · axis = steps · |axis|², exactly the run's dot-product
      // length at the scale `along` is measured in.
      lengthScaled: steps * axisLengthSquared,
    });

    const from = vertices[i]!;
    vertices.push({ x: from.x + axisX * steps, y: from.y + axisY * steps });

    // The bend into the NEXT run: one step clockwise or anticlockwise around
    // the axis wheel, the direction avalanched from (seed, this joint).
    const turn =
      genesisMix(seed, GENESIS_TRENCH_BEND_SALT + trenchOrdinal * GENESIS_TRENCH_SEGMENTS + i) & 1
        ? 1
        : -1;
    nextAxisIndex =
      (nextAxisIndex + turn + GENESIS_TRENCH_AXES.length) % GENESIS_TRENCH_AXES.length;
  }

  let minX = vertices[0]!.x;
  let maxX = minX;
  let minY = vertices[0]!.y;
  let maxY = minY;
  for (const vertex of vertices) {
    if (vertex.x < minX) minX = vertex.x;
    if (vertex.x > maxX) maxX = vertex.x;
    if (vertex.y < minY) minY = vertex.y;
    if (vertex.y > maxY) maxY = vertex.y;
  }

  return {
    vertices,
    segments,
    minX: minX - GENESIS_TRENCH_REACH_CELLS,
    maxX: maxX + GENESIS_TRENCH_REACH_CELLS,
    minY: minY - GENESIS_TRENCH_REACH_CELLS,
    maxY: maxY + GENESIS_TRENCH_REACH_CELLS,
  };
}

/**
 * Plans this world's trenches: the kraken guarantee first (or nothing, where
 * the noise already qualified), then the extras.
 *
 * THE GUARANTEE'S NO-OP CASE FIRST: any ocean region both big enough to be a
 * lair and already reaching GENESIS_TRENCH_QUALIFYING_HEIGHT means the noise
 * did the job. Otherwise the trench is centred on the deepest cell of the
 * deepest ocean region that IS big enough, so the guarantee lands in the ocean
 * the world already has. Ties break on more cells, then on the lower cell
 * index: a total order, so the choice never depends on discovery order.
 *
 * THE DEGENERATE FALLBACK, named rather than discovered later: a world can be
 * too small for ANY of its ocean to be a lair. Such a world cannot host a
 * kraken at any depth, trench or no trench, so this deepens its largest ocean
 * anyway and lets the area half of the plugin's admission test do the refusing
 * — the alternative, throwing, would make an unusual self-hosted WORLD_SIZE
 * unbootable for a guarantee it was never able to keep.
 *
 * THE EXTRAS are not a guarantee and have no no-op case: they are texture, so
 * every world gets between GENESIS_EXTRA_TRENCH_MIN and _MAX of them, each in a
 * seed-chosen basin, at a seed-chosen anchor inside it, on a seed-chosen axis.
 * A world with no ocean at all gets none, because there is nothing to cut.
 */
function planGenesisTrenches(
  heights: Int16Array,
  size: number,
  seed: number,
): GenesisTrench[] {
  const regions = surveyGenesisOceanRegions(heights, size, seed);

  let deepestLairSized: GenesisOceanRegion | null = null;
  let largest: GenesisOceanRegion | null = null;
  let alreadyQualifies = false;

  for (const region of regions) {
    if (
      largest === null ||
      region.cells > largest.cells ||
      (region.cells === largest.cells && region.extremeIndex < largest.extremeIndex)
    ) {
      largest = region;
    }

    if (region.cells < GENESIS_TRENCH_MIN_BASIN_CELLS) continue;
    if (region.extremeHeight <= GENESIS_TRENCH_QUALIFYING_HEIGHT) {
      alreadyQualifies = true;
      continue;
    }

    if (
      deepestLairSized === null ||
      region.extremeHeight < deepestLairSized.extremeHeight ||
      (region.extremeHeight === deepestLairSized.extremeHeight &&
        (region.cells > deepestLairSized.cells ||
          (region.cells === deepestLairSized.cells &&
            region.extremeIndex < deepestLairSized.extremeIndex)))
    ) {
      deepestLairSized = region;
    }
  }

  const trenches: GenesisTrench[] = [];
  if (!alreadyQualifies) {
    const chosen = deepestLairSized ?? largest;
    if (chosen !== null) {
      trenches.push(
        trenchAt(
          chosen.extremeIndex,
          size,
          genesisMix(seed, GENESIS_TRENCH_AXIS_SALT) % GENESIS_TRENCH_AXES.length,
          seed,
          GENESIS_GUARANTEE_TRENCH_ORDINAL,
        ),
      );
    }
  }

  if (regions.length > 0) {
    // Basins big enough to be worth cutting, in a total order (more cells
    // first, then lowest cell index) so the seed indexes a stable list.
    const candidates = regions
      .filter((region) => region.cells >= GENESIS_TRENCH_MIN_BASIN_CELLS)
      .sort((a, b) => b.cells - a.cells || a.extremeIndex - b.extremeIndex);
    const pool = candidates.length > 0 ? candidates : regions;

    const extras =
      GENESIS_EXTRA_TRENCH_MIN +
      (genesisMix(seed, GENESIS_TRENCH_COUNT_SALT) %
        (GENESIS_EXTRA_TRENCH_MAX - GENESIS_EXTRA_TRENCH_MIN + 1));

    for (let k = 0; k < extras; k++) {
      const region = pool[genesisMix(seed, GENESIS_TRENCH_BASIN_SALT + k) % pool.length]!;
      trenches.push(
        trenchAt(
          region.anchorsBySalt[k]!,
          size,
          genesisMix(seed, GENESIS_TRENCH_AXIS_SALT + 1 + k) % GENESIS_TRENCH_AXES.length,
          seed,
          GENESIS_GUARANTEE_TRENCH_ORDINAL + 1 + k,
        ),
      );
    }
  }

  return trenches;
}

/**
 * One trench's floor at one cell, applied to that cell's untrenched genesis
 * height. Returns `base` untouched unless the cell is already open ocean (the
 * rule that keeps every habitat classification exactly where the passes before
 * this one put it) and the trench wants it DEEPER than it is.
 *
 * The depth profile is a CHAIN OF CAPSULES under a minimum: full depth
 * anywhere on the floor polyline, then one band shallower per
 * GENESIS_TERRACE_WALL_CELLS_PER_BAND cells of distance from the NEAREST
 * segment, so the result is always an exact band multiple. Taking the minimum
 * over segments is what makes the union one trench rather than three: a bend is
 * covered from both sides, so there is no notch at a joint.
 *
 * `along` and `across` are the dot and cross products with the segment's axis,
 * measured from the segment's START vertex, so both carry a factor of |axis|;
 * the distance is de-scaled by dividing the squared sum by |axis|² inside the
 * one `Math.sqrt`, whose result is floored on the spot. `overhang` is how far
 * past either END of the run the cell lies, which is zero alongside it.
 */
function deepenedByTrenches(
  trenches: readonly GenesisTrench[],
  x: number,
  y: number,
  base: number,
): number {
  if (base > FRESH_SEABED_HEIGHT) return base;

  let height = base;
  for (const trench of trenches) {
    if (x < trench.minX || x > trench.maxX || y < trench.minY || y > trench.maxY) continue;

    let distance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < trench.segments.length; i++) {
      const segment = trench.segments[i]!;
      const start = trench.vertices[i]!;
      const dx = x - start.x;
      const dy = y - start.y;

      const along = dx * segment.axisX + dy * segment.axisY;
      const overhang =
        along < 0 ? -along : along > segment.lengthScaled ? along - segment.lengthScaled : 0;
      const across = dx * segment.axisY - dy * segment.axisX;
      const toSegment = Math.floor(
        Math.sqrt((overhang * overhang + across * across) / segment.axisLengthSquared),
      );
      if (toSegment < distance) distance = toSegment;
    }

    const bands =
      GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA -
      Math.floor(distance / GENESIS_TERRACE_WALL_CELLS_PER_BAND);
    if (bands <= 0) continue;

    const floor = clampHeight(heightAtBandsBelowSea(bands));
    if (floor < height) height = floor;
  }
  return height;
}

// ── The basin pass ───────────────────────────────────────────────────────────
//
// THE PROBLEM. The monsters plugin's kraken needs one CONNECTED region of open
// ocean of GENESIS_TRENCH_MIN_BASIN_CELLS, and the trench pass below cannot
// supply it: a trench only ever LOWERS cells that are already deep, so it can
// deepen an ocean but never merge a fragmented one into a lair. Measured over
// the monsters suite's 48 probe seeds, 22 of them drew a world whose oceans
// were all too small — an island-rich map is a map of small seas.
//
// THE PASS. If no ocean is lair-sized, DROP the field around the lowest cell
// the world has, by the same terraced lift the island pass uses and with its
// sign reversed. Because the drop is added to the field's band offset rather
// than written over its heights, the basin's outline is the seed's own terrain
// pushed under the deep-water line — the bathymetric mirror of an island, and
// not a stamped disc.
//
// IT COSTS LAND, and the land pass is asked again afterwards: dropping a
// basin's worth of field can push a world back under GENESIS_MIN_LAND_PERCENT,
// so the lift is topped up until it is not. Raising the lift cannot undo the
// basin — the field is clamped to the amplitude range BEFORE the drop is
// applied, so every extra band of lift stops at the ceiling while the drop goes
// on from there.

/**
 * Radius of the basin's lair-sized floor, in cells, and how many bands the
 * field is dropped at its centre to get one.
 *
 * BOTH ARE DERIVED. The radius is the smallest disc whose area clears
 * GENESIS_TRENCH_MIN_BASIN_CELLS, plus one band's run of margin for the fact
 * that the terraced falloff quantises the edge. The drop is what guarantees the
 * whole of that disc lands below the deep-water line WHATEVER the terrain under
 * it: the falloff loses one band per GENESIS_TERRACE_WALL_CELLS_PER_BAND cells,
 * so at the rim it has given up `radius / WALL` bands, and it starts from a
 * field that the amplitude clamp holds at no more than
 * GENESIS_NOISE_MAX_BAND_OFFSET.
 */
const GENESIS_BASIN_RADIUS_CELLS =
  Math.ceil(Math.sqrt(GENESIS_TRENCH_MIN_BASIN_CELLS / Math.PI)) +
  GENESIS_TERRACE_WALL_CELLS_PER_BAND;
const GENESIS_BASIN_DROP_BANDS =
  Math.ceil(GENESIS_BASIN_RADIUS_CELLS / GENESIS_TERRACE_WALL_CELLS_PER_BAND) +
  FRESH_SEABED_BANDS_BELOW_SEA +
  GENESIS_NOISE_MAX_BAND_OFFSET;

/** How far the basin's drop reaches at all, in cells — a bounding-box reject. */
const GENESIS_BASIN_REACH_CELLS =
  GENESIS_BASIN_DROP_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND;

/** One basin genesis had to drop: where its floor is centred. */
export interface GenesisBasin {
  readonly anchorX: number;
  readonly anchorY: number;
}

/**
 * The basins' contribution at one cell, in bands, as a POSITIVE number to be
 * subtracted. Overlapping basins take the deepest rather than summing, for the
 * same reason overlapping islands take the tallest: two anchors close together
 * should make one basin, not a shaft.
 */
function basinDropBandsAt(
  basins: readonly GenesisBasin[],
  x: number,
  y: number,
): number {
  let drop = 0;
  for (const basin of basins) {
    const dx = x - basin.anchorX;
    const dy = y - basin.anchorY;
    if (dx > GENESIS_BASIN_REACH_CELLS || dx < -GENESIS_BASIN_REACH_CELLS) continue;
    if (dy > GENESIS_BASIN_REACH_CELLS || dy < -GENESIS_BASIN_REACH_CELLS) continue;

    const radius = Math.floor(Math.sqrt(dx * dx + dy * dy));
    const bands =
      GENESIS_BASIN_DROP_BANDS - Math.floor(radius / GENESIS_TERRACE_WALL_CELLS_PER_BAND);
    if (bands > drop) drop = bands;
  }
  return drop;
}

/**
 * Does this heightmap already contain an ocean big enough to be a kraken lair?
 *
 * FOUR-NEIGHBOUR, matching the trench pass's own survey and the monsters
 * plugin's lair survey — a diagonal pinch is not water a seven-cell-wide animal
 * swims through, and if the three disagreed genesis could promise a basin the
 * plugin then splits in half.
 */
function hasLairSizedOcean(heights: Int16Array, size: number): boolean {
  const visited = new Uint8Array(heights.length);
  const stack: number[] = [];
  for (let start = 0; start < heights.length; start++) {
    if (visited[start] === 1 || heights[start]! > FRESH_SEABED_HEIGHT) continue;
    let cells = 0;
    visited[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      cells++;
      const x = index % size;
      const y = (index - x) / size;
      if (x > 0) pushOceanNeighbour(heights, visited, stack, index - 1);
      if (x + 1 < size) pushOceanNeighbour(heights, visited, stack, index + 1);
      if (y > 0) pushOceanNeighbour(heights, visited, stack, index - size);
      if (y + 1 < size) pushOceanNeighbour(heights, visited, stack, index + size);
    }
    if (cells >= GENESIS_TRENCH_MIN_BASIN_CELLS) return true;
  }
  return false;
}

/**
 * Where to drop this world's basin: the lowest cell it has, ties broken by an
 * avalanche of (cell index, seed) and then by the index itself.
 *
 * THE LOWEST CELL, because that is where the world's water already is — the
 * basin deepens the sea the seed drew rather than flooding a valley the seed
 * meant to be dry. The seeded tie-break matters for the same reason the trench
 * pass needs one: a calm world's sea floor is a plateau of identical heights,
 * and "lowest index" would put every such world's basin in the same corner.
 */
function genesisBasinSite(heights: Int16Array, size: number, seed: number): GenesisBasin {
  let bestIndex = 0;
  let bestHeight = Number.POSITIVE_INFINITY;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < heights.length; index++) {
    const height = heights[index]!;
    if (height > bestHeight) continue;
    const score = genesisMix(index, seed + GENESIS_BASIN_SITE_SALT);
    if (height < bestHeight || score < bestScore) {
      bestHeight = height;
      bestScore = score;
      bestIndex = index;
    }
  }
  const x = bestIndex % size;
  const y = (bestIndex - x) / size;
  // HELD A FULL RADIUS CLEAR OF THE MAP EDGE. The world's lowest cell is very
  // often on one, and a basin centred there is a half-disc — measured, 20 000
  // cells against the 36 864 the lair needs, and five of the monsters suite's
  // 48 probe seeds failed on exactly that. The pull-in costs nothing: every
  // cell within the radius of the chosen one is ocean too, or the world would
  // have had a lair-sized one already.
  return {
    anchorX: keepBasinInside(x, size),
    anchorY: keepBasinInside(y, size),
  };
}

/** Pulls one basin coordinate far enough from the edge for its floor to fit. */
function keepBasinInside(coordinate: number, size: number): number {
  if (size <= 2 * GENESIS_BASIN_RADIUS_CELLS) return size >> 1;
  if (coordinate < GENESIS_BASIN_RADIUS_CELLS) return GENESIS_BASIN_RADIUS_CELLS;
  const highest = size - 1 - GENESIS_BASIN_RADIUS_CELLS;
  return coordinate > highest ? highest : coordinate;
}

// ── Putting genesis together ─────────────────────────────────────────────────

/**
 * Everything genesis needs to answer "what height is (x, y)", built once per
 * world by `buildFreshGenesisTerrain`. Bundled so `freshGenesisHeightAt` stays
 * a pure function of `(terrain, x, y)` — no RNG state, no world lookups.
 *
 * The four fields are also the four LAYERS, applied in exactly this order: the
 * noise field (already carrying the land pass's lift), the basin dropped out of
 * it, the islands lifted out of it, and the trenches cut into what is left of
 * the ocean. Only the last one works on heights; the middle two are band
 * offsets applied before the waterline, which is what keeps a raised island's
 * coast and a dropped basin's outline on the seed's own contours instead of on
 * stamped circles.
 *
 * THE AMPLITUDE CLAMP SITS BETWEEN THE NOISE AND THE PASSES, not after them.
 * That is what makes the basin's depth provable — it starts from a field that
 * can be no higher than GENESIS_NOISE_MAX_BAND_OFFSET, so a fixed drop is
 * enough whatever the seed drew, and topping up the land lift afterwards cannot
 * undo it.
 */
export interface FreshGenesisTerrain {
  readonly size: number;
  /** The starter unlock square's cell-space bounds, both axes, inclusive. */
  readonly unlockMinCell: number;
  readonly unlockMaxCell: number;
  readonly noise: GenesisNoiseField;
  /** The kraken's basin, where the world's own oceans were all too small. */
  readonly basins: readonly GenesisBasin[];
  /** Islands the pass had to raise — empty when the noise already had enough. */
  readonly islands: readonly GenesisIsland[];
  /** The kraken guarantee (0 or 1 of them) followed by the extras. */
  readonly trenches: readonly GenesisTrench[];
}

/** Genesis height of one cell, with the four layers applied in order. */
export function freshGenesisHeightAt(
  terrain: FreshGenesisTerrain,
  x: number,
  y: number,
): number {
  const bands =
    clampNoiseBand(genesisNoiseRawBandAt(terrain.noise, x, y)) +
    islandLiftBandsAt(terrain.islands, x, y) -
    basinDropBandsAt(terrain.basins, x, y);
  return deepenedByTrenches(terrain.trenches, x, y, clampHeight(bands * BAND_HEIGHT));
}

/**
 * Re-renders every cell the island pass can reach — the starter square, grown
 * by GENESIS_ISLAND_REACH_CELLS on every side.
 *
 * GROWN, and not just the square: an island near the square's edge lifts ground
 * past that edge, so re-rendering the square alone would leave the world-wide
 * height buffer disagreeing with `freshGenesisHeightAt` exactly where the
 * trench survey then reads it.
 */
function renderStarterNeighbourhood(terrain: FreshGenesisTerrain, into: Int16Array): void {
  const { size } = terrain;
  const lo = Math.max(0, terrain.unlockMinCell - GENESIS_ISLAND_REACH_CELLS);
  const hi = Math.min(size - 1, terrain.unlockMaxCell + GENESIS_ISLAND_REACH_CELLS);
  for (let y = lo; y <= hi; y++) {
    const row = y * size;
    for (let x = lo; x <= hi; x++) into[row + x] = freshGenesisHeightAt(terrain, x, y);
  }
}

/**
 * Builds one world's genesis terrain from its size and seed. The only function
 * in genesis that touches the RNG or `Math.random` — call it exactly once per
 * world, the way `World.createFresh` does.
 *
 * THREE PHASES, and the order is the contract:
 *
 *   1. The noise field, which is the ONLY consumer of the RNG, followed
 *      immediately by the LAND PASS — a single whole-band lift folded into that
 *      field. Folding it in rather than layering it on top is what keeps the
 *      rest of genesis reading one field instead of two.
 *   2. The ISLAND PASS, which lifts the field further around seed-chosen sites
 *      inside the starter square until the square really has its islands.
 *   3. The TRENCH PASS, which only ever lowers cells that are ALREADY deep
 *      water, so it can move no cell's shallow/deep classification and cannot
 *      gouge a canyon across an island.
 *
 * ONE FULL EVALUATION OF THE NOISE, and that is deliberate: the land pass needs
 * the unclamped band sums for its histogram, so it keeps them, and every height
 * before the islands is arithmetic on that array rather than a second sweep
 * through five octaves of bilinear interpolation.
 */
export function buildFreshGenesisTerrain(size: number, seed: number): FreshGenesisTerrain {
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const unlockMinCell = startChunk * CHUNK_SIZE;
  const rng = mulberry32Rng(seed);
  const drawn = buildGenesisNoiseField(size, rng);

  // The one full evaluation of the noise. Every height genesis needs before the
  // islands is arithmetic on this array rather than a second sweep through five
  // octaves of bilinear interpolation.
  const raw = new Int16Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) raw[row + x] = genesisNoiseRawBandAt(drawn, x, y);
  }

  let landLiftBands = genesisLandLiftBands(raw, size);
  let basins: readonly GenesisBasin[] = [];
  let heights = renderNoiseAndBasins(raw, size, landLiftBands, basins);

  if (!hasLairSizedOcean(heights, size)) {
    basins = [genesisBasinSite(heights, size, seed)];
    heights = renderNoiseAndBasins(raw, size, landLiftBands, basins);

    // The basin drowned land the land floor was counting on. Top the lift back
    // up — bounded, because each round is a whole-world sweep, and terminating
    // because the basin's reach is bounded and everything outside it rises.
    const wanted = genesisMinLandCells(size);
    for (
      let round = 0;
      round < GENESIS_LAND_TOPUP_ROUNDS && countLand(heights) < wanted;
      round++
    ) {
      landLiftBands++;
      heights = renderNoiseAndBasins(raw, size, landLiftBands, basins);
    }
  }

  const bare: FreshGenesisTerrain = {
    size,
    unlockMinCell,
    unlockMaxCell: unlockMinCell + spanChunks * CHUNK_SIZE - 1,
    noise: { ...drawn, landLiftBands },
    basins,
    islands: [],
    trenches: [],
  };

  // THE ISLAND LOOP RE-SURVEYS rather than counting what it planned: lifting
  // ground next to ground the noise already had above water produces one bigger
  // island, not two, so the only honest way to know whether the guarantee is
  // met is to look. It stops when it runs out of sites, which is the degenerate
  // case a world below MIN_WORLD_SIZE can reach — as much island as fits, and
  // no exception, on the same reasoning as the trench pass's own fallback.
  let islands: readonly GenesisIsland[] = [];
  let used = 0;
  const sites = genesisIslandSites(bare, seed);
  let raised: FreshGenesisTerrain = bare;
  while (starterIslandLandCells(raised, heights) < GENESIS_MIN_STARTER_LAND_CELLS) {
    if (used >= sites.length) break;
    islands = [...islands, sites[used++]!];
    raised = { ...bare, islands };
    renderStarterNeighbourhood(raised, heights);
  }

  return { ...raised, trenches: planGenesisTrenches(heights, size, seed) };
}

/**
 * How many times the land lift may be topped up after a basin is dropped.
 *
 * FOUR. Each round is a whole-world sweep, and each one raises every cell
 * outside the basin by a whole band — 64 height units of coastline — so a world
 * that is still short after four is one whose land the basin genuinely took,
 * and another band would be flooding the map to satisfy a floor. Bounded rather
 * than open-ended because a `while` here would be a whole-world loop with no
 * proof of termination in the one place genesis must never hang: world boot.
 */
const GENESIS_LAND_TOPUP_ROUNDS = 4;

/**
 * The heightmap as it stands after the noise, the land lift and the basins —
 * everything before the islands, which is all the basin and land passes need to
 * see. Pure arithmetic on the band sums already in hand.
 */
function renderNoiseAndBasins(
  raw: Int16Array,
  size: number,
  landLiftBands: number,
  basins: readonly GenesisBasin[],
): Int16Array {
  const heights = new Int16Array(raw.length);
  for (let index = 0; index < raw.length; index++) {
    const x = index % size;
    const y = (index - x) / size;
    const bands =
      clampNoiseBand(raw[index]! + landLiftBands) - basinDropBandsAt(basins, x, y);
    heights[index] = clampHeight(bands * BAND_HEIGHT);
  }
  return heights;
}

/** Dry cells in a whole heightmap. */
function countLand(heights: Int16Array): number {
  let land = 0;
  for (const height of heights) if (height > SEA_LEVEL) land++;
  return land;
}

/**
 * Cells of land in the starter square that sit in a landmass big enough to
 * count as an island — the number the guarantee is measured against.
 */
function starterIslandLandCells(terrain: FreshGenesisTerrain, heights: Int16Array): number {
  let cells = 0;
  for (const mass of surveyStarterLandmasses(terrain, heights)) {
    if (mass.cells >= GENESIS_MIN_ISLAND_CELLS) cells += mass.cells;
  }
  return cells;
}


/**
 * Last-resort fallback for the deep-water guarantee: forces the world's lowest
 * cell (ties broken by lowest index — a total order) down to
 * FRESH_SEABED_HEIGHT and returns that height so the caller can re-verify.
 *
 * Reachable only by a world so small that the habitat pass's proportional clamp
 * left the deep target at zero — below MIN_WORLD_SIZE, which config.ts refuses
 * to boot. Deliberately a POST-CHECK rather than folded into the construction:
 * this path is expected to run zero times for every size anyone ships, and
 * keeping it separate means the main generation loop stays a simple, auditable
 * pure function of `(terrain, x, y)`.
 */
export function carveFallbackAbyss(map: Heightmap, size: number): number {
  let lowestIndex = 0;
  let lowest = MAX_HEIGHT;
  for (let index = 0; index < size * size; index++) {
    const height = map.cells[index]!;
    if (height < lowest) {
      lowest = height;
      lowestIndex = index;
    }
  }
  map.cells[lowestIndex] = FRESH_SEABED_HEIGHT;
  return FRESH_SEABED_HEIGHT;
}
