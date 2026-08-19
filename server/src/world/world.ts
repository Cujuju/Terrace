// The World — the single authoritative world object owned by the process
// (design §3.2, glossary §7). It owns exactly three things: the heightmap, the
// unlocked-chunk mask, and the connected players.
//
// It knows NOTHING about Colyseus. Outgoing traffic goes through a MessageSink,
// which the room installs. That is what makes "a rooms layer could be added
// later without rework" true, and it is what lets the whole intent pipeline be
// unit-tested with no network.

import {
  applySculpt,
  BAND_HEIGHT,
  CHUNK_SIZE,
  chunkIndex,
  chunkIndexOfCell,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  heightAt,
  isChunkUnlocked,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  SEA_LEVEL,
  unlockChunk,
  type CellDiff,
  type ChunkPayload,
  type Heightmap,
  type SculptOptions,
  type ServerMessage,
} from '@terrace/shared';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../config.ts';
import { NULL_SINK, type MessageSink } from '../net/message-sink.ts';
import type { Player } from '../player.ts';
import { applyInitialUnlock, initialUnlockFootprint } from './initial-unlock.ts';
import { chunkPayloadOf, collectUnlockedChunkPayloads } from './mask-filter.ts';
import { generateWorldName } from './world-name.ts';

// ─────────────────────────────────────────────────────────────────────────────
// FRESH-WORLD GENESIS
//
// A brand-new world is an OCEAN WITH A COAST, not a flat sheet at sea level,
// and — as of the 2026-08-18 "make it creative" pass — no two fresh worlds of
// the same size look the same either.
//
// THE ORIGINAL DEFECT (fixed 2026-08-14, see docs/DESIGN.md). `createHeightmap`
// allocates an all-zero grid and SEA_LEVEL is 0, so every cell of a fresh world
// used to sit EXACTLY at the waterline: the sea had zero depth everywhere, and
// anything classifying water by depth had nothing to classify. The wildlife
// plugin's deep-water habitat begins DEEP_WATER_BANDS_BELOW_SEA (3) bands
// down, so whales and deep-sea creatures had literally nowhere to exist until
// a player hand-dug a trench.
//
// THE SECOND COMPLAINT (2026-08-18, owner report): the fix above was a FIXED
// radial profile — three concentric terraces, by Chebyshev (square-ring)
// distance from the starter region's own centre — so it solved "no deep
// water" but every world it produced was geometrically identical. "Doesn't
// look very creative; we need something more creative and maybe less
// deterministic. Every world should have at least some fairly deep water.
// It's OK to create flat worlds, but the terrain should be randomized."
//
// THE CURRENT SHAPE. Two zones, split at the edge of the starter unlock
// square (`initialUnlockFootprint`, initial-unlock.ts):
//
//   1. THE STARTER SQUARE keeps the original fixed profile, UNCHANGED, cell
//      for cell:
//
//        ┌──── rest of starter square, deep-safe (see clamp below) ────┐
//        │      ┌──── slope ring, FRESH_SLOPE_BANDS_BELOW_SEA ────┐    │
//        │      │        ┌── shelf, FRESH_SHELF_BANDS_BELOW_SEA ──┐    │
//        │      │        │           (starter square centre)      │    │
//
//      This is NOT an oversight — it is the one piece of genesis a plugin
//      already depends on exactly. The wildlife plugin's day-one census
//      (plugins/wildlife/test/wildlife.test.ts) counts habitat over the
//      starter square ONLY (the census only sees unlocked cells) and asserts
//      EXACT cell counts — 4 096 shallow, 12 288 deep, 0 land at the size it
//      tests — derived from this exact shelf/slope geometry. Core cannot
//      change plugin behaviour and this change's scope is server/ only, so
//      the starter square's shelf and slope stay bit-identical band steps,
//      and the deep water beyond them is free to vary in DEPTH (never in
//      classification — see the clamp in `freshGenesisHeightAt`), which can
//      give even a fully-enclosed small world (starter square == whole world,
//      sizes up to 128²) seed-driven texture on its ocean floor. Only "can",
//      not "always does": the clamp is a one-way ratchet (deeper only, never
//      shallower), so a seed whose noise never dips past it anywhere on the
//      map collapses that whole region to the same flat plate any other
//      such seed would — correct and load-bearing, not a bug (see
//      server/test/fresh-world.test.ts, "varies with the seed even at the
//      smallest shipped size").
//
//   2. EVERYTHING OUTSIDE the starter square is genuinely new terrain: a
//      seeded value-noise field (`buildOuterLattice`) that can put a
//      continent, an island chain, a basin, gently rolling hills, or — on a
//      low `roughness` draw — something close to a flat sea wherever the
//      noise lands. This is most of any real-sized world (93.75% of the cells
//      on a default 512² world) and it is where "every world should look
//      different" actually happens.
//
// Every genesis height, in both zones, is still an exact multiple of
// BAND_HEIGHT (a "band floor"): shelf/slope are single clean band steps by
// construction, same as before, and the noise field is built from integer
// band offsets rather than raw heights, so nothing here needs a separate
// quantizing pass. This is a TERRACED game whose default brush is a stamp
// that cuts sheer faces, so a genesis surface that steps rather than ramps is
// the house style, and every height in it is a floor the terraced renderer
// draws exactly.
//
// RESIDUAL, NAMED. A one-band step is BAND_HEIGHT (64) against a gradient limit
// of MAX_STEP (32), so shelf/slope/noise boundaries do NOT generally satisfy
// the relaxation invariant at genesis. Nothing enforces that invariant at
// rest — the stamp tool violates it on purpose every time it builds a spire —
// but a `smooth` sculpt whose relaxation reaches a boundary WILL slump it
// once, producing a larger-than-usual diff bounded by SMOOTH_PASS_LIMIT.
// Accepted rather than papered over with a ramp, exactly as it was for the
// original two-terrace coast.
//
// THE SEED. `World.createFresh` draws one random 32-bit seed per world (the
// ONE intentionally non-deterministic moment in genesis, mirroring
// `generateWorldName`'s own use of `Math.random` in world-name.ts) and every
// height in the map is a pure function of that seed from then on — same seed,
// same world, byte for byte; a caller (tests, chiefly) that supplies its own
// seed gets full reproducibility. See `mulberry32Rng` below.
//
// THE ONE GUARANTEE ON TOP OF THE NOISE (owner-decided 2026-08-19). Leaving the
// ocean floor entirely to the seed meant fewer than half of fresh worlds had a
// basin deep and large enough for the monsters plugin's kraken, and the rest
// owed their players a mandatory dig. So a third, POST-NOISE step runs: the
// trench pass (see "The trench" section below) surveys the oceans the noise
// actually drew and, only if none of them qualifies, deepens the best one it
// found. It is derived from `(size, seed)` by integer arithmetic with no
// further RNG draws, it only ever lowers cells that are already open ocean, and
// it is a byte-for-byte no-op on every world whose noise already qualified.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Depth of the open-ocean floor, in terrace bands below sea level.
 *
 * The fix above is only correct if the fresh abyss REACHES the plugin's deep
 * threshold, so this is chosen to satisfy:
 *
 *     FRESH_SEABED_BANDS_BELOW_SEA >= DEEP_WATER_BANDS_BELOW_SEA
 *
 * Core cannot import that plugin constant — plugins depend on core, never the
 * reverse — so the relation is asserted from the plugin side instead
 * (plugins/wildlife/test/wildlife.test.ts). If either number moves, that test
 * fails rather than the ocean silently going shallow again.
 *
 * Three is also the SHALLOWEST depth that satisfies the relation, which is what
 * we want: every extra band is one more sculpt a player must spend to raise
 * land out there.
 */
export const FRESH_SEABED_BANDS_BELOW_SEA = 3;

/**
 * Depth of the coastal shelf at the very centre of a fresh world.
 *
 * One band — the shallowest water that is still water. Two things follow, and
 * both are the reason it is 1 rather than 2:
 *   * it is SHALLOW habitat (above the deep threshold), so coastal species have
 *     somewhere to be on day one;
 *   * it is a single band below the surface, so a player's first island costs
 *     two sculpts at DEFAULT_SCULPT_AMOUNT (one band per intent) — early
 *     land-raising stays as cheap as it was before the ocean existed, as long
 *     as it is done where the game starts you.
 */
export const FRESH_SHELF_BANDS_BELOW_SEA = 1;

/**
 * Depth of the ring between shelf and open sea. Exactly one band of each, so
 * the coast reads as a descending staircase rather than a single cliff into the
 * abyss. Still shallow habitat: the deep threshold is three bands down.
 */
export const FRESH_SLOPE_BANDS_BELOW_SEA = 2;

/**
 * Width of the slope ring, in cells. One chunk — the smallest unit of terrain
 * that streams as a whole, so the ring is never a sliver split across a chunk
 * boundary, and at 16 cells it is wide enough to be a place rather than a line.
 */
export const FRESH_SLOPE_WIDTH_CELLS = CHUNK_SIZE;

/**
 * How much smaller the shelf is than the starter unlock square, as a divisor of
 * its span in chunks.
 *
 * Four, and this number is load-bearing rather than aesthetic. The census that
 * drives wildlife only counts UNLOCKED cells, so the starter square's ~16 384
 * cells are the entire habitat budget of day one and this divisor is what
 * splits it between coastal and open-sea species. At 4 (shelf 2×2 chunks, plus
 * a one-chunk ring) the split is 4 096 shallow / 12 288 deep, which is the
 * coarsest setting that still buys 2 whales — a whale needs 5 000 cells of open
 * sea, so a larger shelf would eat the deep habitat this whole change exists to
 * create, and a smaller one leaves no coast for fish. Retune it and the day-one
 * ecosystem changes; the numbers it produces are asserted in
 * plugins/wildlife/test/wildlife.test.ts.
 */
export const FRESH_SHELF_SPAN_DIVISOR = 4;

/**
 * The second layer of the difficulty guarantee, behind loadConfig's validation.
 *
 * WorldApi.difficulty promises plugins an integer in [MIN_WORLD_DIFFICULTY,
 * MAX_WORLD_DIFFICULTY], and plugins interpolate against it — a NaN or an
 * out-of-band value would silently become a NaN or an absurd derived rate deep
 * inside somebody else's economy, which is exactly the class of failure mana
 * already guards its own inputs against. The env path cannot produce one, so
 * this exists for the OTHER callers (tests, a future world-gen plugin, a
 * supervisor building a World directly) and costs one comparison at genesis.
 */
function normalizeDifficulty(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WORLD_DIFFICULTY;
  const rounded = Math.round(value);
  if (rounded < MIN_WORLD_DIFFICULTY) return MIN_WORLD_DIFFICULTY;
  if (rounded > MAX_WORLD_DIFFICULTY) return MAX_WORLD_DIFFICULTY;
  return rounded;
}

/** Band depth → height. Genesis heights are exact band floors by construction. */
function heightAtBandsBelowSea(bands: number): number {
  return SEA_LEVEL - bands * BAND_HEIGHT;
}

/**
 * The open-ocean floor height. Well inside the sea column (16 bands, and the
 * deep strata run 8 crust bands below that to MIN_HEIGHT = -1536), so the full
 * sculpt range below the floor is still available for deeper trenches.
 */
export const FRESH_SEABED_HEIGHT = heightAtBandsBelowSea(FRESH_SEABED_BANDS_BELOW_SEA);

/** The coastal shelf height. */
export const FRESH_SHELF_HEIGHT = heightAtBandsBelowSea(FRESH_SHELF_BANDS_BELOW_SEA);

/** The slope-ring height. */
export const FRESH_SLOPE_HEIGHT = heightAtBandsBelowSea(FRESH_SLOPE_BANDS_BELOW_SEA);

/** The shelf's cell-space bounds, both axes, inclusive. */
export interface FreshGenesisProfile {
  readonly shelfMinCell: number;
  readonly shelfMaxCell: number;
  /** Cells of slope ring outside the shelf box, on every side. */
  readonly slopeWidthCells: number;
}

/**
 * Where the genesis terraces sit, derived from the starter unlock square rather
 * than from a restatement of its geometry (initialUnlockFootprint is the one
 * definition of that square — see initial-unlock.ts).
 *
 * The shelf is a centred square of `spanChunks / FRESH_SHELF_SPAN_DIVISOR`
 * chunks, never smaller than one chunk, centred INSIDE the unlock square by the
 * same floor-the-remainder rule the unlock square itself uses. Pure integer
 * arithmetic on chunk counts and never touches the seed — this geometry is the
 * one part of genesis every fresh world of a given size shares, on purpose
 * (see the file-header comment on why).
 */
export function freshGenesisProfile(size: number): FreshGenesisProfile {
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const shelfSpanChunks = Math.max(1, Math.floor(spanChunks / FRESH_SHELF_SPAN_DIVISOR));
  const shelfStartChunk = startChunk + Math.floor((spanChunks - shelfSpanChunks) / 2);

  const shelfMinCell = shelfStartChunk * CHUNK_SIZE;
  return {
    shelfMinCell,
    shelfMaxCell: shelfMinCell + shelfSpanChunks * CHUNK_SIZE - 1,
    slopeWidthCells: FRESH_SLOPE_WIDTH_CELLS,
  };
}

/**
 * Chebyshev distance from a cell to the shelf box: 0 inside it, otherwise how
 * many cells outside its nearest edge the cell lies. A square ring metric, not
 * a circular one, because the region it is measured against is a square — a
 * Euclidean radius would put the shelf's own corners in the slope band.
 */
function cellsOutsideShelf(profile: FreshGenesisProfile, x: number, y: number): number {
  const dx = Math.max(profile.shelfMinCell - x, x - profile.shelfMaxCell, 0);
  const dy = Math.max(profile.shelfMinCell - y, y - profile.shelfMaxCell, 0);
  return dx > dy ? dx : dy;
}

/**
 * A one-line duplicate of shared/src/heightmap.ts's own (unexported)
 * `clampHeight` — not imported because it isn't part of that module's public
 * surface, and this change's scope is server/ only, so exporting it there is
 * out of bounds here. Both sides are exactly `MAX_HEIGHT`/`MIN_HEIGHT`
 * clamping and nothing else; if that ever needs to change, it changes in two
 * places, which is the honest cost of the scope boundary rather than a
 * remnant of not looking for the existing one.
 */
function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < MIN_HEIGHT ? MIN_HEIGHT : h;
}

// ── Seeded randomness (server-only — see the file-header comment) ─────────────

/**
 * Draws the one intentionally non-deterministic value in genesis: a fresh
 * unsigned 32-bit seed, used only when a caller (real boot traffic) doesn't
 * supply its own. Mirrors `generateWorldName`'s default `Math.random` source
 * in world-name.ts — same reasoning, same file, same "this is the one place
 * it's allowed" boundary. Everything downstream of the returned value is a
 * pure function of it.
 */
function drawGenesisSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

/**
 * mulberry32 — a small, public-domain 32-bit seeded PRNG (Tommy Ettinger).
 * Not cryptographic and doesn't need to be: genesis only needs "looks random
 * and is fully determined by a 32-bit seed", and mulberry32 is a handful of
 * integer operations, well below the bar for adding a dependency. `seed` is
 * coerced with `>>> 0` so any finite JS number — including a negative one, or
 * one out of 32-bit range, both of which a test may reasonably pass — is a
 * valid seed rather than a silent NaN cascade.
 *
 * Returns a generator of floats in [0, 1), same contract as `Math.random`.
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

// ── Outer terrain: seeded value noise beyond the starter square ───────────────

/**
 * Spacing, in cells, between the noise lattice points that shape outer
 * terrain. One sample per 4 chunks (64 cells): coarse enough that a default
 * 512² world reads as a handful of continents/basins rather than pixel static,
 * fine enough that even the smallest world with any room outside the starter
 * square (144², the first multiple-of-16 size bigger than the 128² starter
 * square) still spans more than one lattice cell.
 */
const OUTER_TERRAIN_LATTICE_SPACING_CELLS = CHUNK_SIZE * 4;

/**
 * Deepest a noise lattice point can push outer terrain, in bands below sea
 * level. -10 bands is dramatic ocean-trench territory while staying well
 * inside the sea column's -16 bands (and MIN_HEIGHT is deeper still since
 * Deep Strata), so the clamp in `clampHeight` is a backstop that should never
 * actually fire rather than a value this range depends on.
 */
const OUTER_TERRAIN_MIN_BAND_OFFSET = -10;

/**
 * Highest a noise lattice point can push outer terrain, in bands above sea
 * level. +4 bands buys hills and small islands without turning every fresh
 * world into a mountain range — deliberately modest against MAX_HEIGHT's +16
 * bands of headroom, because genesis is meant to be a starting point, not the
 * most dramatic terrain a world will ever have.
 */
const OUTER_TERRAIN_MAX_BAND_OFFSET = 4;

/**
 * A fresh world's noise field: enough to answer "what band offset does outer
 * terrain want at (x, y)" without re-deriving it, and built once per world so
 * the RNG is consumed in one fixed, documented order (see
 * `buildFreshGenesisTerrain`) rather than reseeded or re-ordered per cell.
 */
interface OuterTerrainLattice {
  /** Row-major band offsets, `latticeCols` wide, `latticeCols` tall. */
  readonly bandOffsets: Int16Array;
  readonly latticeCols: number;
}

/**
 * Draws the lattice for one world. Three RNG draws — `baseline`, `roughness`,
 * then two per lattice point — in a fixed, size-independent sequence, so the
 * same seed always consumes the RNG the same way regardless of what the
 * caller later does with the result.
 *
 * ROUGHNESS AND BASELINE, TOGETHER. `roughness`, in [0, 1), is how far each
 * lattice point is allowed to wander from `baseline` (itself a drawn band
 * offset): at roughness 1 a point can land anywhere in the full amplitude
 * range same as before, and at roughness 0 every point collapses exactly
 * onto `baseline` — a flat world (owner: "it's OK to create flat worlds"),
 * both ends of the SAME continuum rather than a special-cased flat mode
 * bolted on beside the noise.
 *
 * `baseline` is drawn PER WORLD and is why this is two draws instead of one.
 * An earlier version collapsed roughness toward the noise range's own zero
 * point (sea level) instead of toward a drawn baseline: every sufficiently
 * "calm" seed produced the exact same flat-at-sea-level result regardless of
 * what the seed actually was, so distinct seeds could produce byte-identical
 * worlds — silently, and with no error, just two "different" fresh worlds
 * that happened to look the same. Server test/fresh-world.test.ts caught it
 * as a flaky "different seeds differ" failure. Drawing the flat point instead
 * of assuming it means a calm world is flat at a height the SEED chose, so
 * two different calm seeds essentially never coincide.
 */
function buildOuterTerrainLattice(size: number, rng: () => number): OuterTerrainLattice {
  const spacing = OUTER_TERRAIN_LATTICE_SPACING_CELLS;
  // +2, not +1: interpolation reads lattice[gx + 1], so the grid needs one
  // more column/row than the number of spacing-steps across the world.
  const latticeCols = Math.floor((size - 1) / spacing) + 2;
  const span = OUTER_TERRAIN_MAX_BAND_OFFSET - OUTER_TERRAIN_MIN_BAND_OFFSET;
  const baseline = OUTER_TERRAIN_MIN_BAND_OFFSET + rng() * span;
  const roughness = rng();

  const bandOffsets = new Int16Array(latticeCols * latticeCols);
  for (let j = 0; j < latticeCols; j++) {
    const row = j * latticeCols;
    for (let i = 0; i < latticeCols; i++) {
      const draw = OUTER_TERRAIN_MIN_BAND_OFFSET + rng() * span;
      bandOffsets[row + i] = Math.round(baseline + (draw - baseline) * roughness);
    }
  }
  return { bandOffsets, latticeCols };
}

/**
 * Bilinearly interpolated band offset at one cell, entirely in integer
 * arithmetic: the two interpolation weights are the integer cell-within-
 * lattice-square offsets `fx`/`fy` (each in `[0, spacing)`) rather than a
 * `[0, 1)` float, so every intermediate product is an exact integer and the
 * one division at the end is the only place rounding happens. This keeps
 * genesis on the same "integer math, no accumulated float error" footing as
 * the rest of the terrain code (see the determinism contract in
 * shared/src/constants.ts) even though genesis itself sits outside that
 * contract (server-only, never re-run on the client).
 */
function outerTerrainBandAt(lattice: OuterTerrainLattice, x: number, y: number): number {
  const spacing = OUTER_TERRAIN_LATTICE_SPACING_CELLS;
  const cols = lattice.latticeCols;
  const offsets = lattice.bandOffsets;

  const gx = Math.floor(x / spacing);
  const gy = Math.floor(y / spacing);
  const fx = x - gx * spacing;
  const fy = y - gy * spacing;

  const topLeft = offsets[gy * cols + gx];
  const topRight = offsets[gy * cols + gx + 1];
  const bottomLeft = offsets[(gy + 1) * cols + gx];
  const bottomRight = offsets[(gy + 1) * cols + gx + 1];

  const top = topLeft * (spacing - fx) + topRight * fx;
  const bottom = bottomLeft * (spacing - fx) + bottomRight * fx;
  return Math.floor((top * (spacing - fy) + bottom * fy) / (spacing * spacing));
}

// ── Putting genesis together ───────────────────────────────────────────────────

/**
 * Everything genesis needs to answer "what height is (x, y)", built once per
 * world by `buildFreshGenesisTerrain`. Bundled so `freshGenesisHeightAt` stays
 * a pure function of `(terrain, x, y)` — no RNG state, no world size lookups —
 * exactly as `freshGenesisHeightAt(profile, x, y)` was before the noise field
 * existed.
 */
export interface FreshGenesisTerrain {
  readonly profile: FreshGenesisProfile;
  /** The starter unlock square's cell-space bounds, both axes, inclusive. */
  readonly unlockMinCell: number;
  readonly unlockMaxCell: number;
  readonly outerLattice: OuterTerrainLattice;
  /**
   * The one trench this world's noise did NOT give it, or `null` when the
   * noise already produced a kraken-qualifying basin and the pass is a no-op.
   * See the trench section below.
   */
  readonly trench: GenesisTrench | null;
}

/**
 * Builds one world's genesis terrain from its size and seed. The only
 * function in genesis that touches the RNG or `Math.random`
 * (`buildOuterTerrainLattice` takes an already-constructed generator) — call
 * it exactly once per world, the same way `World.createFresh` does.
 *
 * TWO PHASES, and the order matters. The noise field is drawn first and is
 * exactly what it always was — the RNG is consumed by `buildOuterTerrainLattice`
 * and by nothing else, in the same fixed sequence, so a given seed still draws
 * the same lattice it drew before the trench pass existed. The trench is then
 * planned from that finished field by pure integer arithmetic on `(size, seed)`
 * with no further draws, which is what makes it a no-op — byte for byte — on
 * every world whose own noise already qualifies.
 */
export function buildFreshGenesisTerrain(size: number, seed: number): FreshGenesisTerrain {
  const profile = freshGenesisProfile(size);
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const unlockMinCell = startChunk * CHUNK_SIZE;
  const rng = mulberry32Rng(seed);
  const untrenched: FreshGenesisTerrain = {
    profile,
    unlockMinCell,
    unlockMaxCell: unlockMinCell + spanChunks * CHUNK_SIZE - 1,
    outerLattice: buildOuterTerrainLattice(size, rng),
    trench: null,
  };
  return { ...untrenched, trench: planGenesisTrench(untrenched, size, seed) };
}

function withinUnlockFootprint(terrain: FreshGenesisTerrain, x: number, y: number): boolean {
  return (
    x >= terrain.unlockMinCell &&
    x <= terrain.unlockMaxCell &&
    y >= terrain.unlockMinCell &&
    y <= terrain.unlockMaxCell
  );
}

/**
 * Genesis height of one cell. Exported so tests can state genesis's shape
 * without re-deriving its geometry, and so a future world-gen plugin has an
 * obvious seam to replace.
 *
 * Shelf and slope are unchanged from the original fixed profile — see the
 * file-header comment for why they stay exact. Beyond the slope ring, height
 * comes from the seeded noise field, EXCEPT that a cell still inside the
 * starter square is clamped to at most `FRESH_SEABED_HEIGHT`: the wildlife
 * plugin's day-one census counts that exact region as deep water and asserts
 * an exact cell count, so this cell's only freedom is how much DEEPER than
 * the old fixed abyss it gets, never shallower — the classification the
 * plugin depends on can't move, but the depth players actually see can.
 *
 * The trench pass (below) is applied LAST, after both the shelf/slope early
 * returns and the starter-square clamp, and only ever lowers a cell that is
 * already open ocean — so neither the fixed terraces nor the deep/shallow
 * classification of a single cell can move, whatever it does.
 */
export function freshGenesisHeightAt(terrain: FreshGenesisTerrain, x: number, y: number): number {
  const { profile } = terrain;
  const outside = cellsOutsideShelf(profile, x, y);
  if (outside === 0) return FRESH_SHELF_HEIGHT;
  if (outside <= profile.slopeWidthCells) return FRESH_SLOPE_HEIGHT;

  const noiseHeight = clampHeight(outerTerrainBandAt(terrain.outerLattice, x, y) * BAND_HEIGHT);
  const clamped = withinUnlockFootprint(terrain, x, y)
    ? noiseHeight < FRESH_SEABED_HEIGHT
      ? noiseHeight
      : FRESH_SEABED_HEIGHT
    : noiseHeight;
  return deepenedByTrench(terrain.trench, x, y, clamped);
}

// ── The trench: every fresh world gets one basin deep enough for a kraken ─────
//
// THE PROBLEM. Outer terrain draws its floor per seed across the whole
// [OUTER_TERRAIN_MIN_BAND_OFFSET, OUTER_TERRAIN_MAX_BAND_OFFSET] range, so how
// deep a fresh world's deepest ocean gets is a coin toss. Measured over 48
// fixed seeds before this pass existed, a basin deep AND large enough to host
// the monsters plugin's kraken existed on 46% of 128² worlds and 58% of 512²
// worlds; every other world's players had to hand-dig one before the deep ever
// gave them anything. The owner ratified the guarantee (2026-08-19): a fresh
// world always HAS one. Whether it is unlocked yet stays a progression
// question and is deliberately untouched here.
//
// THE PASS, in one sentence: after the noise field is drawn, genesis surveys
// its own oceans, and if none of them is both large enough and deep enough, it
// gouges a trench along a seed-chosen axis through the deepest ocean it did
// produce — lowering cells that are ALREADY open ocean and nothing else.
//
// WHY "ALREADY OCEAN" IS THE LOAD-BEARING RULE. Because the pass only ever
// lowers cells that are at or below FRESH_SEABED_HEIGHT, the SET of deep-water
// cells is bit-for-bit what the noise produced: no cell enters deep water, none
// leaves it, no region splits or merges, and every connected region keeps its
// exact area. The wildlife plugin's day-one census (which counts that exact
// classification, to the cell) therefore cannot move, and the chosen region is
// still the same size afterwards — it has simply gained a floor. All the pass
// changes is how far DOWN some ocean cells go, which is the one freedom the
// starter-square clamp already documents itself as having.
//
// WHY IT IS A NO-OP WHERE IT IS NOT NEEDED. `planGenesisTrench` returns null
// the moment it finds a region that already qualifies, and a null trench is
// not consulted at all — so a world whose noise was already generous is byte-
// identical to what the same seed produced before this pass existed.
//
// REJECTED ALTERNATIVE 1: stamp a fixed basin at a fixed place (or at the
// world's centre). Deterministic and two lines shorter, but every world would
// wear the same rectangle in the same spot, and it would cut through whatever
// island the noise had put there.
// REJECTED ALTERNATIVE 2: bias the noise itself — force one lattice point to
// the deep end of its range. Cheapest of all, but the lattice is interpolated
// over 64-cell spacing, so a single deep point produces a broad soft bowl that
// (a) reads nothing like a trench and (b) does not actually guarantee the
// result: the qualifying cell can still be clipped by the starter-square
// clamp or land in a region too small to be a lair. A guarantee you have to
// re-check is not a guarantee.
// REJECTED ALTERNATIVE 3: make the trench meander (a per-column wobble) for
// looks. Deterministic, but it buys shape at the cost of a second geometry to
// reason about; clipping a straight gouge to the ocean's own outline already
// keeps it from reading as a stamp, and the owner's bar was explicitly "a
// modest deterministic deepening pass beats a fancy one".

/**
 * Cells the trench's chosen basin must have, as a multiple of a chunk's area.
 *
 * A DELIBERATE RESTATEMENT of the monsters plugin's KRAKEN_LAIR_MIN_AREA_CHUNKS
 * (plugins/monsters/server/kinds.ts), not an import — core must not depend on a
 * plugin, so the agreement is pinned from the plugin side instead
 * (plugins/monsters/test/monsters.test.ts), exactly as
 * FRESH_SEABED_BANDS_BELOW_SEA's relation to the wildlife plugin is.
 */
export const GENESIS_TRENCH_MIN_BASIN_CHUNKS = 9;

/** That area in cells: 2304, a 48×48 basin if it were square. */
export const GENESIS_TRENCH_MIN_BASIN_CELLS =
  GENESIS_TRENCH_MIN_BASIN_CHUNKS * CHUNK_SIZE * CHUNK_SIZE;

/**
 * How deep the trench's own floor is cut, in bands below sea level.
 *
 * The same DELIBERATE RESTATEMENT arrangement as the area above: this is the
 * monsters plugin's GENESIS_DEEP_OCEAN_REFERENCE_BAND — "the band a world WITH
 * a deep ocean is taken to bottom out at", the reference its kraken bar is
 * derived from. Cutting to exactly that band is the point: the trench is not a
 * special deeper thing the generator can make, it is the deep ocean floor the
 * bar was written against, placed where the noise failed to put one.
 */
export const GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA = 8;

/**
 * The depth a basin must already reach for the pass to leave the world alone,
 * in whole bands below sea level — 7.
 *
 * A RESTATEMENT OF THE DERIVATION rather than of the number: the plugin's bar
 * is the reference floor with one band of relaxation margin taken off it
 * (`GENESIS_DEEP_OCEAN_REFERENCE_BAND * BAND_HEIGHT - MAX_STEP / 2`), counted
 * in the whole bands its admission test counts. Restating the derivation and
 * not the literal is what makes the two sides move together if the reference
 * band is ever retuned; that they agree TODAY is pinned plugin-side.
 *
 * This is the number the no-op test uses, so it must be the plugin's bar and
 * not the trench's own deeper floor: a world whose noise already bottoms out at
 * exactly band 7 qualifies, and re-cutting it would edit a world that did not
 * need editing.
 */
export const GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA = Math.floor(
  (GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA * BAND_HEIGHT - MAX_STEP / 2) / BAND_HEIGHT,
);

/** That bar as a height: -448. A basin at or below this needs no trench. */
export const GENESIS_TRENCH_QUALIFYING_HEIGHT = heightAtBandsBelowSea(
  GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA,
);

/**
 * Cells of horizontal run the trench walls take per band of descent — 2.
 *
 * DERIVED, not chosen: BAND_HEIGHT / MAX_STEP is the shortest run over which a
 * one-band step still satisfies the terrain gradient invariant, so the trench
 * walls are the steepest slope the sculpt rules call stable. That matters here
 * more than it does elsewhere in genesis, which openly does NOT satisfy the
 * invariant at its terrace edges (see the file header's "residual"): a wall
 * that did not satisfy it would slump the first time a smooth stroke reached
 * the trench, and the floor this guarantee rests on would shallow out.
 */
const GENESIS_TRENCH_WALL_CELLS_PER_BAND = BAND_HEIGHT / MAX_STEP;

/**
 * Half the length of the trench's flat floor, in cells — 24, so the floor runs
 * 48 cells end to end.
 *
 * DERIVED from the minimum basin: 48 is the side of the smallest square that
 * would meet GENESIS_TRENCH_MIN_BASIN_CELLS, so the trench is exactly as long
 * as the shortest lair the kraken accepts is wide. Long enough to read as a
 * rift rather than a crater, and short enough to sit inside the 80-cell starter
 * square, which on a calm world is the only ocean there is.
 */
const GENESIS_TRENCH_HALF_LENGTH_CELLS = Math.round(
  Math.sqrt(GENESIS_TRENCH_MIN_BASIN_CELLS) / 2,
);

/**
 * How far from the floor segment the trench still has any effect, in cells:
 * the point at which the walls have climbed all the way back to sea level.
 * Used as a cheap bounding-box reject, so it is an upper bound and not a
 * shape — the walls stop mattering much earlier, as soon as they rise above
 * whatever ocean floor they are cutting into.
 */
const GENESIS_TRENCH_REACH_CELLS =
  GENESIS_TRENCH_HALF_LENGTH_CELLS +
  GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA * GENESIS_TRENCH_WALL_CELLS_PER_BAND;

/**
 * The eight directions a trench may run, as PRIMITIVE INTEGER vectors.
 *
 * Integer directions rather than an angle keep the whole distance computation
 * exact: the dot and cross products below are integers, and the single
 * `Math.sqrt` per cell is floored immediately (the same "integer-only, or an
 * exactly-specified IEEE op with an immediate floor" rule shared/ terrain math
 * follows). Eight is enough that the trench does not read as axis-aligned
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
interface GenesisTrench {
  /** Centre of the floor segment — the deepest cell of the chosen basin. */
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
 * survey measured it. Deliberately the same three facts the monsters plugin's
 * LairRegion carries (area, extreme cell, its height) — this is genesis asking
 * the plugin's question of itself, and the answer has to be comparable.
 *
 * The extreme cell is chosen by (lowest height, then lowest anchor score, then
 * lowest cell index), which is a TOTAL order on cells and therefore independent
 * of the order the flood fill happens to visit them in. That is what lets the
 * fill use a plain depth-first stack — cheap, and no queue the size of the
 * world — without the result depending on the traversal.
 *
 * WHY THE SCORE IS IN THAT ORDER AND NOT JUST THE INDEX. A calm seed's ocean is
 * FLAT: every one of its tens of thousands of cells ties at the same height, so
 * "lowest index" resolves the tie to cell 0 — the world's top-left corner —
 * on every calm world ever generated, and half the trench falls off the map.
 * The score (see `genesisTrenchAnchorScore`) breaks those ties somewhere
 * seed-dependent inside the region instead, and does nothing at all when the
 * basin has a genuine single deepest point, which is the common case.
 */
interface GenesisOceanRegion {
  cells: number;
  extremeHeight: number;
  extremeScore: number;
  extremeIndex: number;
}

/**
 * Labels every connected region of open ocean in a world's UNTRENCHED genesis
 * field. "Open ocean" is `<= FRESH_SEABED_HEIGHT`, which this file already
 * pins as at least as deep as the deep-water line every habitat consumer uses
 * — measuring at a deeper line can only UNDER-count a region, never invent
 * one, so a guarantee built on this survey is conservative by construction.
 *
 * CONNECTIVITY IS 4-NEIGHBOUR, matching the monsters plugin's own survey (a
 * diagonal pinch is not water a 7-cell-wide animal swims through). If the two
 * disagreed, genesis could hand the kraken a basin its own admission test
 * would then split in half.
 *
 * COST: one full evaluation of the genesis field into a scratch Int16Array
 * plus one visited byte per cell — 3 bytes per cell, transient, on the world's
 * single genesis call. The default 512² world is 786 KB of that; the largest
 * documented size (4096²) is 50 MB for the duration of one function call.
 */
function surveyGenesisOceanRegions(
  untrenched: FreshGenesisTerrain,
  size: number,
  seed: number,
): GenesisOceanRegion[] {
  const cellCount = size * size;
  const heights = new Int16Array(cellCount);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) heights[row + x] = freshGenesisHeightAt(untrenched, x, y);
  }

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
    };
    visited[seedIndex] = 1;
    stack.push(seedIndex);

    while (stack.length > 0) {
      const index = stack.pop()!;
      const height = heights[index]!;
      region.cells++;
      const score = genesisTrenchAnchorScore(index, seed);
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
 * Picks the trench this world needs, or `null` if it needs none.
 *
 * THE NO-OP CASE FIRST: any ocean region that is both big enough to be a lair
 * and already reaches GENESIS_TRENCH_QUALIFYING_HEIGHT ends the search — the
 * noise did the job, and the world is left exactly as it was drawn.
 *
 * Otherwise the trench is centred on the deepest cell of the deepest ocean
 * region that IS big enough, so the guarantee lands in the ocean the world
 * already has rather than somewhere the generator picked. Ties break on more
 * cells, then on the lower cell index: a total order, so the choice never
 * depends on region discovery order.
 *
 * THE DEGENERATE FALLBACK, named rather than discovered later: a world can be
 * too small for ANY of its ocean to be a lair (below ~80 cells the starter
 * square's own open sea, the one region every world has, is under 2304 cells).
 * Such a world cannot host a kraken at any depth, trench or no trench, so this
 * deepens its largest ocean anyway and lets the area half of the admission test
 * do the refusing — the alternative, throwing, would make an unusual
 * self-hosted WORLD_SIZE unbootable for a guarantee it was never able to keep.
 * The same reasoning, and the same size regime, as `carveFallbackAbyss` below.
 */
function planGenesisTrench(
  untrenched: FreshGenesisTerrain,
  size: number,
  seed: number,
): GenesisTrench | null {
  let deepestLairSized: GenesisOceanRegion | null = null;
  let largest: GenesisOceanRegion | null = null;

  for (const region of surveyGenesisOceanRegions(untrenched, size, seed)) {
    if (
      largest === null ||
      region.cells > largest.cells ||
      (region.cells === largest.cells && region.extremeIndex < largest.extremeIndex)
    ) {
      largest = region;
    }

    if (region.cells < GENESIS_TRENCH_MIN_BASIN_CELLS) continue;
    if (region.extremeHeight <= GENESIS_TRENCH_QUALIFYING_HEIGHT) return null;

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

  const chosen = deepestLairSized ?? largest;
  if (chosen === null) return null;

  const [axisX, axisY] = GENESIS_TRENCH_AXES[genesisTrenchAxisIndex(seed)]!;
  const axisLengthSquared = axisX * axisX + axisY * axisY;
  const centreX = chosen.extremeIndex % size;
  return {
    centreX,
    centreY: (chosen.extremeIndex - centreX) / size,
    axisX,
    axisY,
    axisLengthSquared,
    halfLengthScaled: Math.floor(
      GENESIS_TRENCH_HALF_LENGTH_CELLS * Math.sqrt(axisLengthSquared),
    ),
  };
}

/**
 * Which of GENESIS_TRENCH_AXES this world's trench runs along.
 *
 * An integer avalanche (the xorshift-multiply pair from Murmur3's finaliser)
 * rather than `seed % 8`, because seeds are not always random: the test suites
 * — and any operator pinning a world — use small consecutive integers, whose
 * low three bits would march through the axis list in lockstep. It draws
 * nothing from the world's RNG on purpose, so adding it left the lattice's
 * draw sequence, and therefore every already-qualifying world, untouched.
 */
function genesisTrenchAxisIndex(seed: number): number {
  const mixed = Math.imul(seed ^ 0x9e37_79b9, 0x85eb_ca6b) >>> 0;
  return mixed % GENESIS_TRENCH_AXES.length;
}

/**
 * A cell's tie-break score when a basin has no single deepest cell — an
 * integer avalanche of (cell index, world seed), so a FLAT ocean anchors its
 * trench somewhere that varies with the seed instead of always at cell 0.
 *
 * Deliberately not a distance-to-centroid rule, which was the obvious
 * alternative: a region's centroid can fall outside a crescent-shaped region
 * entirely (the same trap the monsters plugin's LairRegion documents for its
 * own extreme cell), so it would need its own "nearest cell that IS in the
 * region" search — a second pass over the region for a tie-break.
 */
function genesisTrenchAnchorScore(index: number, seed: number): number {
  // The two inputs are mixed SEPARATELY and then combined, rather than XORed
  // together first: `index ^ seed` maps the pair (0, 0) — cell zero of a world
  // seeded zero, which is exactly a test's first world — onto the smallest
  // score there is, handing the corner the tie all over again.
  let mixed = (Math.imul(index + 1, 0x27d4_eb2d) ^ Math.imul(seed + 1, 0x9e37_79b9)) >>> 0;
  mixed = (mixed ^ (mixed >>> 15)) >>> 0;
  return Math.imul(mixed, 0x85eb_ca6b) >>> 0;
}

/**
 * The trench's own floor at one cell, applied to that cell's untrenched genesis
 * height. Returns `base` untouched unless ALL of these hold:
 *
 *   * this world has a trench at all;
 *   * the cell is already open ocean (see the section header — this is the
 *     rule that keeps every habitat classification exactly where the noise put
 *     it, and keeps the trench from gouging a canyon across an island);
 *   * the cell is inside the trench, and the trench wants it DEEPER than it is.
 *
 * The depth profile is a capsule: full depth within `halfLength` of the centre
 * along the axis, then one band shallower per GENESIS_TRENCH_WALL_CELLS_PER_BAND
 * cells of distance from that segment, so the result is always an exact band
 * multiple — the invariant the monsters suite pins on genesis output.
 *
 * `along` and `across` are the dot and cross products with the axis, so both
 * carry a factor of |axis|; the distance is de-scaled by dividing the squared
 * sum by |axis|² inside the one `Math.sqrt`, whose result is floored on the
 * spot.
 */
function deepenedByTrench(
  trench: GenesisTrench | null,
  x: number,
  y: number,
  base: number,
): number {
  if (trench === null || base > FRESH_SEABED_HEIGHT) return base;

  const dx = x - trench.centreX;
  const dy = y - trench.centreY;
  if (dx > GENESIS_TRENCH_REACH_CELLS || dx < -GENESIS_TRENCH_REACH_CELLS) return base;
  if (dy > GENESIS_TRENCH_REACH_CELLS || dy < -GENESIS_TRENCH_REACH_CELLS) return base;

  const along = Math.abs(dx * trench.axisX + dy * trench.axisY) - trench.halfLengthScaled;
  const overhang = along > 0 ? along : 0;
  const across = dx * trench.axisY - dy * trench.axisX;
  const distance = Math.floor(
    Math.sqrt((overhang * overhang + across * across) / trench.axisLengthSquared),
  );

  const bands =
    GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA -
    Math.floor(distance / GENESIS_TRENCH_WALL_CELLS_PER_BAND);
  if (bands <= 0) return base;

  const floor = clampHeight(heightAtBandsBelowSea(bands));
  return floor < base ? floor : base;
}

/**
 * Last-resort fallback for the deep-water guarantee, used only when a world
 * is so small that the shelf and its fixed-width slope ring
 * (FRESH_SLOPE_WIDTH_CELLS cells, a constant regardless of world size) cover
 * every cell — below the smallest shipped size (128²) and the documented
 * valid range (64..4096) — so ordinary genesis never had a chance to place
 * any deep water at all. Forces the single cell farthest (by the same
 * Chebyshev metric as the shelf/slope split) from the shelf down to
 * FRESH_SEABED_HEIGHT, and returns that height so the caller can re-verify
 * the guarantee now holds.
 *
 * Deliberately a POST-CHECK fallback rather than folded into the main
 * construction: this path is expected to run zero times for every size
 * anyone actually ships, and keeping it separate and rare-path means the
 * primary generation loop stays a simple, easily-audited pure function of
 * `(terrain, x, y)`.
 */
function carveFallbackAbyss(map: Heightmap, profile: FreshGenesisProfile, size: number): number {
  let farthestX = 0;
  let farthestY = 0;
  let farthestDistance = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = cellsOutsideShelf(profile, x, y);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestX = x;
        farthestY = y;
      }
    }
  }
  map.cells[farthestY * size + farthestX] = FRESH_SEABED_HEIGHT;
  return FRESH_SEABED_HEIGHT;
}

export class World {
  readonly map: Heightmap;
  readonly mask: Uint8Array;

  /**
   * This world's difficulty rating: 1 = warm/forgiving, 100 = punishing
   * (WORLD_DIFFICULTY, decided 2026-08-14 — see config.ts and docs/DESIGN.md).
   *
   * The World holds it and NOTHING HERE READS IT. It is a neutral scalar core
   * publishes to plugins through WorldApi.difficulty; every mechanic derived
   * from it lives in a plugin. Kept on the World rather than threaded from the
   * config at each call site because "difficulty" is a property of the world a
   * plugin is looking at, and the WorldApi is the only thing plugins are given.
   *
   * Deployment configuration, NOT snapshot state: it is deliberately absent from
   * the snapshot, so a host who re-rates their world by editing the environment
   * gets the new rating on the next boot rather than a value frozen at genesis.
   */
  readonly difficulty: number;

  /**
   * What this world is CALLED — minted once at genesis by world-name.ts and
   * then persisted with the heightmap, so every restart and every player sees
   * the same name.
   *
   * SNAPSHOT STATE, and the opposite of `difficulty` in that respect. A name is
   * the world's identity: a host who restarts their server must get the same
   * world back, name included, which is precisely what a snapshot is for.
   * Difficulty is deployment configuration a host re-rates by editing their
   * environment, so it deliberately is NOT stored. The two live side by side
   * here and are persisted differently on purpose.
   */
  readonly name: string;

  private sink: MessageSink = NULL_SINK;
  private readonly playersById = new Map<string, Player>();

  /**
   * Per-token unlock masks (issue #17 — per-player territory). `mask` above
   * stays the SIMULATION/union mask (wildlife census, flora, monsters — every
   * existing consumer keeps reading it, unchanged); this is the NEW per-token
   * layer a chunk unlock actually happens against. Keyed by Player.token, not
   * by connection id, so a reconnect with the same token finds its own mask
   * again under a brand-new sessionId. Lazily populated — a token nobody has
   * granted anything to simply has no entry, which reads identically to an
   * all-locked createChunkMask() without allocating one.
   */
  private readonly masksByToken = new Map<string, Uint8Array>();

  /**
   * Set whenever terrain or mask changes; cleared when a snapshot is written.
   * The snapshot scheduler writes ONLY when this is true (design open question
   * 4, decided: "snapshot every SNAPSHOT_INTERVAL_S only if the world changed"),
   * so an idle server does no disk I/O at all.
   */
  private changedSinceSnapshot = false;

  private constructor(
    map: Heightmap,
    mask: Uint8Array,
    difficulty: number,
    name: string,
  ) {
    this.map = map;
    this.mask = mask;
    this.difficulty = difficulty;
    this.name = name;
  }

  /**
   * A brand-new world: an OCEAN WITH A COAST — a shallow shelf at the centre,
   * a slope ring around it — and, beyond that, terrain that is different every
   * time: seeded value noise standing in for what used to be a flat abyss.
   * The provisional starter region is unlocked as before (see
   * initial-unlock.ts). Used when no snapshot exists. Every constant and the
   * two-zone split are documented at the top of this file.
   *
   * The terrain is generated HERE, on the server, and deliberately not in
   * `createHeightmap`: shared/ is the determinism contract that client and
   * server both run, and world GENESIS is not part of it. The client never
   * generates terrain — it receives chunks — so a zero-filled allocator stays
   * the honest shared primitive and "what a new world looks like" stays a
   * server policy that a future world-gen plugin can replace.
   *
   * `seed` defaults to a fresh random draw (`drawGenesisSeed`) — the one
   * intentionally non-deterministic moment in genesis. A caller that supplies
   * its own seed (tests, chiefly) gets a fully reproducible world: genesis is
   * a pure function of `(size, seed)` from that point on, so the same pair
   * always produces the same heightmap, byte for byte.
   *
   * CONSEQUENCES, ALL INTENDED AND ALL REAL:
   *
   *   1. Raising land costs band-steps it did not before: two sculpts to break
   *      the surface on the starter shelf (at DEFAULT_SCULPT_AMOUNT = one band
   *      per intent), more out in the open sea, and by how much now varies by
   *      seed as well as by place.
   *   2. The starter square still has no land — the wildlife plugin's day-one
   *      census depends on that (see the file-header comment) — but land is
   *      possible, and expected, beyond it: a future reveal plugin may uncover
   *      an island, a mountain range, or more open sea, decided at genesis and
   *      not before.
   *   3. Every generated world still contains water at least as deep as
   *      `FRESH_SEABED_HEIGHT` (`FRESH_SEABED_BANDS_BELOW_SEA` bands down) —
   *      guaranteed by construction (the starter-square clamp below can only
   *      make outer terrain deeper there, never shallower) and checked again,
   *      loudly, right after generation, the same "fail at boot rather than
   *      serve a broken world" idiom `applyInitialUnlock` already uses below.
   *
   * Only this path generates. `restore` rebuilds whatever a snapshot holds, so
   * existing worlds are untouched.
   *
   * Not a cosmetic mismatch worth chasing on the client: the client boots its
   * local heightmap at band 0 and shows a flat sea until the first chunk
   * arrives, so for the one pre-connect frame it draws a shoreline where the
   * server has a coast and (now) varied terrain beyond it. The first
   * `chunkUnlock` overwrites it. Left alone on purpose — the fix belongs in
   * the client's boot state.
   */
  static createFresh(
    size: number,
    difficulty: number = DEFAULT_WORLD_DIFFICULTY,
    name: string = generateWorldName(),
    seed: number = drawGenesisSeed(),
  ): World {
    const map = createHeightmap(size);
    const terrain = buildFreshGenesisTerrain(size, seed);

    // Row-major, ascending, matching every other sweep over the grid. Order is
    // irrelevant to the result here (each cell is a pure function of its own
    // coordinates plus the prebuilt `terrain`, never of iteration order) and
    // kept conventional so it stays that way.
    let deepestHeight = MAX_HEIGHT;
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const height = freshGenesisHeightAt(terrain, x, y);
        map.cells[row + x] = height;
        if (height < deepestHeight) deepestHeight = height;
      }
    }

    // Every fresh world must contain water at least as deep as the wildlife
    // plugin's deep-water threshold (see FRESH_SEABED_BANDS_BELOW_SEA above)
    // or the original bug — whales with nowhere to live — comes back. Proven
    // true by construction for every size in the documented valid range
    // (64..4096, see server/test/fresh-world.test.ts): the starter-square
    // clamp in `freshGenesisHeightAt` can only push that region deeper than
    // FRESH_SEABED_HEIGHT, never shallower.
    //
    // BUT config.ts enforces no such minimum — WORLD_SIZE only has to be a
    // positive multiple of CHUNK_SIZE — and FRESH_SLOPE_WIDTH_CELLS is a
    // FIXED cell count, not a fraction of world size, so a small enough world
    // lets the slope ring geometrically cover every cell, leaving nothing for
    // the clamp to act on (this is a latent property of the ORIGINAL
    // shelf/slope geometry, not something this change introduces — it was
    // simply never checked before there was an invariant to violate). Rather
    // than leave an unusual self-hosted WORLD_SIZE permanently unbootable,
    // fall back to carving the guarantee in directly.
    if (deepestHeight > FRESH_SEABED_HEIGHT) {
      deepestHeight = carveFallbackAbyss(map, terrain.profile, size);
    }

    // Should be unreachable — carveFallbackAbyss always sets one cell to
    // exactly FRESH_SEABED_HEIGHT — but fail loudly rather than silently ship
    // a world with no deep water, the same idiom applyInitialUnlock uses for
    // its own boot-time sanity check just below.
    if (deepestHeight > FRESH_SEABED_HEIGHT) {
      throw new Error(
        `fresh genesis produced no water at or below FRESH_SEABED_HEIGHT ` +
          `(deepest cell was ${deepestHeight}) — deep-water guarantee violated`,
      );
    }

    const world = new World(
      map,
      createChunkMask(size),
      normalizeDifficulty(difficulty),
      name,
    );
    applyInitialUnlock(world);
    // The starter unlock is part of world creation, not a mutation of an
    // existing world: the first snapshot will be written by the normal dirty
    // path anyway, so start clean and let real edits mark it.
    world.changedSinceSnapshot = false;
    return world;
  }

  /**
   * Rebuilds a world from a snapshot. Both buffers are validated against the
   * configured size — a mismatch means the DB was written by a differently
   * configured server, and silently continuing would produce a corrupt world.
   * (PER-CELL height validity — `isValidHeight`, issue #13 — is already
   * guaranteed by the time `cells` reaches here: SnapshotStore.loadLatest
   * throws on a corrupt cell at decode, before any caller of it, `restore`
   * included, ever sees the array. This function's own checks are narrower
   * on purpose — they only cover what SnapshotStore cannot know, namely
   * whether the snapshot fits the world THIS process is configured for.)
   *
   * The union mask and every per-token mask are length-checked against this
   * world's chunk count below (see the `expectedMask`/`tokenMask.length`
   * checks) — that check belongs here, not in SnapshotStore, because only
   * `createChunkMask` knows the expected byte length for a given world size.
   *
   * `difficulty` comes from the CURRENT environment, never from the snapshot:
   * it is deployment configuration, so re-rating a world is an env edit plus a
   * restart, and an old snapshot never overrides today's setting.
   *
   * `name` comes from the SNAPSHOT, which is the opposite rule and the right
   * one: the name is what this world is, so it must come back exactly as it was
   * stored. `null` means the snapshot predates world names (or was written by a
   * build that stored none), and the world is named here, once — see
   * mintedName below for why that also marks the world dirty.
   *
   * `tokenMasks` is per-token unlock state (issue #17), keyed by the same
   * token a reconnecting client resends. LEGACY RESTORE, STATED LOUDLY: a
   * snapshot written before issue #17 has no such rows at all, so this
   * defaults to an empty map — the union `mask` above still carries every
   * chunk that was ever unlocked (unchanged, since it was always the ONLY
   * mask), but every per-token mask starts from nothing. Concretely: every
   * player who reconnects to an upgraded server re-creeps their own view of
   * territory the world already contains, even land they had personally
   * opened before the upgrade. This is the exact, owner-accepted legacy
   * behaviour from issue #17 decision 4 — not a bug to chase.
   *
   * A per-token entry whose mask byte length does not match this world's
   * chunk count (corruption, a hand-edited DB, a foreign world's row) is
   * DROPPED rather than thrown on: unlike the heightmap/union-mask length
   * checks above — where a mismatch means the whole snapshot belongs to a
   * differently-sized world and continuing would misalign every row — one
   * bad per-token row only costs ONE player their remembered creep, which is
   * exactly the same "re-creep, nothing else breaks" outcome as a legacy
   * snapshot, so degrading it is honest rather than a special case.
   */
  static restore(
    size: number,
    cells: Int16Array,
    mask: Uint8Array,
    difficulty: number = DEFAULT_WORLD_DIFFICULTY,
    name: string | null = null,
    tokenMasks: ReadonlyMap<string, Uint8Array> = new Map(),
  ): World {
    const map = createHeightmap(size);
    if (cells.length !== map.cells.length) {
      throw new RangeError(
        `snapshot heightmap has ${cells.length} cells, world size ${size} needs ${map.cells.length}`,
      );
    }
    const expectedMask = createChunkMask(size);
    if (mask.length !== expectedMask.length) {
      throw new RangeError(
        `snapshot mask has ${mask.length} bytes, world size ${size} needs ${expectedMask.length}`,
      );
    }
    map.cells.set(cells);
    expectedMask.set(mask);

    // A stored name is used verbatim; a missing or blank one is minted now.
    const stored = name?.trim() ?? '';
    const mintedName = stored === '' ? generateWorldName() : null;
    const world = new World(
      map,
      expectedMask,
      normalizeDifficulty(difficulty),
      mintedName ?? stored,
    );

    for (const [token, tokenMask] of tokenMasks) {
      if (tokenMask.length !== expectedMask.length) continue; // see doc comment: degrade, don't throw
      const copy = createChunkMask(size);
      copy.set(tokenMask);
      world.masksByToken.set(token, copy);
    }

    // THE NAME MUST REACH DISK, and `dirty` is the only mechanism that gets it
    // there: the snapshot scheduler writes ONLY a changed world, so an existing
    // world nobody sculpts would otherwise be re-named on every single boot and
    // never persist any of those names. Marking it changed here is not a
    // workaround for that rule — it is the rule applied honestly, because the
    // world in memory genuinely differs from the one on disk.
    if (mintedName !== null) world.changedSinceSnapshot = true;
    return world;
  }

  get size(): number {
    return this.map.size;
  }

  get chunksPerEdge(): number {
    return chunksPerEdge(this.map.size);
  }

  /** True when terrain or mask changed since the last successful snapshot. */
  get dirty(): boolean {
    return this.changedSinceSnapshot;
  }

  /** Called by the snapshot store after a snapshot is committed. */
  markSnapshotted(): void {
    this.changedSinceSnapshot = false;
  }

  /** Installs the network sink (room create) or removes it (room dispose). */
  setSink(sink: MessageSink): void {
    this.sink = sink;
  }

  /**
   * Sends a core protocol message to everyone. The Colyseus message type is the
   * payload's own `type` literal and the payload is the whole protocol object —
   * so what goes on the wire is exactly a `ServerMessage` from
   * shared/src/protocol.ts, with no server-only re-shaping to drift from.
   */
  broadcast(message: ServerMessage): void {
    this.sink.broadcast(message.type, message);
  }

  /** Same contract as broadcast(), to a single player. */
  sendTo(playerId: string, message: ServerMessage): void {
    this.sink.sendTo(playerId, message.type, message);
  }

  /** Plugin-namespaced traffic; the namespace is applied by the WorldApi. */
  broadcastRaw(type: string, payload: unknown): void {
    this.sink.broadcast(type, payload);
  }

  sendRawTo(playerId: string, type: string, payload: unknown): void {
    this.sink.sendTo(playerId, type, payload);
  }

  heightAt(x: number, y: number): number {
    return heightAt(this.map, x, y);
  }

  isChunkUnlocked(cx: number, cy: number): boolean {
    return isChunkUnlocked(this.mask, chunkIndex(this.map.size, cx, cy));
  }

  /**
   * ANTI-CHEAT: the check the intent pipeline runs on a brush centre. Callers
   * must have bounds-checked (x,y) first — chunkIndexOfCell throws otherwise.
   *
   * DELIBERATELY STILL THE UNION MASK after issue #17. Per-player masks
   * (below) gate what STREAMS to a given player, not what they may aim a
   * brush at: once a chunk is unlocked for anyone, the server itself no
   * longer treats its terrain as secret, so a second player sculpting there
   * is shared-world behaviour, not a leak. Making sculpt permission — or the
   * ongoing terrainDiff broadcast in sculpt-service.ts, which also still
   * filters against this same union mask — per-player as well is the
   * fog-of-war follow-up flagged in the issue, not this change: see
   * isChunkVisibleTo/isCellVisibleTo below for the primitive that follow-up
   * will need.
   */
  isCellUnlocked(x: number, y: number): boolean {
    return isChunkUnlocked(this.mask, chunkIndexOfCell(this.map.size, x, y));
  }

  /**
   * Flips a chunk's mask bit and streams it to every client.
   *
   * Returns false when the chunk was already unlocked, so callers (a reveal
   * plugin, typically) can unlock idempotently without re-sending 512 B of
   * heights. Streaming here — rather than at the call site — guarantees that a
   * chunk becoming visible and clients learning about it cannot drift apart.
   *
   * GLOBAL / BROADCAST unlock — flips the bit for every player at once. Kept
   * for genesis (initial-unlock.ts) and any future plugin that genuinely wants
   * "unlocked for the whole world"; per-player policy (the reveal plugin,
   * since issue #17) uses unlockChunkForToken below instead.
   */
  unlockChunk(cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    if (isChunkUnlocked(this.mask, index)) return false;

    unlockChunk(this.mask, index);
    this.changedSinceSnapshot = true;
    this.broadcast({ type: 'chunkUnlock', chunks: [chunkPayloadOf(this, cx, cy)] });
    return true;
  }

  /** Lazily allocates and returns ONE token's own mask. Never returns the shared union `mask`. */
  private maskForToken(token: string): Uint8Array {
    let tokenMask = this.masksByToken.get(token);
    if (tokenMask === undefined) {
      tokenMask = createChunkMask(this.map.size);
      this.masksByToken.set(token, tokenMask);
    }
    return tokenMask;
  }

  /**
   * Flips a chunk's bit in ONE TOKEN'S mask, and ORs it into the union/
   * simulation mask too (issue #17 decision: "the union mask ORs in any chunk
   * when its first token earns it" — idempotent no matter which token gets
   * there first, or whether several already have). NEVER SENDS ANYTHING —
   * see unlockChunkForToken and seedChunkForToken below, the two callers that
   * layer messaging policy on top of this shared mutation. Returns false when
   * already unlocked FOR THIS TOKEN specifically (a chunk long since union-
   * unlocked by some other token still returns true here).
   */
  private grantChunkToToken(token: string, cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    const tokenMask = this.maskForToken(token);
    if (isChunkUnlocked(tokenMask, index)) return false;

    unlockChunk(tokenMask, index);
    this.changedSinceSnapshot = true;
    unlockChunk(this.mask, index); // union — see isChunkUnlocked's doc comment.
    return true;
  }

  /**
   * SILENT per-token unlock: mutates masks only, streams nothing. The one
   * caller is the join-time starter-square seed (initial-unlock.ts's
   * applyInitialUnlockForToken): every newly seen token must start with the
   * same home square, but that seed has to land BEFORE the join snapshot is
   * built, not arrive afterward as a chunkUnlock message — the client is not
   * sized to receive one until the snapshot has told it worldSize (see the
   * ordering contract in terrace-room.ts). Idempotent per token: a RETURNING
   * token already has these bits set, so every call after the first is a
   * costless no-op.
   */
  seedChunkForToken(token: string, cx: number, cy: number): boolean {
    return this.grantChunkToToken(token, cx, cy);
  }

  /**
   * THE PER-PLAYER CREEP PRIMITIVE (design doc §reveal/frontier-pressure,
   * issue #17). Unlocks a chunk FOR ONE TOKEN and streams it ONLY to that
   * token's own live session(s) via sendTo — never a broadcast, because an
   * unrelated player must not learn the chunk exists (issue #17 decision 2:
   * "one adventurous player must not expose the world to everyone"). A token
   * can be open in more than one browser tab; every live session presenting
   * it is "the player who earned it", which is why this filters players() by
   * token rather than targeting a single connection id.
   *
   * Returns false when already unlocked for this token, so a policy plugin
   * (reveal) can call this unconditionally for every touched cell without a
   * separate read check first.
   */
  unlockChunkForToken(token: string, cx: number, cy: number): boolean {
    if (!this.grantChunkToToken(token, cx, cy)) return false;

    const message: ServerMessage = {
      type: 'chunkUnlock',
      chunks: [chunkPayloadOf(this, cx, cy)],
    };
    for (const player of this.players()) {
      if (player.token === token) this.sendTo(player.id, message);
    }
    return true;
  }

  /** Per-token read. Mirrors isChunkUnlocked, but against ONE token's mask rather than the union. */
  isChunkUnlockedForToken(token: string, cx: number, cy: number): boolean {
    const index = chunkIndex(this.map.size, cx, cy);
    const tokenMask = this.masksByToken.get(token);
    return tokenMask !== undefined && isChunkUnlocked(tokenMask, index);
  }

  /**
   * Whether the CONNECTED PLAYER identified by `playerId` has personally
   * unlocked the chunk at (cx, cy) — answered from THEIR OWN token mask,
   * never the union. Added for the fog-of-war follow-up named in issue #17's
   * accepted residual (global entity broadcasts — wildlife/flora/monsters/
   * structures — still reference positions over chunks a player hasn't
   * unlocked): that follow-up needs exactly this primitive, plus the token
   * each connected Player already carries via players() (also issue #17).
   * NOTHING IN CORE CALLS THIS YET — no broadcast is filtered by it today;
   * it exists so the next change is a caller, not another contract change.
   *
   * A playerId with no connected Player (already left, or never existed)
   * answers false — nobody has unlocked anything for a session that is not
   * here, which is also the safe default for a query about to gate what
   * reaches a wire.
   */
  isChunkVisibleTo(playerId: string, cx: number, cy: number): boolean {
    const player = this.getPlayer(playerId);
    return player !== undefined && this.isChunkUnlockedForToken(player.token, cx, cy);
  }

  /** Cell-granularity isChunkVisibleTo — see its doc comment for the fog-of-war context. */
  isCellVisibleTo(playerId: string, x: number, y: number): boolean {
    return this.isChunkVisibleTo(
      playerId,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
    );
  }

  /**
   * Every chunk unlocked for ONE TOKEN — the entire terrain content of that
   * token's join snapshot (issue #17 decision 2: "join snapshot sends only
   * the joining token's chunks"). An unseen token (nothing granted yet, e.g.
   * a query that races ahead of applyInitialUnlockForToken) returns an empty
   * list, exactly like a freshly allocated mask would.
   */
  chunkPayloadsForToken(token: string): ChunkPayload[] {
    const tokenMask = this.masksByToken.get(token) ?? createChunkMask(this.map.size);
    return collectUnlockedChunkPayloads({ map: this.map, mask: tokenMask });
  }

  /**
   * Every per-token mask, for the snapshot writer (index.ts) to persist
   * alongside the union `mask`. Returns the LIVE maps, not copies — safe
   * because the only caller reads them synchronously within one
   * SnapshotStore.saveSnapshot call, the same trust level `mask` and
   * `map.cells` are already handed out at just below.
   */
  tokenMasks(): ReadonlyMap<string, Uint8Array> {
    return this.masksByToken;
  }

  /**
   * Applies an authoritative sculpt from the shared math (never re-implemented
   * here — design §3.3). `options` selects the brush tool and edge profile;
   * omitting it means smooth+soft, the shared library's compatibility default
   * (LIBRARY_DEFAULT_SCULPT_OPTIONS). Player intents never omit it: the intent
   * pipeline resolves them through `sculptOptionsOf` first.
   *
   * Returns the FULL diff, including cells inside locked chunks that the
   * relaxation legitimately touched (with the stamp tool there is no relaxation
   * and so no spill at all). Filtering for the wire happens in mask-filter.ts;
   * this method deliberately does not broadcast, so that the one place which
   * does (sculpt-service.ts) is the only place to audit.
   */
  applySculpt(
    x: number,
    y: number,
    radius: number,
    amount: number,
    options?: SculptOptions,
  ): CellDiff[] {
    const diff = applySculpt(this.map, x, y, radius, amount, options);
    if (diff.length > 0) this.changedSinceSnapshot = true;
    return diff;
  }

  addPlayer(player: Player): void {
    this.playersById.set(player.id, player);
  }

  removePlayer(playerId: string): Player | undefined {
    const player = this.playersById.get(playerId);
    this.playersById.delete(playerId);
    return player;
  }

  getPlayer(playerId: string): Player | undefined {
    return this.playersById.get(playerId);
  }

  /** Snapshot of the connected players; safe for plugins to hold briefly. */
  players(): readonly Player[] {
    return Array.from(this.playersById.values());
  }
}
