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

const WORLD_SIZE = NEIGHBOURHOOD_CELLS * 16;

const WORLD_SIZE_WITH_OUTER_TERRAIN = NEIGHBOURHOOD_CELLS * 32;

const VALID_SIZES = [28, 32, 40, 64, 128].map((span) => span * CHUNK_SIZE);

const SEEDS = Array.from({ length: 20 }, (_, i) => i * 104729 + 1);

const ISLAND_PASS_SEEDS = Array.from({ length: 60 }, (_, i) => i * 104729 + 1);

const WORLD_GENERATION_TIMEOUT_MS = 240_000;

const COARSEST_LATTICE_SPACING_CELLS = NEIGHBOURHOOD_CELLS * 4;

function starterBounds(size: number): { lo: number; hi: number } {
  const { startChunk, spanChunks } = initialUnlockFootprint(size);
  const lo = startChunk * CHUNK_SIZE;
  return { lo, hi: lo + spanChunks * CHUNK_SIZE - 1 };
}

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
      expect(height % BAND_HEIGHT === 0).toBe(true);
      expect(isWater(height)).toBe(true);
      expect(height).toBeGreaterThan(MIN_HEIGHT);
    }
  });
});

describe('the whole field', () => {
  it('keeps every height an integer, band-aligned, and inside [MIN_HEIGHT, MAX_HEIGHT]', () => {
    for (const size of [28, 40, 64].map((span) => span * CHUNK_SIZE)) {
      for (const seed of SEEDS.slice(0, 5)) {
        const world = World.createFresh(size, undefined, undefined, seed);
        let allValid = true;
        for (const h of world.map.cells) {
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
    const a = World.createFresh(MIN_WORLD_SIZE, undefined, undefined, 1);
    const b = World.createFresh(MIN_WORLD_SIZE, undefined, undefined, 2);
    expect(Array.from(a.map.cells)).not.toEqual(Array.from(b.map.cells));
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('draws a fresh, non-reproducible seed when none is supplied', () => {
    const worlds = Array.from({ length: 4 }, () =>
      Array.from(World.createFresh(WORLD_SIZE, undefined, undefined).map.cells),
    );
    expect(worlds.every((cells) => cells.every((h, i) => h === worlds[0]![i]))).toBe(false);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('guarantees water at least as deep as FRESH_SEABED_HEIGHT, at every valid size', () => {
    for (const size of VALID_SIZES.slice(0, 3)) {
      for (const seed of SEEDS) {
        const world = World.createFresh(size, undefined, undefined, seed);
        let deepest = MAX_HEIGHT;
        for (const h of world.map.cells) if (h < deepest) deepest = h;
        expect(deepest).toBeLessThanOrEqual(FRESH_SEABED_HEIGHT);
      }
    }
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('keeps the starter unlock square where it was', () => {
    const { startChunk, spanChunks } = initialUnlockFootprint(WORLD_SIZE);
    expect(spanChunks).toBe(INITIAL_UNLOCK_CHUNK_SPAN);

    const world = World.createFresh(WORLD_SIZE, undefined, undefined, 1);
    expect(world.isChunkUnlocked(startChunk, startChunk)).toBe(true);
    expect(world.isChunkUnlocked(startChunk - 1, startChunk)).toBe(false);
    expect(world.isChunkUnlocked(startChunk + spanChunks, startChunk)).toBe(false);
  });

  it('leaves a snapshot-restored world exactly as it was stored', () => {
    const stored = new Int16Array(WORLD_SIZE * WORLD_SIZE);
    stored.fill(SEA_LEVEL);
    stored[0] = BAND_HEIGHT;

    const restored = World.restore(WORLD_SIZE, stored, World.createFresh(WORLD_SIZE).mask);

    expect(restored.heightAt(0, 0)).toBe(BAND_HEIGHT);
    expect(restored.heightAt(1, 0)).toBe(SEA_LEVEL);
  });

});

describe('the island pass', () => {
  it('puts GENESIS_MIN_STARTER_LAND_CELLS of island in every starter square', () => {
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
    const planned = SEEDS.map(
      (seed) => buildFreshGenesisTerrain(WORLD_SIZE, seed).islands.length,
    );
    expect(planned.some((count) => count > 0)).toBe(true);
    expect(planned.some((count) => count === 0)).toBe(true);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('raises islands big enough for its own survey to count them', () => {
    expect(GENESIS_ISLAND_MIN_LAND_CELLS).toBeGreaterThanOrEqual(GENESIS_MIN_ISLAND_CELLS);
  });

  it('lifts the terrain rather than stamping a shape on it', () => {
    const areas = new Set<number>();
    for (const seed of ISLAND_PASS_SEEDS) {
      const terrain = buildFreshGenesisTerrain(WORLD_SIZE, seed);
      if (terrain.islands.length === 0) continue;
      const heights = World.createFresh(WORLD_SIZE, undefined, undefined, seed).map.cells;
      for (const island of terrain.islands) {
        areas.add(landmassAreaAt(heights, WORLD_SIZE, island.anchorX, island.anchorY));
      }
    }
    expect(areas.size).toBeGreaterThan(2);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('leaves no seam at the starter square edge', () => {
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
      expect(edge + 1).toBeLessThanOrEqual(2 * (samePhase + 1));
    }
  }, WORLD_GENERATION_TIMEOUT_MS);
});

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
    const lifts = SEEDS.map((seed) => buildFreshGenesisTerrain(WORLD_SIZE, seed).noise.landLiftBands);
    expect(lifts.some((lift) => lift === 0)).toBe(true);
    expect(lifts.every((lift) => Number.isInteger(lift) && lift >= 0)).toBe(true);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('never floods the map to reach the floor', () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const cells = World.createFresh(WORLD_SIZE, undefined, undefined, seed).map.cells;
      let water = 0;
      for (const h of cells) if (h <= SEA_LEVEL) water++;
      expect(water).toBeGreaterThanOrEqual(GENESIS_TRENCH_MIN_BASIN_CELLS);
    }
  }, WORLD_GENERATION_TIMEOUT_MS);
});

describe('the trench pass', () => {
  const TRENCH_SIZES = [MIN_WORLD_SIZE, WORLD_SIZE];

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
    const layouts = SEEDS.map((seed) =>
      JSON.stringify(buildFreshGenesisTerrain(WORLD_SIZE, seed).trenches),
    );
    expect(new Set(layouts).size).toBe(layouts.length);
  }, WORLD_GENERATION_TIMEOUT_MS);

  it('cuts every trench floor at least to the reference band, on an exact band', () => {
    for (const size of TRENCH_SIZES) {
      for (const seed of SEEDS.slice(0, 8)) {
        const terrain = buildFreshGenesisTerrain(size, seed);
        const world = World.createFresh(size, undefined, undefined, seed);
        for (const trench of terrain.trenches) {
          const anchor = trench.vertices[0]!;
          const floor = world.heightAt(anchor.x, anchor.y);
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
    const stored = new Int16Array(WORLD_SIZE * WORLD_SIZE);
    stored.fill(SEA_LEVEL);

    const restored = World.restore(WORLD_SIZE, stored, World.createFresh(WORLD_SIZE).mask);

    let deepest = MAX_HEIGHT;
    for (const h of restored.map.cells) if (h < deepest) deepest = h;
    expect(deepest).toBe(SEA_LEVEL);
  });
});
