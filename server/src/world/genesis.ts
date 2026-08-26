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
 */
function mulberry32Rng(seed: number): () => number {
  let state = seed >>> 0;
  return function nextRandom(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
 * design has always described (§1, "an ocean with a coast") and the one the
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
 * WHY IT IS NOT 1 (a uniform draw). Roughness is the dial between "flat sea"
 * and "full relief", and drawn uniformly it puts a FIFTH of all worlds below
 * 0.2 — measured over 200 seeds — where the field's whole relief is a few bands
 * and the only land in the world is what the island pass raised. That is a
 * fresh world with no archipelago in it, which is the defect this change
 * exists to fix, repeated on 20% of worlds.
 *
 * A SQUARE ROOT rather than a floor under the draw, and that distinction is the
 * design choice: a floor would make the owner's flat world (2026-08-18, "it's
 * OK to create flat worlds") unreachable, whereas a skew leaves every roughness
 * in [0, 1) possible and simply makes the calm end rare — P(roughness < 0.2)
 * falls from 20% to 4%. Every world remains a draw, and no world is forbidden.
 */
const GENESIS_ROUGHNESS_SKEW_EXPONENT = 1 / 2;

const GENESIS_BASELINE_CEILING_DIVISOR = 4;
const GENESIS_BASELINE_MIN_BAND_OFFSET = -FRESH_SEABED_BANDS_BELOW_SEA;
const GENESIS_BASELINE_MAX_BAND_OFFSET =
  GENESIS_NOISE_MAX_BAND_OFFSET / GENESIS_BASELINE_CEILING_DIVISOR;

/**
 * One octave's lattice: row-major integer band offsets, `cols` wide and tall.
 * The offsets are ZERO-MEAN WANDER, not heights — the world's baseline is added
 * once, by `genesisNoiseBandAt`, rather than once per octave.
 */
interface GenesisNoiseOctave {
  readonly spacingCells: number;
  readonly bandOffsets: Int16Array;
  readonly cols: number;
}

/** A whole world's noise field — the baseline it settles at, and every octave. */
export interface GenesisNoiseField {
  /** The band offset a perfectly calm world would be flat at, everywhere. */
  readonly baselineBandOffset: number;
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
 * ROUGHNESS AND BASELINE, TOGETHER. `roughness`, in [0, 1), scales how far
 * every lattice point may wander from `baseline`: at 1 the coarse octave alone
 * spans the full amplitude, and at 0 every point of every octave is exactly
 * zero — a flat world at the baseline — both ends of the SAME continuum rather
 * than a special-cased flat mode bolted on beside the noise.
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
  const roughness = Math.pow(rng(), GENESIS_ROUGHNESS_SKEW_EXPONENT);

  const octaves = GENESIS_NOISE_OCTAVES.map(({ spacingCells, amplitudeDivisor }) => {
    const amplitude = (halfSpan * roughness) / amplitudeDivisor;
    // +2, not +1: interpolation reads lattice[gx + 1], so the grid needs one
    // more column/row than the number of spacing-steps across the world.
    const cols = Math.floor((size - 1) / spacingCells) + 2;
    const bandOffsets = new Int16Array(cols * cols);
    for (let j = 0; j < cols; j++) {
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        bandOffsets[row + i] = Math.round((rng() * 2 - 1) * amplitude);
      }
    }
    return { spacingCells, bandOffsets, cols };
  });

  return { baselineBandOffset, octaves };
}

/**
 * Bilinearly interpolated band offset of ONE octave at one cell, entirely in
 * integer arithmetic: the interpolation weights are the integer cell-within-
 * lattice-square offsets `fx`/`fy` (each in `[0, spacing)`) rather than a
 * `[0, 1)` float, so every intermediate product is an exact integer and the one
 * division at the end is the only place rounding happens.
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
 * The whole field's band offset at one cell: the baseline plus every octave's
 * wander, clamped to the amplitude limits.
 *
 * THE CLAMP IS ON THE SUM, not on the octaves, which is what makes the limits
 * mean what they say: no cell of a fresh world is ever more than
 * GENESIS_NOISE_MAX_HEIGHT_ABOVE_SEA above sea level or
 * GENESIS_NOISE_MIN_DEPTH_BELOW_SEA below it, however the octaves stack. It
 * also gives a very rough world flat-topped mesas and flat-floored abyssal
 * plains where the sum runs past a limit, which reads as terrain rather than as
 * clipping precisely because the world is terraced anyway.
 */
function genesisNoiseBandAt(field: GenesisNoiseField, x: number, y: number): number {
  let bands = field.baselineBandOffset;
  for (const octave of field.octaves) bands += octaveBandAt(octave, x, y);
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
// THE PASS. Count the separate islands the noise already drew inside the
// starter square. If there are fewer than GENESIS_MIN_STARTER_ISLANDS of them
// at GENESIS_MIN_ISLAND_CELLS or more, raise terraced islands at seed-chosen
// anchors until there are — re-surveying after each one, so the count the pass
// stops on is the count the world really has, not the count it intended.
//
// REJECTED ALTERNATIVE 1: bias the noise so land is likelier. Cheapest of all
// and it guarantees nothing — a guarantee you have to re-check is not one — and
// it would drown the flat-world case the owner explicitly asked to keep.
// REJECTED ALTERNATIVE 2: stamp a fixed archipelago template into every starter
// square. Deterministic, but every world would wear the same three islands in
// the same three places, which is the defect this whole change exists to fix.
// REJECTED ALTERNATIVE 3: raise islands ANYWHERE in the world rather than in
// the starter square. Prettier on a map and useless on day one: only unlocked
// cells are reachable, so an island the player cannot walk to is scenery.

/**
 * How many separate islands a fresh world's starter square must contain.
 *
 * TWO, and this is a CEILING IMPOSED BY ARITHMETIC rather than a taste
 * judgement — the owner's brief proposed three. The starter square is
 * INITIAL_UNLOCK_CHUNK_SPAN chunks a side (102 400 cells at the shipped
 * geometry) and the day-one habitat minima below already claim 96 000 of them
 * (32 000 shallow + 64 000 deep). An island cannot be raised without a skirt:
 * its flanks descend at GENESIS_TERRACE_WALL_CELLS_PER_BAND, so getting from
 * the summit down to the seabed takes 64 cells of run on every side and turns
 * ~17 000 cells of deep water into shallow. Three islands would force ~51 000
 * cells of shallow plus their own land, against a deep-water minimum of 64 000
 * in a square of 102 400: the sum is over 118 000 and there is no arrangement
 * of the terrain that satisfies it. Two islands force at most 5 832 of land
 * (GENESIS_ISLAND_MAX_LAND_CELLS apiece) beside 32 000 shallow and 64 000 deep
 * — 101 832 — which fits.
 *
 * Two is also exactly what the owner asked for in words — "islands, not just a
 * single island". A third becomes possible the moment either the whale's
 * density or the starter square's size moves; both are owner decisions, so this
 * constant states the arithmetic rather than quietly picking a side of it.
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
 * How high a raised island stands above sea level, in height units — 64, four
 * bands.
 *
 * Four terraces is a hill you can see from across the starter square and read
 * as land, not as a sandbar that vanishes at the first smooth stroke. It is
 * also a QUARTER of the noise field's own ceiling, so a manufactured island
 * never out-tops the terrain the seed drew: the guarantee is a floor under the
 * world, never the most dramatic thing in it.
 */
const GENESIS_ISLAND_PEAK_HEIGHT_ABOVE_SEA = GENESIS_NOISE_MAX_HEIGHT_ABOVE_SEA / 4;
const GENESIS_ISLAND_PEAK_BANDS = GENESIS_ISLAND_PEAK_HEIGHT_ABOVE_SEA / BAND_HEIGHT;

/**
 * Radius of a raised island's flat summit, in cells — two world units, so the
 * summit is four world units across.
 *
 * Small on purpose. The summit is a place to put the first building, not the
 * island; almost all of an island's area comes from the terraced flanks below
 * it. Widening it is the cheapest way to grow the island, which is exactly why
 * it is pinned to a unit of ground rather than tuned: see
 * GENESIS_ISLAND_MAX_LAND_CELLS for the budget it has to fit inside.
 */
const GENESIS_ISLAND_PLATEAU_RADIUS_CELLS = 2 * WORLD_UNIT_CELLS;

/**
 * How far an island's coastline wanders in or out from a perfect circle, in
 * cells — ONE BAND'S WORTH OF RUN.
 *
 * WITHOUT IT AN ISLAND LOOKS BUILT, NOT BORN. A terraced cone of constant
 * radius renders as a ziggurat: a squared-off, concentric staircase that reads
 * as somebody's monument sitting in the sea, which is precisely the "world
 * object that does not belong on the ground it sits on" the fidelity bar
 * rejects. The wobble is taken from the FINEST NOISE OCTAVE at the same cell
 * (see islandCoastWobbleCells), so an island's coast is drawn by the same hand
 * as the coastlines around it, at the same scale, rather than by a jitter of
 * its own.
 *
 * ONE BAND OF RUN because that is the smallest displacement that moves a
 * terrace edge a whole terrace, and because the bound it puts on the island's
 * radius is what keeps GENESIS_ISLAND_MIN_LAND_CELLS above the bar the survey
 * counts against. On a perfectly flat world the finest octave is zero
 * everywhere and the island degenerates to a clean circular atoll — still not a
 * square, and still the honest picture of a world with no relief in it.
 */
const GENESIS_ISLAND_COAST_WOBBLE_CELLS = GENESIS_TERRACE_WALL_CELLS_PER_BAND;

/**
 * Radius of a raised island's DRY LAND, in cells, before the coast wobble.
 *
 * Derived from the terrace geometry, not chosen: the summit is
 * GENESIS_ISLAND_PEAK_BANDS bands up and the flanks lose one band per
 * GENESIS_TERRACE_WALL_CELLS_PER_BAND cells, so the last cell still above sea
 * level sits `PEAK_BANDS * WALL - 1` cells beyond the summit's edge — 23.
 */
const GENESIS_ISLAND_LAND_RADIUS_CELLS =
  GENESIS_ISLAND_PLATEAU_RADIUS_CELLS +
  GENESIS_ISLAND_PEAK_BANDS * GENESIS_TERRACE_WALL_CELLS_PER_BAND -
  1;

/**
 * Bounds on the land area of one raised island, in cells. Both are DISC areas
 * bounded by integers — 3 r² below π r² and 4 r² above it — taken at the
 * radius the wobble can shrink the island to and grow it to respectively, so
 * both hold whatever the noise does to the coast.
 *
 * THEY ARE WHAT MAKES THE TWO GUARANTEES COMPATIBLE, and both directions are
 * load-bearing:
 *   * the MINIMUM (1 083) must clear GENESIS_MIN_ISLAND_CELLS (1 024), or the
 *     pass would raise islands its own survey then refuses to count and would
 *     work through its whole slot list on every world;
 *   * GENESIS_MIN_STARTER_ISLANDS × the MAXIMUM (2 916) must fit in the land
 *     the starter square has left after both habitat minima — see
 *     GENESIS_MIN_STARTER_ISLANDS for that sum.
 * Both hold with margin; widening the summit by one more world unit breaks the
 * second.
 */
export const GENESIS_ISLAND_MIN_LAND_CELLS =
  3 * (GENESIS_ISLAND_LAND_RADIUS_CELLS - GENESIS_ISLAND_COAST_WOBBLE_CELLS) ** 2;
export const GENESIS_ISLAND_MAX_LAND_CELLS =
  4 * (GENESIS_ISLAND_LAND_RADIUS_CELLS + GENESIS_ISLAND_COAST_WOBBLE_CELLS) ** 2;

/**
 * How far a raised island reaches in total, in cells: the distance at which its
 * flanks have descended all the way to the seabed and stop being able to raise
 * anything, plus the wobble. A bounding-box reject, so it is an upper bound and
 * not a shape.
 */
const GENESIS_ISLAND_REACH_CELLS =
  GENESIS_ISLAND_PLATEAU_RADIUS_CELLS +
  (GENESIS_ISLAND_PEAK_BANDS + FRESH_SEABED_BANDS_BELOW_SEA) *
    GENESIS_TERRACE_WALL_CELLS_PER_BAND +
  GENESIS_ISLAND_COAST_WOBBLE_CELLS;

/**
 * Anchor slots per axis inside the starter square — a 3 × 3 grid, so nine
 * candidate island sites.
 *
 * THREE because of what has to fit between them: two islands whose LAND touches
 * would be one island to the survey, so slots have to be further apart than one
 * island's land diameter. At the shipped starter span the grid pitch is 91
 * cells against a land diameter of at most 55, leaving 36 cells of water
 * between neighbouring sites — comfortably separate without the sites being so
 * far apart that they only ever land in the square's corners.
 *
 * NINE SITES FOR TWO ISLANDS, deliberately: the pass re-surveys after every
 * island it raises, and a site that lands on top of land the noise already drew
 * adds no new island. The spare sites are what let it keep trying.
 */
const GENESIS_ISLAND_SLOTS_PER_AXIS = 3;

/** One island genesis decided to raise: a summit anchor, in cell coordinates. */
export interface GenesisIsland {
  readonly anchorX: number;
  readonly anchorY: number;
}

/**
 * How many cells the coastline is pushed out (negative) or pulled in (positive)
 * at one cell, from the finest noise octave.
 *
 * SCALED THE WAY A SLOPE SCALES: a bump of one band displaces a natural
 * shoreline by GENESIS_TERRACE_WALL_CELLS_PER_BAND cells, so that is the
 * conversion, clamped to GENESIS_ISLAND_COAST_WOBBLE_CELLS. Read raw, the
 * finest octave carries barely a band of relief and moved the coast by a cell —
 * invisible, and the island still rendered as a perfect circle.
 *
 * The octave is drawn on a quarter-neighbourhood lattice and bilinearly
 * interpolated, so the displacement varies smoothly over sixteen cells rather
 * than per cell: a coastline, not a fringe.
 */
function islandCoastWobbleCells(field: GenesisNoiseField, x: number, y: number): number {
  const finest = field.octaves[field.octaves.length - 1]!;
  const bands = octaveBandAt(finest, x, y) * GENESIS_TERRACE_WALL_CELLS_PER_BAND;
  if (bands > GENESIS_ISLAND_COAST_WOBBLE_CELLS) return GENESIS_ISLAND_COAST_WOBBLE_CELLS;
  if (bands < -GENESIS_ISLAND_COAST_WOBBLE_CELLS) return -GENESIS_ISLAND_COAST_WOBBLE_CELLS;
  return bands;
}

/**
 * The islands' contribution to one cell: full peak within the summit plateau,
 * then one band lower per GENESIS_TERRACE_WALL_CELLS_PER_BAND cells of radius
 * beyond it, with the coast wobble added to the radius.
 *
 * A EUCLIDEAN radius, with the single `Math.sqrt` floored on the spot — the
 * same "integer-only, or an exactly-specified IEEE op with an immediate floor"
 * rule the trench walls follow. A Chebyshev (square) radius was what this
 * started as and it is exactly wrong here: it draws a squared-off ziggurat,
 * which is the artificial look the wobble exists to break.
 *
 * GENESIS RAISES, NEVER LOWERS, so an island laid over ground the noise already
 * put higher leaves it alone. That is what keeps the pass from gouging a
 * terrace into an existing hillside, and it is why the pass has to re-survey
 * rather than assume each island it raises is a new one.
 */
function raisedByIslands(
  terrain: FreshGenesisTerrain,
  x: number,
  y: number,
  base: number,
): number {
  let height = base;
  for (const island of terrain.islands) {
    const dx = x - island.anchorX;
    const dy = y - island.anchorY;
    if (dx > GENESIS_ISLAND_REACH_CELLS || dx < -GENESIS_ISLAND_REACH_CELLS) continue;
    if (dy > GENESIS_ISLAND_REACH_CELLS || dy < -GENESIS_ISLAND_REACH_CELLS) continue;

    const radius =
      Math.floor(Math.sqrt(dx * dx + dy * dy)) + islandCoastWobbleCells(terrain.noise, x, y);
    const beyondPlateau = radius - GENESIS_ISLAND_PLATEAU_RADIUS_CELLS;
    const bands =
      GENESIS_ISLAND_PEAK_BANDS -
      (beyondPlateau > 0 ? Math.floor(beyondPlateau / GENESIS_TERRACE_WALL_CELLS_PER_BAND) : 0);

    const wanted = clampHeight(bands * BAND_HEIGHT);
    if (wanted > height) height = wanted;
  }
  return height;
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
 * The nine candidate anchors inside the starter square, in the order this
 * world's seed wants to use them.
 *
 * The grid itself is fixed geometry (see GENESIS_ISLAND_SLOTS_PER_AXIS); only
 * the ORDER is seed-derived, by an avalanche of (slot index, seed) sorted
 * ascending with the slot index as the final tie-break. That is a total order,
 * so two worlds of the same size and seed always try the same sites in the same
 * sequence, and two different seeds essentially never do.
 */
function genesisIslandSlots(terrain: FreshGenesisTerrain, seed: number): GenesisIsland[] {
  const span = terrain.unlockMaxCell - terrain.unlockMinCell + 1;
  // Inset by the land radius so an island's dry land stays inside the square it
  // is being raised for; a slot on a tiny world can still overlap its
  // neighbours, which the re-survey loop then simply reads as "no new island".
  const inset = Math.min(
    GENESIS_ISLAND_LAND_RADIUS_CELLS + GENESIS_ISLAND_COAST_WOBBLE_CELLS,
    Math.floor((span - 1) / 2),
  );
  const usable = span - 2 * inset;
  const pitch = Math.max(1, Math.floor(usable / GENESIS_ISLAND_SLOTS_PER_AXIS));

  const slots: { island: GenesisIsland; index: number; score: number }[] = [];
  for (let sy = 0; sy < GENESIS_ISLAND_SLOTS_PER_AXIS; sy++) {
    for (let sx = 0; sx < GENESIS_ISLAND_SLOTS_PER_AXIS; sx++) {
      const index = sy * GENESIS_ISLAND_SLOTS_PER_AXIS + sx;
      slots.push({
        island: {
          anchorX: terrain.unlockMinCell + inset + sx * pitch + (pitch >> 1),
          anchorY: terrain.unlockMinCell + inset + sy * pitch + (pitch >> 1),
        },
        index,
        score: genesisMix(index, seed),
      });
    }
  }

  slots.sort((a, b) => a.score - b.score || a.index - b.index);
  return slots.map((slot) => slot.island);
}

// ── The habitat pass ─────────────────────────────────────────────────────────
//
// THE PROBLEM. The wildlife plugin's day-one census only counts UNLOCKED cells,
// so the starter square IS the habitat budget of a new world. The fixed profile
// this change removes split that budget by construction and the plugin's tests
// asserted the exact split. Left to the noise alone, a seed can hand a world an
// all-shallow starter square (no whales, no deep-sea creatures) or an all-abyss
// one (no fish).
//
// THE PASS. Count shallow and deep cells in the starter square. If either is
// short of the minimum the plugin needs, RESCALE the square: sort its cells by
// height, decide by rank which of them must be deep, shallow and land, and
// remap each of those three groups monotonically into the band window its class
// occupies. The square comes out as the landscape the noise drew with its
// waterline moved, not as terrain replaced. See planGenesisHabitatRepair.
//
// WHAT IT NEVER TOUCHES: land belonging to a counted island (see the island
// pass), so repairing habitat cannot un-do the island guarantee. It also never
// WRITES land — every height it writes lands inside one of the two water
// windows — so it cannot invent an island either.
//
// FEASIBILITY IS PROVEN, not hoped for. The protected land is at most
// GENESIS_MIN_STARTER_ISLANDS islands' worth (see
// genesisStarterIslandProtectionBudget) and the two minima are clamped to the
// cells left over (see genesisHabitatTargets), so the two rank boundaries
// always fall inside the list they index.
//
// REJECTED ALTERNATIVE: keep the exact-census contract by keeping a fixed
// shelf. That is the thing the owner asked to remove, and the reason it was
// ever exact is that a test asserted a number rather than a need.

/**
 * How much shallow water the starter square must hold, in cells.
 *
 * A DELIBERATE RESTATEMENT of the wildlife plugin's own arithmetic — core must
 * not import a plugin, so the numbers are stated here and the AGREEMENT is
 * pinned from the plugin side (plugins/wildlife/test/wildlife.test.ts), exactly
 * as FRESH_SEABED_DEPTH_BELOW_SEA's relation to that plugin is.
 *
 * The need being restated: FISH_SCHOOLS_ON_FRESH_SHELF (1) complete school of
 * `groupSize` (5) fish, at the fish density of 400 square world units each. One
 * school and not one fish, because a school is a thing you recognise by seeing
 * more than one of them.
 */
const GENESIS_FISH_SCHOOLS_ON_FRESH_SHELF = 1;
const GENESIS_FISH_SCHOOL_SIZE = 5;
const GENESIS_SHALLOW_CELLS_PER_FISH = cellsOverArea(400);
export const GENESIS_MIN_STARTER_SHALLOW_CELLS =
  GENESIS_FISH_SCHOOLS_ON_FRESH_SHELF * GENESIS_FISH_SCHOOL_SIZE * GENESIS_SHALLOW_CELLS_PER_FISH;

/**
 * How much deep water the starter square must hold, in cells — the same
 * restatement arrangement as the shallow minimum above.
 *
 * The need: TWO whales, at the whale density of 2 000 square world units each.
 * Two, not a whole WHALE_POD_SIZE pod, because two is the pair the 2026-08-21
 * whale retune deliberately sized day one for; the third joins as territory
 * creeps outward.
 *
 * THIS IS THE LARGEST SINGLE CLAIM ON THE STARTER SQUARE — 64 000 of its
 * 102 400 cells, 62.5% — and it is what caps GENESIS_MIN_STARTER_ISLANDS at
 * two. Anyone retuning the whale density should read that constant's comment
 * before deciding it is only a wildlife change.
 */
const GENESIS_WHALES_ON_FRESH_SEA = 2;
const GENESIS_DEEP_CELLS_PER_WHALE = cellsOverArea(2000);
export const GENESIS_MIN_STARTER_DEEP_CELLS =
  GENESIS_WHALES_ON_FRESH_SEA * GENESIS_DEEP_CELLS_PER_WHALE;

/**
 * The most land the habitat pass will protect for ONE island, in cells.
 *
 * Everything the starter square is not obliged to give the two habitat minima
 * is land budget, split evenly between the islands the guarantee counts. At the
 * shipped geometry that is (102 400 - 96 000) / 2 = 3 200 cells apiece, against
 * a raised island's own 1 521 — so a raised island always fits, and a NATURAL
 * landmass is only counted toward the island guarantee (and therefore only
 * protected) if it is small enough to fit too. A continent filling the starter
 * square is not; it is left to the repair to drown, and the pass raises its own
 * islands on what remains.
 *
 * Without that cap the two guarantees would contradict each other on exactly
 * the seeds where land is plentiful: protecting a 90 000-cell landmass leaves
 * nowhere to put 64 000 cells of deep water.
 */
function genesisStarterIslandProtectionBudget(terrain: FreshGenesisTerrain): number {
  const span = terrain.unlockMaxCell - terrain.unlockMinCell + 1;
  const spare =
    span * span - GENESIS_MIN_STARTER_SHALLOW_CELLS - GENESIS_MIN_STARTER_DEEP_CELLS;
  return Math.max(
    GENESIS_MIN_ISLAND_CELLS,
    Math.floor(spare / GENESIS_MIN_STARTER_ISLANDS),
  );
}

/**
 * The shallow and deep cell counts this world's starter square is actually held
 * to, given how many of its cells are protected island land.
 *
 * At every size the project ships these ARE the two minima. They are clamped —
 * and clamped PROPORTIONALLY, in the ratio the minima themselves stand in —
 * only for a world below MIN_WORLD_SIZE, which config.ts refuses to boot and
 * only a direct `World.createFresh` call (a test, in practice) can reach. The
 * proportional clamp is what keeps such a world from losing one habitat class
 * entirely: splitting the ratio leaves both alive and both small, where a
 * priority order would leave one at zero and bring back the 2026-08-14 bug of
 * deep-water wildlife with nowhere to live.
 */
function genesisHabitatTargets(
  terrain: FreshGenesisTerrain,
  protectedCells: number,
): { shallow: number; deep: number } {
  const span = terrain.unlockMaxCell - terrain.unlockMinCell + 1;
  const wanted = GENESIS_MIN_STARTER_SHALLOW_CELLS + GENESIS_MIN_STARTER_DEEP_CELLS;
  const budget = Math.min(span * span - protectedCells, wanted);
  if (budget <= 0) return { shallow: 0, deep: 0 };
  const shallow = Math.floor((budget * GENESIS_MIN_STARTER_SHALLOW_CELLS) / wanted);
  return { shallow, deep: budget - shallow };
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
// REJECTED ALTERNATIVE 3: make the trenches meander for looks. Buys shape at
// the cost of a second geometry to reason about; clipping a straight gouge to
// the ocean's own outline already keeps it from reading as a stamp.

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
 */
const GENESIS_TRENCH_HALF_LENGTH_CELLS = Math.round(
  Math.sqrt(GENESIS_TRENCH_MIN_BASIN_CELLS) / 2,
);

/**
 * How far from the floor segment a trench still has any effect, in cells: the
 * point at which its walls have climbed all the way back to sea level. A cheap
 * bounding-box reject, so it is an upper bound and not a shape.
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
 * Salts that keep every seed-derived choice in genesis — the habitat repair's
 * anchor on each axis, and which basin / which anchor inside it / which axis a
 * trench takes — from ever agreeing with another by accident. They are
 * arbitrary distinct constants and nothing but distinctness is asked of them;
 * they are named rather than inlined so a new derivation cannot silently reuse
 * one.
 */
const GENESIS_REPAIR_ANCHOR_X_SALT = 0x11;
const GENESIS_REPAIR_ANCHOR_Y_SALT = 0x12;
const GENESIS_TRENCH_COUNT_SALT = 0x01;
const GENESIS_TRENCH_BASIN_SALT = 0x100;
const GENESIS_TRENCH_AXIS_SALT = 0x200;
const GENESIS_TRENCH_ANCHOR_SALT = 0x300;

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

/** One planned trench: a line segment to cut along, and how far it reaches. */
export interface GenesisTrench {
  /** Centre of the floor segment. */
  readonly centreX: number;
  readonly centreY: number;
  /** Primitive integer direction the floor segment runs along. */
  readonly axisX: number;
  readonly axisY: number;
  /** |axis|², an exact integer: the scale the dot/cross products carry. */
  readonly axisLengthSquared: number;
  /** Half the floor length, pre-multiplied by |axis| to match that scale. */
  readonly halfLengthScaled: number;
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

/** Builds one trench from an anchor cell index and an axis choice. */
function trenchAt(index: number, size: number, axisIndex: number): GenesisTrench {
  const [axisX, axisY] = GENESIS_TRENCH_AXES[axisIndex]!;
  const axisLengthSquared = axisX * axisX + axisY * axisY;
  const centreX = index % size;
  return {
    centreX,
    centreY: (index - centreX) / size,
    axisX,
    axisY,
    axisLengthSquared,
    halfLengthScaled: Math.floor(
      GENESIS_TRENCH_HALF_LENGTH_CELLS * Math.sqrt(axisLengthSquared),
    ),
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
 * The depth profile is a capsule: full depth within `halfLength` of the centre
 * along the axis, then one band shallower per
 * GENESIS_TERRACE_WALL_CELLS_PER_BAND cells of distance from that segment, so
 * the result is always an exact band multiple.
 *
 * `along` and `across` are the dot and cross products with the axis, so both
 * carry a factor of |axis|; the distance is de-scaled by dividing the squared
 * sum by |axis|² inside the one `Math.sqrt`, whose result is floored on the
 * spot.
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
    const dx = x - trench.centreX;
    const dy = y - trench.centreY;
    if (dx > GENESIS_TRENCH_REACH_CELLS || dx < -GENESIS_TRENCH_REACH_CELLS) continue;
    if (dy > GENESIS_TRENCH_REACH_CELLS || dy < -GENESIS_TRENCH_REACH_CELLS) continue;

    const along = Math.abs(dx * trench.axisX + dy * trench.axisY) - trench.halfLengthScaled;
    const overhang = along > 0 ? along : 0;
    const across = dx * trench.axisY - dy * trench.axisX;
    const distance = Math.floor(
      Math.sqrt((overhang * overhang + across * across) / trench.axisLengthSquared),
    );

    const bands =
      GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA -
      Math.floor(distance / GENESIS_TERRACE_WALL_CELLS_PER_BAND);
    if (bands <= 0) continue;

    const floor = clampHeight(heightAtBandsBelowSea(bands));
    if (floor < height) height = floor;
  }
  return height;
}

// ── Putting genesis together ─────────────────────────────────────────────────

/**
 * Everything genesis needs to answer "what height is (x, y)", built once per
 * world by `buildFreshGenesisTerrain`. Bundled so `freshGenesisHeightAt` stays
 * a pure function of `(terrain, x, y)` — no RNG state, no world lookups.
 *
 * The four fields are also the four LAYERS, applied in exactly this order: the
 * noise underneath, the islands raised on it, the trenches cut into what is
 * left of the ocean, and the habitat repairs written over the top. Later layers
 * can only affect cells earlier ones left in a class they are allowed to touch,
 * which is what makes each guarantee survive the passes after it.
 */
export interface FreshGenesisTerrain {
  readonly size: number;
  /** The starter unlock square's cell-space bounds, both axes, inclusive. */
  readonly unlockMinCell: number;
  readonly unlockMaxCell: number;
  readonly noise: GenesisNoiseField;
  /** Islands the pass had to raise — empty when the noise already had enough. */
  readonly islands: readonly GenesisIsland[];
  /** The kraken guarantee (0 or 1 of them) followed by the extras. */
  readonly trenches: readonly GenesisTrench[];
  /** Cell index → height, for the starter cells the habitat pass had to fix. */
  readonly habitatOverrides: ReadonlyMap<number, number>;
}

/**
 * Genesis height of one cell, with the four layers applied in order.
 *
 * THE HABITAT OVERRIDE SITS UNDER THE TRENCHES, not over them, and that
 * ordering is load-bearing in both directions: a trench may still deepen a cell
 * the habitat pass wrote (it was written as open ocean, and deepening open
 * ocean cannot change its class), while a trench can never raise one back into
 * the shallows. Put the override last instead and a trench anchored on a
 * repaired cell would have its own floor overwritten, which is the one thing
 * the kraken guarantee cannot survive.
 */
export function freshGenesisHeightAt(
  terrain: FreshGenesisTerrain,
  x: number,
  y: number,
): number {
  let base: number | undefined;
  if (terrain.habitatOverrides.size > 0) {
    base = terrain.habitatOverrides.get(y * terrain.size + x);
  }
  if (base === undefined) {
    const noise = clampHeight(genesisNoiseBandAt(terrain.noise, x, y) * BAND_HEIGHT);
    base = raisedByIslands(terrain, x, y, noise);
  }
  return deepenedByTrenches(terrain.trenches, x, y, base);
}

/** Renders a whole terrain into a fresh Int16Array — the surveys' input. */
function renderGenesisField(terrain: FreshGenesisTerrain): Int16Array {
  const { size } = terrain;
  const heights = new Int16Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) heights[row + x] = freshGenesisHeightAt(terrain, x, y);
  }
  return heights;
}

/**
 * Re-renders every cell the island and habitat passes can reach — the starter
 * square, grown by GENESIS_ISLAND_REACH_CELLS on every side.
 *
 * GROWN, and not just the square: an island anchored near the square's edge
 * runs its skirt out past that edge, so re-rendering the square alone would
 * leave the world-wide height buffer disagreeing with `freshGenesisHeightAt`
 * exactly where the trench survey then reads it.
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
 * FOUR PHASES, and the order is the contract:
 *
 *   1. The noise field, which is the ONLY consumer of the RNG. A given seed
 *      therefore draws the same field regardless of which passes exist.
 *   2. The island pass, which raises land and so must run before anything that
 *      counts habitat.
 *   3. The habitat pass, which repairs shallow/deep counts and is forbidden
 *      from touching the islands' land.
 *   4. The trench pass, which only ever lowers cells that are ALREADY deep
 *      water and therefore cannot move a single habitat classification the
 *      pass before it just fixed.
 */
export function buildFreshGenesisTerrain(size: number, seed: number): FreshGenesisTerrain {
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const unlockMinCell = startChunk * CHUNK_SIZE;
  const rng = mulberry32Rng(seed);

  const bare: FreshGenesisTerrain = {
    size,
    unlockMinCell,
    unlockMaxCell: unlockMinCell + spanChunks * CHUNK_SIZE - 1,
    noise: buildGenesisNoiseField(size, rng),
    islands: [],
    trenches: [],
    habitatOverrides: new Map<number, number>(),
  };

  const heights = renderGenesisField(bare);

  // THE ISLAND AND HABITAT PASSES RUN TOGETHER, in a loop, because neither can
  // be checked without the other having run. Islands must be raised BEFORE the
  // habitat counts are repaired (an island converts thousands of deep cells to
  // shallow, and reserving for that up front does not fit inside the starter
  // square — see GENESIS_MIN_STARTER_ISLANDS), while the island guarantee can
  // only be VERIFIED on the field the repair leaves behind, since the repair is
  // free to drown any land it did not have to protect.
  //
  // So: stage the islands raised so far, repair habitat around them, look at
  // the result, and if the starter square still has too few islands, add the
  // next candidate site and do it again. The loop is bounded by the number of
  // sites, terminates on the guarantee rather than on an intention, and is a
  // byte-for-byte no-op on the first iteration when the noise already qualified
  // (no islands staged, no repairs needed).
  let islands: readonly GenesisIsland[] = [];
  let sited = 0;
  const sites = genesisIslandSlots(bare, seed);
  let repaired: FreshGenesisTerrain;
  for (;;) {
    const staged: FreshGenesisTerrain = { ...bare, islands };
    renderStarterNeighbourhood(staged, heights);
    repaired = {
      ...staged,
      habitatOverrides: planGenesisHabitatRepair(
        staged,
        heights,
        seed,
        genesisGuardedLand(staged, heights),
      ),
    };
    if (repaired.habitatOverrides.size > 0) renderStarterNeighbourhood(repaired, heights);

    if (countStarterIslands(repaired, heights) >= GENESIS_MIN_STARTER_ISLANDS) break;
    // Out of sites: the degenerate case a world below MIN_WORLD_SIZE can reach.
    // It gets as many islands as fit and no exception, on the same reasoning as
    // the trench pass's own degenerate fallback.
    if (sited >= sites.length) break;
    islands = [...islands, sites[sited++]!];
  }

  return { ...repaired, trenches: planGenesisTrenches(heights, size, seed) };
}

/** Landmasses in the starter square big enough to count as islands. */
function countStarterIslands(terrain: FreshGenesisTerrain, heights: Int16Array): number {
  return surveyStarterLandmasses(terrain, heights).filter(
    (mass) => mass.cells >= GENESIS_MIN_ISLAND_CELLS,
  ).length;
}

/** Every cell one raised island holds above sea level, by its own geometry alone. */
function genesisIslandLandCells(terrain: FreshGenesisTerrain, island: GenesisIsland): number[] {
  const { size } = terrain;
  const reach = GENESIS_ISLAND_LAND_RADIUS_CELLS + GENESIS_ISLAND_COAST_WOBBLE_CELLS;
  const alone: FreshGenesisTerrain = { ...terrain, islands: [island] };
  const cells: number[] = [];
  for (let y = Math.max(0, island.anchorY - reach); y <= Math.min(size - 1, island.anchorY + reach); y++) {
    for (let x = Math.max(0, island.anchorX - reach); x <= Math.min(size - 1, island.anchorX + reach); x++) {
      if (raisedByIslands(alone, x, y, MIN_HEIGHT) > SEA_LEVEL) cells.push(y * size + x);
    }
  }
  return cells;
}

/**
 * The land the island guarantee rests on — the cells the habitat repair may
 * never touch.
 *
 * RAISED ISLANDS ARE GUARDED UNCONDITIONALLY, and that is the fix for the way
 * this first went wrong: they were guarded only if the survey happened to
 * COUNT them, so on a land-rich seed (where every raised island merged into the
 * one oversized landmass the survey refuses to count) nothing was guarded at
 * all, the repair drowned the lot, and the starter square came out with a
 * single island after the pass had raised nine.
 *
 * NATURAL landmasses make up the remainder of the quota, and only while they
 * fit the per-island protection budget: a continent filling the starter square
 * cannot be guarded without leaving nowhere to put the deep water, so it is
 * left to the repair to drown and the pass raises its own islands instead.
 */
function genesisGuardedLand(terrain: FreshGenesisTerrain, heights: Int16Array): Set<number> {
  const guarded = new Set<number>();
  for (const island of terrain.islands) {
    for (const index of genesisIslandLandCells(terrain, island)) guarded.add(index);
  }

  let counted = terrain.islands.length;
  if (counted >= GENESIS_MIN_STARTER_ISLANDS) return guarded;

  const budget = genesisStarterIslandProtectionBudget(terrain);
  for (const mass of surveyStarterLandmasses(terrain, heights)) {
    if (counted >= GENESIS_MIN_STARTER_ISLANDS) break;
    if (mass.cells < GENESIS_MIN_ISLAND_CELLS || mass.cells > budget) continue;
    // A landmass a raised island is part of is that island, not a second one.
    if (mass.indices.some((index) => guarded.has(index))) continue;
    for (const index of mass.indices) guarded.add(index);
    counted++;
  }
  return guarded;
}

/**
 * Runs the habitat pass, returning the cell overrides it had to write (empty
 * when the starter square already held both minima).
 *
 * IT IS A MONOTONE RESCALE OF THE STARTER SQUARE, not a per-cell conversion,
 * and that is the whole design. Sort the square's repairable cells by height;
 * the lowest `deep` of them must end up as deep water, the next `shallow` as
 * shallow, and everything above that stays land. Each of those three groups is
 * then remapped LINEARLY AND MONOTONICALLY into the band window its class
 * occupies, so no two cells ever swap order: the starter square comes out as
 * the same landscape the noise drew, with its waterline moved and its relief
 * re-scaled. Which is exactly what "the depth of the sea should vary" asks for.
 *
 * TWO EARLIER VERSIONS ARE BURIED HERE, and both are why this one looks like
 * terrain.
 *   * FLAT WRITES. The first version wrote every deepened cell to
 *     FRESH_SEABED_HEIGHT and every shoaled one to FRESH_SHELF_HEIGHT. The deep
 *     minimum alone is 62.5% of the starter square, so on a land-rich seed the
 *     square came out as two enormous flat plates — the featureless starter
 *     region this whole change exists to abolish, rebuilt by the pass meant to
 *     be invisible.
 *   * PER-CLASS MIRRORS. The second kept each converted set's relief but
 *     mirrored the two sets into their windows independently, so they disagreed
 *     at the boundary and the square came out as fractured shards. Order across
 *     the WHOLE square, not within each half of it, is what makes a landscape.
 *
 * TIES BREAK ON DISTANCE FROM A SEED-CHOSEN ANCHOR. On a CALM world every cell
 * ties at one height, so the tie-break IS the whole selection — and breaking it
 * on a hash of the cell index (which is what this did first) scatters the
 * repair as per-cell speckle, a starter square of alternating shallow and deep
 * cells, which is not terrain at all. Distance from one anchor makes the deep
 * group a BASIN around that anchor and the shallow group a SHELF around it,
 * both contiguous, both somewhere the seed chose. On a world with real relief
 * the height term dominates and this never comes up.
 *
 * GUARDED CELLS ARE NOT IN THE SORT AT ALL: the island guarantee's land keeps
 * its exact height, so no rescale can drown it.
 */
function planGenesisHabitatRepair(
  terrain: FreshGenesisTerrain,
  heights: Int16Array,
  seed: number,
  guarded: ReadonlySet<number>,
): Map<number, number> {
  const { size, unlockMinCell: lo, unlockMaxCell: hi } = terrain;
  const targets = genesisHabitatTargets(terrain, guarded.size);

  const repairable: number[] = [];
  const alreadyDeep: number[] = [];
  let shallowCount = 0;
  let deepCount = 0;
  for (let y = lo; y <= hi; y++) {
    const row = y * size;
    for (let x = lo; x <= hi; x++) {
      const index = row + x;
      const height = heights[index]!;
      if (height <= FRESH_SEABED_HEIGHT) {
        deepCount++;
        alreadyDeep.push(index);
      } else if (height <= SEA_LEVEL) {
        shallowCount++;
      }
      if (!guarded.has(index)) repairable.push(index);
    }
  }

  // The deep water must also be IN ONE PIECE, not merely present: the monsters
  // plugin's kraken needs a single connected basin of
  // GENESIS_TRENCH_MIN_BASIN_CELLS, and the trench pass that guarantees its
  // DEPTH can only ever lower cells that are already deep — it cannot make a
  // fragmented ocean into a big one. So the area half of that guarantee belongs
  // here, where the deep set is decided. (Measured before this check existed: 2
  // of 48 probe seeds drew a starter square with plenty of deep water in four
  // separate basins, none big enough to be a lair.)
  const basin = Math.min(GENESIS_TRENCH_MIN_BASIN_CELLS, targets.deep);
  if (
    shallowCount >= targets.shallow &&
    deepCount >= targets.deep &&
    largestConnectedCount(alreadyDeep, terrain) >= basin
  ) {
    return new Map<number, number>();
  }

  const anchorX = lo + (genesisMix(seed, GENESIS_REPAIR_ANCHOR_X_SALT) % (hi - lo + 1));
  const anchorY = lo + (genesisMix(seed, GENESIS_REPAIR_ANCHOR_Y_SALT) % (hi - lo + 1));
  const distanceSquared = (index: number): number => {
    const x = index % size;
    const dx = x - anchorX;
    const dy = (index - x) / size - anchorY;
    return dx * dx + dy * dy;
  };
  repairable.sort(
    (a, b) =>
      heights[a]! - heights[b]! || distanceSquared(a) - distanceSquared(b) || a - b,
  );

  // The two rank boundaries. Both fit: genesisHabitatTargets clamps their sum
  // to the number of repairable cells there are.
  const deepEnd = targets.deep;
  const shallowEnd = deepEnd + targets.shallow;

  // THE FALLBACK, and it is a shape change rather than a nudge, so it fires
  // only when it must: if the lowest `deep` cells of the square are spread over
  // several basins, re-rank by DISTANCE FROM THE ANCHOR instead, which selects
  // a disc — connected by construction, and therefore a lair. The square's
  // relief still survives inside it (the rescale below is unchanged and still
  // monotone in height); what is lost is that the basin follows the terrain's
  // own hollows rather than a circle around a seed-chosen point.
  if (largestConnectedCount(repairable.slice(0, deepEnd), terrain) < basin) {
    repairable.sort(
      (a, b) =>
        distanceSquared(a) - distanceSquared(b) || heights[a]! - heights[b]! || a - b,
    );
  }

  const overrides = new Map<number, number>();
  rescaleIntoBandWindow(
    repairable.slice(0, deepEnd),
    heights,
    overrides,
    GENESIS_NOISE_MIN_BAND_OFFSET,
    -FRESH_SEABED_BANDS_BELOW_SEA,
  );
  rescaleIntoBandWindow(
    repairable.slice(deepEnd, shallowEnd),
    heights,
    overrides,
    -(FRESH_SEABED_BANDS_BELOW_SEA - 1),
    -1,
  );
  return overrides;
}

/**
 * Cells in the largest 4-connected component of one set, measured inside the
 * starter square.
 *
 * FOUR-NEIGHBOUR, matching the ocean survey and the monsters plugin's own lair
 * survey: a diagonal pinch is not water a seven-cell-wide animal swims through,
 * and if the two disagreed genesis could hand the kraken a basin its own
 * admission test then splits in half.
 *
 * Measured inside the square only, which is CONSERVATIVE rather than exact: a
 * basin that runs out past the square's edge is bigger than this says, never
 * smaller, so a guarantee built on this number cannot be over-sold.
 */
function largestConnectedCount(
  cells: readonly number[],
  terrain: FreshGenesisTerrain,
): number {
  const { size, unlockMinCell: lo, unlockMaxCell: hi } = terrain;
  const span = hi - lo + 1;
  const member = new Uint8Array(span * span);
  for (const index of cells) {
    const x = index % size;
    member[((index - x) / size - lo) * span + (x - lo)] = 1;
  }

  const visited = new Uint8Array(span * span);
  const stack: number[] = [];
  let largest = 0;
  for (let start = 0; start < member.length; start++) {
    if (visited[start] === 1 || member[start] === 0) continue;
    let count = 0;
    visited[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const local = stack.pop()!;
      count++;
      const ly = (local / span) | 0;
      const lx = local - ly * span;
      if (lx > 0) pushMember(member, visited, stack, local - 1);
      if (lx + 1 < span) pushMember(member, visited, stack, local + 1);
      if (ly > 0) pushMember(member, visited, stack, local - span);
      if (ly + 1 < span) pushMember(member, visited, stack, local + span);
    }
    if (count > largest) largest = count;
  }
  return largest;
}

function pushMember(
  member: Uint8Array,
  visited: Uint8Array,
  stack: number[],
  local: number,
): void {
  if (visited[local] === 1 || member[local] === 0) return;
  visited[local] = 1;
  stack.push(local);
}

/**
 * Remaps one rank-ordered group of cells linearly onto a band window, lowest
 * height to the window's floor and highest to its ceiling.
 *
 * MONOTONE INCREASING, which is the property the whole pass rests on: cells
 * keep their order, so every ridge stays a ridge and every hollow a hollow —
 * the group is re-scaled vertically, not rearranged. Computed entirely in
 * BANDS, so every height it writes is an exact band floor by construction, and
 * a cell the remap does not actually move is left out of the override map
 * rather than written back unchanged.
 *
 * The degenerate case is honest: a group whose cells all tie at one height (a
 * genuinely flat starter square) has no relief to preserve, and every cell goes
 * to the window's CEILING — the smallest move that still satisfies the target.
 */
function rescaleIntoBandWindow(
  cells: readonly number[],
  heights: Int16Array,
  into: Map<number, number>,
  windowLowBands: number,
  windowHighBands: number,
): void {
  if (cells.length === 0) return;

  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const index of cells) {
    const bands = heights[index]! / BAND_HEIGHT;
    if (bands < lowest) lowest = bands;
    if (bands > highest) highest = bands;
  }

  const spread = highest - lowest;
  const windowSpan = windowHighBands - windowLowBands;
  for (const index of cells) {
    const bands = heights[index]! / BAND_HEIGHT;
    const mapped =
      spread === 0
        ? windowHighBands
        : windowLowBands + Math.floor(((bands - lowest) * windowSpan) / spread);
    const height = mapped * BAND_HEIGHT;
    if (height !== heights[index]!) into.set(index, height);
  }
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
