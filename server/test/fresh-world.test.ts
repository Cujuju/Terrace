// What a brand-new world is made of.
//
// These tests exist because the failure they guard against is silent: a world
// whose seabed sits AT sea level looks fine — it renders, it sculpts, it saves —
// while having no water column at all, so anything that classifies water by
// depth has nothing to classify. That is how deep-water wildlife came to have
// nowhere to live (owner report, 2026-08-14).
//
// 2026-08-26 — THE DAY-ONE HABITAT MINIMA ARE GONE. The owner dropped the
// whale-pair guarantee: forcing 62.5% of the starter square to be deep water
// meant rescaling most of that square on most seeds, which showed up in a render
// as a hard-edged rectangle. Whales now arrive with territory creep, and genesis
// promises land instead — a world-wide land fraction, and islands in the starter
// square shaped by the seed's own noise.
//
// 2026-08-25 — THE GUARANTEES REPLACED THE GEOMETRY. Genesis used to be a
// STATED PROFILE inside the starter square: a fixed shelf, a fixed slope ring,
// a clamped abyss, all of it identical in every world ever generated, and this
// file asserted that geometry cell by cell. The owner removed it ("New worlds
// should not have just a single starter square; they should have islands — not
// just a single island. They should also have some random trenches, and the
// depth of the sea should vary"), so there is no fixed geometry left to assert.
//
// What replaces it is a CONTRACT, and it is what this file now holds:
//
//   * LAND — at least GENESIS_MIN_LAND_PERCENT of the whole map is dry;
//   * ISLANDS — the starter square contains at least GENESIS_MIN_STARTER_ISLANDS
//     separate landmasses of GENESIS_MIN_ISLAND_CELLS or more, and they are
//     lifted out of the seed's own terrain rather than stamped on top of it;
//   * TRENCHES — every world gets between GENESIS_EXTRA_TRENCH_MIN and
//     1 + GENESIS_EXTRA_TRENCH_MAX of them, and different seeds get different
//     ones;
//   * and the properties that were always the point — every height an exact
//     band floor inside [MIN_HEIGHT, MAX_HEIGHT], reproducible from a seed,
//     different across seeds, and never without deep water somewhere.

import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  NEIGHBOURHOOD_CELLS,
  SEA_LEVEL,
  isWater,
} from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { MIN_WORLD_SIZE } from '../src/config.ts';
import {
  FRESH_SEABED_BANDS_BELOW_SEA,
  FRESH_SEABED_HEIGHT,
  FRESH_SHELF_BANDS_BELOW_SEA,
  FRESH_SHELF_HEIGHT,
  GENESIS_EXTRA_TRENCH_MAX,
  GENESIS_EXTRA_TRENCH_MIN,
  GENESIS_ISLAND_MIN_LAND_CELLS,
  GENESIS_MIN_ISLAND_CELLS,
  GENESIS_MIN_LAND_PERCENT,
  GENESIS_MIN_STARTER_ISLANDS,
  GENESIS_MIN_STARTER_LAND_CELLS,
  GENESIS_TRENCH_MIN_BASIN_CELLS,
  GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA,
  GENESIS_TRENCH_QUALIFYING_HEIGHT,
  buildFreshGenesisTerrain,
  freshGenesisHeightAt,
  type FreshGenesisTerrain,
} from '../src/world/genesis.ts';
import { INITIAL_UNLOCK_CHUNK_SPAN, initialUnlockFootprint } from '../src/world/initial-unlock.ts';
import { World } from '../src/world/world.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

/**
 * The default world, in chunks. Big enough that the starter square has an
 * outside, and the size every "what does a real world look like" assertion
 * below is made against.
 */
const WORLD_SIZE = NEIGHBOURHOOD_CELLS * 16;

/** A larger world, for the assertions that want plenty of terrain to differ in. */
const WORLD_SIZE_WITH_OUTER_TERRAIN = NEIGHBOURHOOD_CELLS * 32;

/**
 * Every world size the suite exercises, IN CHUNKS: the new minimum itself
 * (MIN_WORLD_SIZE is 28 chunks — see config.ts, issue #181), the first two
 * neighbourhood-aligned sizes above it, the default, and one large one.
 *
 * The small end moved on 2026-08-25 and that is the point of #181: sizes below
 * MIN_WORLD_SIZE boot an all-ocean world, because the starter footprint clamps
 * to the whole map and genesis has no outside left to draw. config.ts now
 * refuses them, so the suite stops generating them.
 *
 * THE TOP END is a generation big enough to be the slowest line in the file:
 * 2 048 cells a side is 4.2 M cells per seed.
 */
const VALID_SIZES = [28, 32, 40, 64, 128].map((span) => span * CHUNK_SIZE);

/** Small, fixed seeds so a failing assertion is easy to reproduce by hand. */
const SEEDS = Array.from({ length: 20 }, (_, i) => i * 104729 + 1); // 104729 is prime; just decorrelates the sequence

/**
 * The same sequence, extended, for the one test that needs several worlds where
 * the island pass ACTUALLY FIRED — a no-op world tells it nothing.
 *
 * SIXTY, from 2026-08-26 (#204): once the octave sum stopped being floored per
 * octave, the noise's own coasts got both smoother and slightly landier, and
 * the starter square now clears GENESIS_MIN_STARTER_LAND_CELLS unaided on far
 * more seeds — 12 of 60 raise an island where 20 seeds used to yield 3. The
 * contract being pinned did not change; the rate at which the sample exercises
 * it did, so the sample grew rather than the assertion shrinking.
 */
const ISLAND_PASS_SEEDS = Array.from({ length: 60 }, (_, i) => i * 104729 + 1);

/**
 * Wall-clock budget for the tests in this file that GENERATE WHOLE WORLDS, in
 * milliseconds. Named for what earns the budget — world generation, not one
 * subject — so every such test reaches for the same one.
 *
 * 240 s since the 2026-08-21 re-sample put sixteen times the cells inside the
 * same ground; the 2026-08-25 archipelago pass added three more whole-map
 * sweeps per world (one survey per guarantee) on top of that.
 */
const WORLD_GENERATION_TIMEOUT_MS = 240_000;

/**
 * The coarsest genesis noise lattice, in cells — four neighbourhoods.
 *
 * Restated here rather than imported because genesis keeps it private: it is an
 * implementation detail of the field everywhere except in the seam test below,
 * which needs a whole period of it to compare like with like.
 */
const COARSEST_LATTICE_SPACING_CELLS = NEIGHBOURHOOD_CELLS * 4;

/** The starter unlock square's inclusive cell bounds. */
function starterBounds(size: number): { lo: number; hi: number } {
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const lo = startChunk * CHUNK_SIZE;
  return { lo, hi: lo + spanChunks * CHUNK_SIZE - 1 };
}

/**
 * Sizes of every 8-connected landmass inside the starter square, largest first.
 * A deliberate second implementation of the survey genesis runs internally: if
 * the two ever disagree, one of them is wrong and the guarantee is not being
 * measured.
 */
function starterIslandSizes(heights: Int16Array, size: number): number[] {
  const { lo, hi } = starterBounds(size);
  const span = hi - lo + 1;
  const visited = new Uint8Array(span * span);
  const sizes: number[] = [];

  const isLand = (lx: number, ly: number): boolean =>
    heights[(lo + ly) * size + lo + lx]! > SEA_LEVEL;

  for (let start = 0; start < visited.length; start++) {
    const sy = Math.floor(start / span);
    const sx = start - sy * span;
    if (visited[start] === 1 || !isLand(sx, sy)) continue;

    let cells = 0;
    visited[start] = 1;
    const stack = [start];
    while (stack.length > 0) {
      const local = stack.pop()!;
      const ly = Math.floor(local / span);
      const lx = local - ly * span;
      cells++;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = lx + ox;
          const ny = ly + oy;
          if ((ox === 0 && oy === 0) || nx < 0 || ny < 0 || nx >= span || ny >= span) continue;
          const neighbour = ny * span + nx;
          if (visited[neighbour] === 1 || !isLand(nx, ny)) continue;
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    sizes.push(cells);
  }

  return sizes.sort((a, b) => b - a);
}

/** Cells in the 8-connected landmass containing (x, y); 0 if that cell is water. */
function landmassAreaAt(heights: Int16Array, size: number, x: number, y: number): number {
  if (heights[y * size + x]! <= SEA_LEVEL) return 0;
  const seen = new Uint8Array(size * size);
  const stack = [y * size + x];
  seen[y * size + x] = 1;
  let cells = 0;
  while (stack.length > 0) {
    const index = stack.pop()!;
    cells++;
    const cx = index % size;
    const cy = (index - cx) / size;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox;
        const ny = cy + oy;
        if ((ox === 0 && oy === 0) || nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const neighbour = ny * size + nx;
        if (seen[neighbour] === 1 || heights[neighbour]! <= SEA_LEVEL) continue;
        seen[neighbour] = 1;
        stack.push(neighbour);
      }
    }
  }
  return cells;
}

/** Renders one terrain to a plain array — used to compare layers against each other. */
function render(terrain: FreshGenesisTerrain, size: number): Int16Array {
  const heights = new Int16Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) heights[y * size + x] = freshGenesisHeightAt(terrain, x, y);
  }
  return heights;
}

describe('the depths genesis knows by name', () => {
  it('are band-aligned water inside the sculpt range, shelf above seabed', () => {
    expect(FRESH_SHELF_BANDS_BELOW_SEA).toBeLessThan(FRESH_SEABED_BANDS_BELOW_SEA);

    for (const [bands, height] of [
      [FRESH_SHELF_BANDS_BELOW_SEA, FRESH_SHELF_HEIGHT],
      [FRESH_SEABED_BANDS_BELOW_SEA, FRESH_SEABED_HEIGHT],
    ] as const) {
      expect(Number.isInteger(bands)).toBe(true);
      expect(height).toBe(SEA_LEVEL - bands * BAND_HEIGHT);
      // Every genesis height is an exact band floor, so the terraced renderer
      // draws it without quantising anything away.
      expect(height % BAND_HEIGHT === 0).toBe(true);
      expect(isWater(height)).toBe(true);
      expect(height).toBeGreaterThan(MIN_HEIGHT);
    }
  });
});

describe('the whole field', () => {
  it('keeps every height an integer, band-aligned, and inside [MIN_HEIGHT, MAX_HEIGHT]', () => {
    // A plain loop with one `expect` per world, not per cell: vitest's matcher
    // overhead dominates at hundreds of thousands of calls, so this scans in
    // raw JS and only asserts a summary.
    for (const size of [28, 40, 64].map((span) => span * CHUNK_SIZE)) {
      for (const seed of SEEDS.slice(0, 5)) {
        const world = World.createFresh(size, undefined, undefined, seed);
        let allValid = true;
        for (const h of world.map.cells) {
          // `h % BAND_HEIGHT === 0`, not the raw remainder: an exact negative
          // multiple gives -0, which is a fine boolean and a confusing count.
          if (!Number.isInteger(h) || h % BAND_HEIGHT !== 0 || h < MIN_HEIGHT || h > MAX_HEIGHT) {
            allValid = false;
            break;
          }
        }
        expect(allValid).toBe(true);
      }
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('is deterministic: two fresh worlds from the same size and seed are identical', () => {
    const a = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 42);
    const b = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 42);
    expect(Array.from(a.map.cells)).toEqual(Array.from(b.map.cells));
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('varies with the seed: two fresh worlds from different seeds differ', () => {
    const a = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 1);
    const b = World.createFresh(WORLD_SIZE_WITH_OUTER_TERRAIN, undefined, undefined, 2);
    expect(Array.from(a.map.cells)).not.toEqual(Array.from(b.map.cells));
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('varies with the seed at the SMALLEST size config.ts will boot', () => {
    // The reason MIN_WORLD_SIZE moved (issue #181): below it the starter square
    // clamps to the whole map and there is no outer terrain to vary. At the new
    // minimum there is a full lattice ring on every side, so seeds must differ
    // here without needing the "several worlds, not one pair" hedge the old
    // clamped regime required.
    const a = World.createFresh(MIN_WORLD_SIZE, undefined, undefined, 1);
    const b = World.createFresh(MIN_WORLD_SIZE, undefined, undefined, 2);
    expect(Array.from(a.map.cells)).not.toEqual(Array.from(b.map.cells));
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('draws a fresh, non-reproducible seed when none is supplied', () => {
    // The default seed comes from Math.random via drawGenesisSeed — the one
    // intentionally non-deterministic call in genesis. Compares several worlds
    // rather than one pair: only ALL of them coinciding would fail falsely.
    const worlds = Array.from({ length: 4 }, () =>
      Array.from(World.createFresh(WORLD_SIZE, undefined, undefined).map.cells),
    );
    expect(worlds.every((cells) => cells.every((h, i) => h === worlds[0]![i]))).toBe(false);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('guarantees water at least as deep as FRESH_SEABED_HEIGHT, at every valid size', () => {
    // THE hard invariant no change may regress: every generated world has
    // somewhere for deep-water wildlife to live.
    for (const size of VALID_SIZES.slice(0, 3)) {
      for (const seed of SEEDS) {
        const world = World.createFresh(size, undefined, undefined, seed);
        let deepest = MAX_HEIGHT;
        for (const h of world.map.cells) if (h < deepest) deepest = h;
        expect(deepest).toBeLessThanOrEqual(FRESH_SEABED_HEIGHT);
      }
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('accepts every valid world size without throwing', () => {
    for (const size of VALID_SIZES) {
      expect(size % CHUNK_SIZE).toBe(0);
      expect(size).toBeGreaterThanOrEqual(MIN_WORLD_SIZE);
      expect(() => World.createFresh(size, undefined, undefined, 7)).not.toThrow();
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('keeps the starter unlock square where it was', () => {
    // Genesis reads the unlock footprint; it must not move it.
    const { startChunk, spanChunks } = initialUnlockFootprint(WORLD_SIZE);
    expect(spanChunks).toBe(INITIAL_UNLOCK_CHUNK_SPAN);

    const world = World.createFresh(WORLD_SIZE, undefined, undefined, 1);
    expect(world.isChunkUnlocked(startChunk, startChunk)).toBe(true);
    expect(world.isChunkUnlocked(startChunk - 1, startChunk)).toBe(false);
    expect(world.isChunkUnlocked(startChunk + spanChunks, startChunk)).toBe(false);
  });

  it('leaves a snapshot-restored world exactly as it was stored', () => {
    // Genesis is a property of world CREATION, not of the World class. A world
    // that came back from disk must be byte-identical to what was saved, or
    // every existing self-hosted world would silently gain a coastline on the
    // next restart.
    const stored = new Int16Array(WORLD_SIZE * WORLD_SIZE);
    stored.fill(SEA_LEVEL);
    stored[0] = BAND_HEIGHT;

    const restored = World.restore(WORLD_SIZE, stored, World.createFresh(WORLD_SIZE).mask);

    expect(restored.heightAt(0, 0)).toBe(BAND_HEIGHT);
    expect(restored.heightAt(1, 0)).toBe(SEA_LEVEL);
  });

  it('does not change the flat worlds the test harness builds', () => {
    // The harness fixtures stay pinned at 0 on purpose: tests that reason cell
    // by cell about sculpt arithmetic want a flat datum, not an ocean.
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    expect(world.heightAt(0, 0)).toBe(SEA_LEVEL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ISLAND GUARANTEE (owner, 2026-08-25)
//
// The starter square is the entire world a player can touch on day one. An
// all-ocean one hands them several hundred sculpts of bill before anything can
// stand on it, and that is what the fixed shelf used to prevent by fiat.
// ─────────────────────────────────────────────────────────────────────────────
describe('the island pass', () => {
  it('puts GENESIS_MIN_STARTER_LAND_CELLS of island in every starter square', () => {
    // COUNTED AS LAND, not as landmasses, and that is the guarantee's own shape
    // — see GENESIS_MIN_STARTER_LAND_CELLS. Only landmasses at or above
    // GENESIS_MIN_ISLAND_CELLS count, so a scatter of rocks does not.
    for (const size of [WORLD_SIZE, MIN_WORLD_SIZE]) {
      const short: { seed: number; cells: number }[] = [];
      for (const seed of SEEDS) {
        const heights = World.createFresh(size, undefined, undefined, seed).map.cells;
        const cells = starterIslandSizes(heights, size)
          .filter((island) => island >= GENESIS_MIN_ISLAND_CELLS)
          .reduce((sum, island) => sum + island, 0);
        if (cells < GENESIS_MIN_STARTER_LAND_CELLS) short.push({ seed, cells });
      }
      expect({ size, short }).toEqual({ size, short: [] });
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('raises islands only where the noise fell short, and leaves the rest alone', () => {
    // The pass's half of the no-op contract: both branches must be live over
    // the seed sample, or the guarantee is a stamp rather than a repair.
    const planned = SEEDS.map(
      (seed) => buildFreshGenesisTerrain(WORLD_SIZE, seed).islands.length,
    );
    expect(planned.some((count) => count > 0)).toBe(true);
    expect(planned.some((count) => count === 0)).toBe(true);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('raises islands big enough for its own survey to count them', () => {
    // The geometry has to clear the bar it is measured against, or the pass
    // would raise land it then refuses to count and would work through its whole
    // site list on every world.
    expect(GENESIS_ISLAND_MIN_LAND_CELLS).toBeGreaterThanOrEqual(GENESIS_MIN_ISLAND_CELLS);
  });

  it('lifts the terrain rather than stamping a shape on it', () => {
    // THE 2026-08-26 REGRESSION, pinned. Islands used to be the MAXIMUM of the
    // terrain and a cone, which puts the cone's own contour on the map: a disc
    // with a halo, whatever the cone is jittered with. Lifting the field instead
    // means the island is the terrain, raised — so two islands lifted by the
    // same amount on different ground must come out different sizes, which a
    // stamp can never do.
    const areas = new Set<number>();
    for (const seed of ISLAND_PASS_SEEDS) {
      const terrain = buildFreshGenesisTerrain(WORLD_SIZE, seed);
      if (terrain.islands.length === 0) continue;
      const heights = World.createFresh(WORLD_SIZE, undefined, undefined, seed).map.cells;
      for (const island of terrain.islands) {
        // The landmass the anchor sits in — the island as the map really has it.
        areas.add(landmassAreaAt(heights, WORLD_SIZE, island.anchorX, island.anchorY));
      }
    }
    expect(areas.size).toBeGreaterThan(2);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('leaves no seam at the starter square edge', () => {
    // Nothing in genesis may be shaped like the unlock footprint: a player
    // looking at the map must not be able to see where their territory ends.
    // The 2026-08-25 habitat rescale drew exactly that rectangle, which is what
    // the owner rejected on 2026-08-26.
    //
    // MEASURED AGAINST COLUMNS OF THE SAME LATTICE PHASE, which is the whole
    // subtlety. Bilinear interpolation makes the height gradient change at every
    // lattice boundary, so the average step across ANY column that is a multiple
    // of the octave spacings is larger than across its neighbours — and the
    // footprint edge is one of those columns. Comparing it with the column
    // beside it therefore fails on terrain that has no seam at all (measured: 7
    // against 2, on a world genesis had not touched inside the square). Comparing
    // it with columns a whole coarse-lattice period away puts it against the same
    // phase, so anything left over is the footprint's own doing.
    const period = COARSEST_LATTICE_SPACING_CELLS;
    const meanStepAcrossColumn = (cells: Int16Array, column: number, lo: number, hi: number) => {
      let total = 0;
      for (let y = lo; y <= hi; y++) {
        total += Math.abs(cells[y * WORLD_SIZE + column]! - cells[y * WORLD_SIZE + column - 1]!);
      }
      return total / (hi - lo + 1);
    };

    for (const seed of SEEDS.slice(0, 6)) {
      const cells = World.createFresh(WORLD_SIZE, undefined, undefined, seed).map.cells;
      const { lo, hi } = starterBounds(WORLD_SIZE);
      const edge = meanStepAcrossColumn(cells, lo, lo, hi);
      const samePhase =
        (meanStepAcrossColumn(cells, lo - period, lo, hi) +
          meanStepAcrossColumn(cells, lo + period, lo, hi)) /
        2;
      // `+ 1` on both sides so a flat coastline (both zero) compares equal.
      expect(edge + 1).toBeLessThanOrEqual(2 * (samePhase + 1));
    }
  }, WORLD_GENERATION_TIMEOUT_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE LAND GUARANTEE (owner, 2026-08-26)
//
// Whether a fresh world had any dry land at all used to be a property of the
// seed: half the suite's sample came out at 1.4% land, all of it islands the
// guarantee pass had raised. The land pass fixes the world's land FRACTION with
// a single whole-band lift of the noise field — a monotone shift, so nothing is
// stamped and every contour the seed drew stays where it was.
// ─────────────────────────────────────────────────────────────────────────────
describe('the land pass', () => {
  it('leaves no world below GENESIS_MIN_LAND_PERCENT dry land', () => {
    for (const size of [WORLD_SIZE, MIN_WORLD_SIZE]) {
      const short: { seed: number; percent: number }[] = [];
      for (const seed of SEEDS) {
        const cells = World.createFresh(size, undefined, undefined, seed).map.cells;
        let land = 0;
        for (const h of cells) if (h > SEA_LEVEL) land++;
        const percent = (100 * land) / (size * size);
        if (land < Math.ceil((size * size * GENESIS_MIN_LAND_PERCENT) / 100)) {
          short.push({ seed, percent });
        }
      }
      expect({ size, short }).toEqual({ size, short: [] });
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('lifts nothing on a world whose own noise already had the land', () => {
    // The no-op half of the contract. A seed that drew plenty of land must be
    // byte-identical to what the noise alone produced.
    const lifts = SEEDS.map((seed) => buildFreshGenesisTerrain(WORLD_SIZE, seed).noise.landLiftBands);
    expect(lifts.some((lift) => lift === 0)).toBe(true);
    expect(lifts.every((lift) => Number.isInteger(lift) && lift >= 0)).toBe(true);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('never floods the map to reach the floor', () => {
    // A land FLOOR, not a target: the pass lifts by the SMALLEST whole band that
    // clears it, so a world it had to lift still keeps an ocean — and not just
    // any ocean, but one big enough for the kraken, which the basin pass
    // guarantees separately. Asserted as that basin rather than as "half the map
    // is water", because a seed is perfectly entitled to draw a land-heavy world
    // and several of the sample do.
    for (const seed of SEEDS.slice(0, 8)) {
      const cells = World.createFresh(WORLD_SIZE, undefined, undefined, seed).map.cells;
      let water = 0;
      for (const h of cells) if (h <= SEA_LEVEL) water++;
      expect(water).toBeGreaterThanOrEqual(GENESIS_TRENCH_MIN_BASIN_CELLS);
    }
  }, WORLD_GENERATION_TIMEOUT_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TRENCH PASS
//
// One kraken-qualifying trench (owner-ratified 2026-08-19, rule unchanged) plus
// the extras the owner asked for on 2026-08-25. THE KRAKEN GUARANTEE itself is
// measured where it is consumed, against the real habitat survey, in
// plugins/monsters/test/monsters.test.ts; core cannot import a plugin, so it
// cannot state that conclusion here.
//
// What IS core's to state is the pass's structural contract — the properties
// every other consumer of genesis relies on while the guarantee is kept:
//
//   * it only ever moves a cell DOWN;
//   * it only ever moves a cell that was ALREADY open ocean, so no cell's
//     shallow/deep classification changes and the habitat pass before it
//     cannot be undone;
//   * what it writes is an exact band multiple, reproducible from the seed.
// ─────────────────────────────────────────────────────────────────────────────
describe('the trench pass', () => {
  const TRENCH_SIZES = [MIN_WORLD_SIZE, WORLD_SIZE];

  /** The same terrain with the trenches removed — the honest before/after. */
  function untrenched(terrain: FreshGenesisTerrain): FreshGenesisTerrain {
    return { ...terrain, trenches: [] };
  }

  it('cuts between GENESIS_EXTRA_TRENCH_MIN and 1 + _MAX trenches into every world', () => {
    for (const size of TRENCH_SIZES) {
      for (const seed of SEEDS) {
        const { trenches } = buildFreshGenesisTerrain(size, seed);
        expect(trenches.length).toBeGreaterThanOrEqual(GENESIS_EXTRA_TRENCH_MIN);
        expect(trenches.length).toBeLessThanOrEqual(1 + GENESIS_EXTRA_TRENCH_MAX);
      }
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('lays them out differently for different seeds', () => {
    // The owner's "some RANDOM trenches": a layout that were the same in every
    // world would be furniture, not terrain.
    const layouts = SEEDS.map((seed) =>
      JSON.stringify(buildFreshGenesisTerrain(WORLD_SIZE, seed).trenches),
    );
    expect(new Set(layouts).size).toBe(layouts.length);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('cuts every trench floor at least to the reference band, on an exact band', () => {
    // The depth claim, and the invariant the monsters suite pins from the other
    // side. Each trench's anchor — the centre of its floor segment — sits AT
    // LEAST as deep as the reference ocean floor.
    //
    // "At least", not "exactly", and the difference is the extra trenches: a
    // trench only ever LOWERS a cell, so one anchored in a basin the noise had
    // already cut below the reference band leaves that cell where it was. The
    // guarantee is a floor under the depth, never a ceiling on it.
    for (const size of TRENCH_SIZES) {
      for (const seed of SEEDS.slice(0, 8)) {
        const terrain = buildFreshGenesisTerrain(size, seed);
        const world = World.createFresh(size, undefined, undefined, seed);
        for (const trench of terrain.trenches) {
          const floor = world.heightAt(trench.centreX, trench.centreY);
          expect(floor).toBeLessThanOrEqual(
            SEA_LEVEL - GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA * BAND_HEIGHT,
          );
          expect(floor).toBeLessThanOrEqual(GENESIS_TRENCH_QUALIFYING_HEIGHT);
          expect(floor % BAND_HEIGHT === 0).toBe(true);
        }
      }
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('only ever deepens cells that were already open ocean', () => {
    // The whole structural contract in one sweep, counted in raw JS with the
    // assertions at the boundary.
    for (const size of TRENCH_SIZES) {
      for (const seed of SEEDS.slice(0, 5)) {
        const terrain = buildFreshGenesisTerrain(size, seed);
        const before = render(untrenched(terrain), size);
        const after = World.createFresh(size, undefined, undefined, seed).map.cells;

        let raised = 0;
        let movedDryLandOrShallows = 0;
        let deepBefore = 0;
        let deepAfter = 0;

        for (let index = 0; index < before.length; index++) {
          const was = before[index]!;
          const is = after[index]!;
          if (was <= FRESH_SEABED_HEIGHT) deepBefore++;
          if (is <= FRESH_SEABED_HEIGHT) deepAfter++;
          if (is > was) raised++;
          else if (is < was && was > FRESH_SEABED_HEIGHT) movedDryLandOrShallows++;
        }

        expect({ raised, movedDryLandOrShallows }).toEqual({
          raised: 0,
          movedDryLandOrShallows: 0,
        });
        // Therefore the deep/shallow classification is bit-for-bit unmoved, and
        // the habitat pass's repairs survive the trenches cut after them.
        expect(deepAfter).toBe(deepBefore);
      }
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('is deterministic: the same seed plans the same trenches, twice', () => {
    for (const size of TRENCH_SIZES) {
      for (const seed of SEEDS.slice(0, 5)) {
        expect(buildFreshGenesisTerrain(size, seed).trenches).toEqual(
          buildFreshGenesisTerrain(size, seed).trenches,
        );
      }
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('does not disturb genesis for a snapshot-restored world', () => {
    // The pass runs inside buildFreshGenesisTerrain, which World.restore never
    // calls. Stated separately because THIS is the change that would have been
    // tempting to put somewhere both paths share.
    const stored = new Int16Array(WORLD_SIZE * WORLD_SIZE);
    stored.fill(SEA_LEVEL);

    const restored = World.restore(WORLD_SIZE, stored, World.createFresh(WORLD_SIZE).mask);

    let deepest = MAX_HEIGHT;
    for (const h of restored.map.cells) if (h < deepest) deepest = h;
    expect(deepest).toBe(SEA_LEVEL);
  });
});
