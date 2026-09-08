import { beforeEach, describe, expect, it } from 'vitest';
import { DAYS_PER_WEEK, isSettlingDay } from '@terrace/shared';
import { shouldSeed } from '../server/life.ts';
import { BAND_HEIGHT, CHUNK_SIZE, MAX_BRUSH_RADIUS, SEA_LEVEL, bandOf } from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
} from '../../../server/test/support/harness.ts';
import {
  MAX_STRUCTURE_TIER,
  STRUCTURES_ALL_MESSAGE,
  STRUCTURES_CAP,
  STRUCTURES_CHANGES_MESSAGE,
  STRUCTURES_PLUGIN_NAME,
  STRUCTURE_TIERS,
  cellOfKey,
  parseStructureCells,
  structureKey,
} from '../protocol.ts';
import {
  CA_FIXED_SEED_PATTERNS,
  CA_STIR_MAX_SPARKS,
  CA_STIR_PROBABILITY_PER_GENERATION,
  attemptSeed,
  attemptStir,
  placePatternAt,
  stepGeneration,
  type LiveCellRecord,
} from '../server/life.ts';
import {
  CA_GENERATIONS_PER_TIER,
  STRUCTURE_UPGRADE_MIN_NEIGHBORS,
  maybeAdvanceTier,
} from '../server/tiers.ts';
import {
  blessedStructureCellCount,
  isBlessedStructureCell,
  resetBlessings,
  setBlessedStructureCells,
} from '../server/blessings.ts';
import {
  FOOTPRINT_CHECK_RADIUS_CELLS,
  hasClearFootprint,
  isBuildableCell,
  isFlatEnough,
  type StructuresWorld,
} from '../server/suitability.ts';
import { hasNearbyFarmland } from '../server/farmland.ts';
import { isFarmlandCell } from '@terrace/shared';
import {
  currentGeneration,
  currentLive,
  plugin as structuresPlugin,
  resetStructuresState,
  standingStructures,
} from '../server/index.ts';
import { STRUCTURES_SLICE_VERSION, loadStructures, saveStructures } from '../server/persistence.ts';
import { createStructuresRng } from '../server/rng.ts';
import { worldWithTerrain } from './support/world.ts';

function boardOf(cells: ReadonlyArray<readonly [number, number]>): Map<number, LiveCellRecord> {
  const live = new Map<number, LiveCellRecord>();
  for (const [x, y] of cells) live.set(structureKey(x, y), { age: 0, tier: 0 });
  return live;
}

function keysOf(live: ReadonlyMap<number, LiveCellRecord>): Set<number> {
  return new Set(live.keys());
}

const OPEN_WORLD_SIZE = 64;
const OPEN_BAND = 4;

function openWorld(): StructuresWorld {
  const w = worldWithTerrain(OPEN_WORLD_SIZE, () => OPEN_BAND * BAND_HEIGHT);
  return {
    worldSize: w.size,
    chunksPerEdge: w.chunksPerEdge,
    heightAt: (x, y) => w.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => w.isCellUnlocked(x, y),
  };
}

describe('suitability (terrain as walls)', () => {
  const PLATEAU_MIN = 10;
  const PLATEAU_MAX = 149;
  const PLATEAU_BAND = 4;

  function plateauHeight(x: number, y: number): number {
    if (x >= PLATEAU_MIN && x <= PLATEAU_MAX && y >= PLATEAU_MIN && y <= PLATEAU_MAX) {
      return PLATEAU_BAND * BAND_HEIGHT;
    }
    return SEA_LEVEL - BAND_HEIGHT;
  }

  function view(world: World): StructuresWorld {
    return {
      worldSize: world.size,
      chunksPerEdge: world.chunksPerEdge,
      heightAt: (x, y) => world.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
    };
  }

  it('accepts flat, dry, unlocked interior ground', () => {
    const world = view(worldWithTerrain(160, plateauHeight));
    expect(isBuildableCell(world, 79, 79)).toBe(true);
  });

  it('rejects water outright', () => {
    const world = view(worldWithTerrain(160, plateauHeight));
    expect(isBuildableCell(world, 5, 5)).toBe(false);
  });

  it('rejects a cell whose neighbour is on a different terrace band ("steep")', () => {
    const world = view(worldWithTerrain(160, plateauHeight));
    expect(isFlatEnough(world, PLATEAU_MIN, 79)).toBe(false);
    expect(isBuildableCell(world, PLATEAU_MIN, 79)).toBe(false);
    expect(isBuildableCell(world, PLATEAU_MIN + FOOTPRINT_CHECK_RADIUS_CELLS, 79)).toBe(true);
  });

  it('refuses cells outside the world and inside locked chunks', () => {
    const isLocked = (_cx: number, cy: number): boolean => cy === 1;
    const world = view(worldWithTerrain(160, plateauHeight, isLocked));
    expect(isBuildableCell(world, 79, 20)).toBe(false);
    expect(isBuildableCell(world, 79, 79)).toBe(true);
    expect(isBuildableCell(world, -1, 79)).toBe(false);
    expect(isBuildableCell(world, 160, 79)).toBe(false);
  });
});

describe('footprint fit (the model cannot overhang a terrace edge or the waterline)', () => {
  const CENTER_BAND = 4;
  const FOOTPRINT_WORLD_SIZE = 32;
  const CX = 20;
  const CY = 20;

  function baseFootprintWorld(oddOneOut: { dx: number; dy: number; height: number }): StructuresWorld {
    const w = worldWithTerrain(FOOTPRINT_WORLD_SIZE, (x, y) => {
      if (x === CX + oddOneOut.dx && y === CY + oddOneOut.dy) return oddOneOut.height;
      return CENTER_BAND * BAND_HEIGHT;
    });
    return {
      worldSize: w.size,
      chunksPerEdge: w.chunksPerEdge,
      heightAt: (x, y) => w.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => w.isCellUnlocked(x, y),
    };
  }

  it('fits: a cell whose whole Moore neighbourhood (orthogonal AND diagonal) is dry and same-band is buildable', () => {
    const world = worldWithTerrain(FOOTPRINT_WORLD_SIZE, () => CENTER_BAND * BAND_HEIGHT);
    const view: StructuresWorld = {
      worldSize: world.size,
      chunksPerEdge: world.chunksPerEdge,
      heightAt: (x, y) => world.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
    };
    expect(isFlatEnough(view, CX, CY)).toBe(true);
    expect(hasClearFootprint(view, CX, CY)).toBe(true);
    expect(isBuildableCell(view, CX, CY)).toBe(true);
  });

  it('overhangs-cliff: rejected when only a DIAGONAL neighbour sits on a different terrace band, even though all four orthogonal neighbours match', () => {
    const world = baseFootprintWorld({ dx: 1, dy: 1, height: (CENTER_BAND + 1) * BAND_HEIGHT });
    expect(isFlatEnough(world, CX, CY)).toBe(true);
    expect(hasClearFootprint(world, CX, CY)).toBe(false);
    expect(isBuildableCell(world, CX, CY)).toBe(false);
  });

  it('overhangs-water: rejected when a DIAGONAL neighbour is water at the SAME band as the (dry) centre — the reported shoreline defect', () => {
    const SHORE_BAND = 0;
    const DRY_SHORE_HEIGHT = Math.floor(BAND_HEIGHT / 2);
    const world = worldWithTerrain(FOOTPRINT_WORLD_SIZE, (x, y) => {
      if (x === CX + 1 && y === CY + 1) return SEA_LEVEL;
      return DRY_SHORE_HEIGHT;
    });
    const view: StructuresWorld = {
      worldSize: world.size,
      chunksPerEdge: world.chunksPerEdge,
      heightAt: (x, y) => world.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
    };
    expect(bandOf(SEA_LEVEL)).toBe(SHORE_BAND);
    expect(bandOf(DRY_SHORE_HEIGHT)).toBe(SHORE_BAND);
    expect(isFlatEnough(view, CX, CY)).toBe(true);
    expect(hasClearFootprint(view, CX, CY)).toBe(false);
    expect(isBuildableCell(view, CX, CY)).toBe(false);
  });

  it('tier-growth: a footprint that fits at birth is re-validated every generation for free, so no separate check is needed as a structure advances tiers', () => {
    const good = worldWithTerrain(FOOTPRINT_WORLD_SIZE, () => CENTER_BAND * BAND_HEIGHT);
    const goodView: StructuresWorld = {
      worldSize: good.size,
      chunksPerEdge: good.chunksPerEdge,
      heightAt: (x, y) => good.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => good.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => good.isCellUnlocked(x, y),
    };
    let board = boardOf([[CX, CY], [CX + 1, CY], [CX, CY + 1], [CX + 1, CY + 1]]);
    for (let i = 0; i < CA_GENERATIONS_PER_TIER; i++) board = stepGeneration(goodView, board).nextLive;
    const grown = board.get(structureKey(CX, CY));
    expect(grown).toBeDefined();
    expect(grown!.tier).toBeGreaterThan(0);

    const spoiled = worldWithTerrain(FOOTPRINT_WORLD_SIZE, (x, y) => {
      if (x === CX - 1 && y === CY - 1) return SEA_LEVEL;
      return CENTER_BAND * BAND_HEIGHT;
    });
    const spoiledView: StructuresWorld = {
      worldSize: spoiled.size,
      chunksPerEdge: spoiled.chunksPerEdge,
      heightAt: (x, y) => spoiled.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => spoiled.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => spoiled.isCellUnlocked(x, y),
    };
    expect(isFlatEnough(spoiledView, CX, CY)).toBe(true);
    const outcome = stepGeneration(spoiledView, board);
    expect(outcome.nextLive.has(structureKey(CX, CY))).toBe(false);
    expect(outcome.died).toContainEqual({ x: CX, y: CY });
  });
});

describe('B3/S23 correctness on open ground', () => {
  it('a block holds as an ordinary still life until its first cell earns tier 1, which founds a building and demolishes the rest', () => {
    const world = openWorld();
    let live = boardOf([[10, 10], [11, 10], [10, 11], [11, 11]]);
    const before = keysOf(live);

    for (let gen = 1; gen < CA_GENERATIONS_PER_TIER; gen++) {
      const outcome = stepGeneration(world, live);
      expect(outcome.born).toHaveLength(0);
      expect(outcome.died).toHaveLength(0);
      expect(outcome.upgraded).toHaveLength(0);
      live = outcome.nextLive;
    }
    expect(keysOf(live)).toEqual(before);

    const outcome = stepGeneration(world, live);
    expect(outcome.upgraded).toEqual([{ x: 10, y: 10, tier: 1 }]);
    expect(outcome.died.map((c) => `${c.x},${c.y}`).sort()).toEqual(['10,11', '11,10', '11,11']);
    expect(keysOf(outcome.nextLive)).toEqual(new Set([structureKey(10, 10)]));
    expect(outcome.nextLive.get(structureKey(10, 10))!.tier).toBe(1);
    live = outcome.nextLive;

    for (let gen = 0; gen < 5; gen++) {
      const quiet = stepGeneration(world, live);
      expect(quiet.born).toHaveLength(0);
      expect(quiet.died).toHaveLength(0);
      live = quiet.nextLive;
    }
    expect(live.size).toBe(1);
  });

  it('a blinker oscillates with period 2', () => {
    const world = openWorld();
    const horizontal = boardOf([[9, 10], [10, 10], [11, 10]]);
    const vertical = boardOf([[10, 9], [10, 10], [10, 11]]);

    const step1 = stepGeneration(world, horizontal);
    expect(keysOf(step1.nextLive)).toEqual(keysOf(vertical));
    const step2 = stepGeneration(world, step1.nextLive);
    expect(keysOf(step2.nextLive)).toEqual(keysOf(horizontal));

    expect(step1.born.map((c) => `${c.x},${c.y}`).sort()).toEqual(['10,11', '10,9']);
    expect(step1.died.map((c) => `${c.x},${c.y}`).sort()).toEqual(['11,10', '9,10']);
  });

  it('a glider translates by pure B3/S23 only until one of its cells is old enough to found a building', () => {
    const world = openWorld();
    let live = boardOf([[11, 10], [12, 11], [10, 12], [11, 12], [12, 12]]);

    for (let step = 0; step < CA_GENERATIONS_PER_TIER - 1; step++) {
      live = stepGeneration(world, live).nextLive;
    }
    const midFlight = boardOf([[12, 11], [10, 12], [12, 12], [11, 13], [12, 13]]);
    expect(keysOf(live)).toEqual(keysOf(midFlight));

    const outcome = stepGeneration(world, live);
    expect(outcome.upgraded).toEqual([{ x: 12, y: 12, tier: 1 }]);
    expect(outcome.born).toHaveLength(0);
    expect(outcome.died).toHaveLength(4);
    expect(keysOf(outcome.nextLive)).toEqual(new Set([structureKey(12, 12)]));
  });

  it('an isolated single cell dies of underpopulation', () => {
    const world = openWorld();
    const live = boardOf([[20, 20]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.size).toBe(0);
    expect(outcome.died).toEqual([{ x: 20, y: 20 }]);
  });

  it('a dense cluster dies of overpopulation', () => {
    const world = openWorld();
    const cells: Array<[number, number]> = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.push([20 + dx, 20 + dy]);
    const live = boardOf(cells);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
  });
});

describe('terrain as walls', () => {
  it('truncates a pattern at the water/steep edge — a wall cell is never born into', () => {
    const world = (() => {
      const w = worldWithTerrain(OPEN_WORLD_SIZE, (x) => (x < 32 ? OPEN_BAND * BAND_HEIGHT : SEA_LEVEL - BAND_HEIGHT));
      return {
        worldSize: w.size,
        chunksPerEdge: w.chunksPerEdge,
        heightAt: (x: number, y: number) => w.heightAt(x, y),
        isChunkUnlocked: (cx: number, cy: number) => w.isChunkUnlocked(cx, cy),
        isCellUnlocked: (x: number, y: number) => w.isCellUnlocked(x, y),
      };
    })();

    const live = boardOf([[29, 10], [30, 10], [29, 11], [30, 11]]);
    const outcome = stepGeneration(world, live);

    expect(outcome.nextLive.has(structureKey(30, 10))).toBe(false);
    expect(outcome.nextLive.has(structureKey(30, 11))).toBe(false);
    for (const key of outcome.nextLive.keys()) {
      expect(cellOfKey(key).x).toBeLessThan(30);
    }
    expect(outcome.nextLive.has(structureKey(29, 10))).toBe(true);
    expect(outcome.nextLive.has(structureKey(29, 11))).toBe(true);
  });

  it('a live cell on now-locked ground can never be part of a birth', () => {
    const isLocked = (_cx: number, cy: number): boolean => cy === 0;
    const w = worldWithTerrain(OPEN_WORLD_SIZE, () => OPEN_BAND * BAND_HEIGHT, isLocked);
    const world: StructuresWorld = {
      worldSize: w.size,
      chunksPerEdge: w.chunksPerEdge,
      heightAt: (x, y) => w.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => w.isCellUnlocked(x, y),
    };
    const live = boardOf([[9, 15], [10, 15 - 1], [11, 15]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(10, 15))).toBe(false);
  });
});

describe('tier progression: age AND neighbour density', () => {
  it('never advances before its age threshold, whatever the neighbour count', () => {
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER - 1, 0, 8)).toBe(0);
  });

  it('never advances below the neighbour threshold, however old', () => {
    expect(maybeAdvanceTier(1_000_000, 0, STRUCTURE_UPGRADE_MIN_NEIGHBORS - 1)).toBe(0);
  });

  it('advances exactly one tier when both conditions hold', () => {
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER, 0, STRUCTURE_UPGRADE_MIN_NEIGHBORS)).toBe(1);
  });

  it('never advances past the top tier', () => {
    expect(maybeAdvanceTier(1_000_000, MAX_STRUCTURE_TIER, 8)).toBe(MAX_STRUCTURE_TIER);
  });

  it('a dense core founds a building that out-ages an equally old, sparser oscillator', () => {
    const world = openWorld();
    let live = boardOf([
      [10, 10], [11, 10], [10, 11], [11, 11],
      [40, 10], [41, 10], [42, 10],
    ]);

    const generations = CA_GENERATIONS_PER_TIER * 2 + 1;
    for (let gen = 0; gen < generations; gen++) live = stepGeneration(world, live).nextLive;

    expect(live.get(structureKey(10, 10))!.tier).toBeGreaterThan(0);
    for (const [x, y] of [[11, 10], [10, 11], [11, 11]] as const) {
      expect(live.has(structureKey(x, y))).toBe(false);
    }

    const blinkerCentreKeys = [structureKey(40, 10), structureKey(41, 10), structureKey(42, 10)];
    const survivingCentre = blinkerCentreKeys
      .map((key) => live.get(key))
      .find((record) => record !== undefined);
    expect(survivingCentre).toBeDefined();
    expect(survivingCentre!.tier).toBe(0);
  });
});

describe('seeding', () => {
  it('places one of the fixed patterns or a soup, on clear buildable ground only', () => {
    const world = openWorld();
    const rng = createStructuresRng(1);
    const placed = attemptSeed(world, new Map(), rng);
    expect(placed).not.toBeNull();
    expect(placed!.length).toBeGreaterThan(0);
    for (const cell of placed!) {
      expect(cell.tier).toBe(0);
      expect(isBuildableCell(world, cell.x, cell.y)).toBe(true);
    }
  });

  it('never overlaps an already-live cell', () => {
    const world = openWorld();
    const rng = createStructuresRng(1);
    const live = new Map<number, LiveCellRecord>();
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) live.set(structureKey(x, y), { age: 0, tier: 0 });
    const placed = attemptSeed(world, live, rng);
    if (placed !== null) {
      for (const cell of placed) expect(live.has(structureKey(cell.x, cell.y))).toBe(false);
    }
  });

  it('the fixed pattern library has at least the four named classics', () => {
    const names = CA_FIXED_SEED_PATTERNS.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['block', 'blinker', 'glider', 'r-pentomino']));
  });

  function partiallyUnlockedWorld(unlockedChunks: ReadonlyArray<readonly [number, number]>): StructuresWorld {
    const size = 64;
    const unlocked = new Set(unlockedChunks.map(([cx, cy]) => cy * (size / CHUNK_SIZE) + cx));
    const isChunkUnlocked = (cx: number, cy: number): boolean =>
      unlocked.has(cy * (size / CHUNK_SIZE) + cx);
    return {
      worldSize: size,
      chunksPerEdge: size / CHUNK_SIZE,
      heightAt: () => 4 * BAND_HEIGHT,
      isChunkUnlocked,
      isCellUnlocked: (x, y) =>
        isChunkUnlocked(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)),
    };
  }

  it('spends its whole attempt budget on unlocked ground: seeds land even when almost all chunks are locked', () => {
    const world = partiallyUnlockedWorld([[2, 1]]);
    const rng = createStructuresRng(7);
    let placements = 0;
    for (let roll = 0; roll < 20; roll++) {
      const placed = attemptSeed(world, new Map(), rng);
      if (placed === null) continue;
      placements++;
      for (const cell of placed) {
        expect(isBuildableCell(world, cell.x, cell.y)).toBe(true);
      }
    }
    expect(placements).toBeGreaterThanOrEqual(18);
  });

  it('prefers settlement-free chunks, so new colonies appear in OTHER places', () => {
    const world = partiallyUnlockedWorld([[0, 0], [3, 3]]);
    const live = boardOf([[2, 2], [3, 2], [2, 3], [3, 3]]);
    const rng = createStructuresRng(11);
    let placements = 0;
    for (let roll = 0; roll < 12; roll++) {
      const placed = attemptSeed(world, live, rng);
      if (placed === null) continue;
      placements++;
      for (const cell of placed) {
        expect(Math.floor(cell.x / CHUNK_SIZE)).toBe(3);
        expect(Math.floor(cell.y / CHUNK_SIZE)).toBe(3);
      }
    }
    expect(placements).toBeGreaterThan(0);
  });

  it('falls back to occupied chunks only when every unlocked chunk is occupied', () => {
    const world = partiallyUnlockedWorld([[1, 1]]);
    const live = boardOf([[20, 20], [21, 20], [20, 21], [21, 21]]);
    const rng = createStructuresRng(3);
    const placed = attemptSeed(world, live, rng);
    if (placed !== null) {
      for (const cell of placed) {
        expect(Math.floor(cell.x / CHUNK_SIZE)).toBe(1);
        expect(Math.floor(cell.y / CHUNK_SIZE)).toBe(1);
        expect(live.has(structureKey(cell.x, cell.y))).toBe(false);
      }
    }
  });

  it('never seeds past STRUCTURES_CAP', () => {
    const world = openWorld();
    const rng = createStructuresRng(5);
    const live = new Map<number, LiveCellRecord>();
    let placedCount = 0;
    outer: for (let y = 0; y < OPEN_WORLD_SIZE && placedCount < STRUCTURES_CAP - 2; y += 1) {
      for (let x = 0; x < OPEN_WORLD_SIZE; x += 1) {
        if (placedCount >= STRUCTURES_CAP - 2) break outer;
        live.set(structureKey(x, y), { age: 0, tier: 0 });
        placedCount++;
      }
    }
    for (let roll = 0; roll < 10; roll++) {
      const placed = attemptSeed(world, live, rng);
      if (placed !== null) {
        expect(live.size + placed.length).toBeLessThanOrEqual(STRUCTURES_CAP);
      }
    }
  });

  it('placePatternAt is the single placement authority: rejects overlap and unbuildable ground', () => {
    const world = openWorld();
    const block = CA_FIXED_SEED_PATTERNS[0].cells;
    const placed = placePatternAt(world, new Map(), 10, 10, block);
    expect(placed).not.toBeNull();
    expect(placed!.length).toBe(block.length);
    const live = boardOf([[11, 11]]);
    expect(placePatternAt(world, live, 10, 10, block)).toBeNull();
  });
});

describe('stirring', () => {
  const BLOCK: ReadonlyArray<readonly [number, number]> = [[10, 10], [11, 10], [10, 11], [11, 11]];

  function isMooreAdjacentToLive(live: ReadonlyMap<number, LiveCellRecord>, x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (live.has(structureKey(x + dx, y + dy))) return true;
      }
    }
    return false;
  }

  function setsEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    if (a.size !== b.size) return false;
    for (const key of a) if (!b.has(key)) return false;
    return true;
  }

  it('an empty board never stirs — seeding owns it', () => {
    const world = openWorld();
    const rng = createStructuresRng(1);
    expect(attemptStir(world, new Map(), rng)).toBeNull();
  });

  it('sparks land only on dead, buildable cells Moore-adjacent to a live cell', () => {
    const world = openWorld();
    const live = boardOf(BLOCK);
    const rng = createStructuresRng(2);
    let firedAtLeastOnce = false;

    for (let roll = 0; roll < 30; roll++) {
      const sparks = attemptStir(world, live, rng);
      if (sparks === null) continue;
      firedAtLeastOnce = true;
      expect(sparks.length).toBeGreaterThanOrEqual(1);
      expect(sparks.length).toBeLessThanOrEqual(CA_STIR_MAX_SPARKS);
      for (const spark of sparks) {
        expect(spark.tier).toBe(0);
        expect(live.has(structureKey(spark.x, spark.y))).toBe(false);
        expect(isBuildableCell(world, spark.x, spark.y)).toBe(true);
        expect(isMooreAdjacentToLive(live, spark.x, spark.y)).toBe(true);
      }
    }
    expect(firedAtLeastOnce).toBe(true);
  });

  it('never pushes the population past STRUCTURES_CAP, taking fewer sparks rather than none', () => {
    const world = openWorld();
    const rng = createStructuresRng(4);
    const live = new Map<number, LiveCellRecord>();
    let placed = 0;
    outer: for (let y = 0; y < OPEN_WORLD_SIZE && placed < STRUCTURES_CAP - 2; y++) {
      for (let x = 0; x < OPEN_WORLD_SIZE; x++) {
        if (placed >= STRUCTURES_CAP - 2) break outer;
        live.set(structureKey(x, y), { age: 0, tier: 0 });
        placed++;
      }
    }
    for (let roll = 0; roll < 10; roll++) {
      const sparks = attemptStir(world, live, rng);
      if (sparks !== null) {
        expect(live.size + sparks.length).toBeLessThanOrEqual(STRUCTURES_CAP);
        expect(sparks.length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('is deterministic: the same rng seed and board produce identical sparks', () => {
    const world = openWorld();
    const rng1 = createStructuresRng(9);
    const rng2 = createStructuresRng(9);
    const sparks1 = attemptStir(world, boardOf(BLOCK), rng1);
    const sparks2 = attemptStir(world, boardOf(BLOCK), rng2);
    expect(sparks1).not.toBeNull();
    expect(sparks1).toEqual(sparks2);
  });

  it('a lone 2×2 block, stirred at the real simulate() cadence over ~30 generations, ends up different from its original state at least once', () => {
    const world = openWorld();
    let live = boardOf(BLOCK);
    const original = keysOf(live);
    const rng = createStructuresRng(3);

    let everDiffered = false;
    for (let gen = 0; gen < 30; gen++) {
      live = stepGeneration(world, live).nextLive;
      if (rng.next() < CA_STIR_PROBABILITY_PER_GENERATION) {
        const sparks = attemptStir(world, live, rng);
        if (sparks !== null) {
          for (const spark of sparks) live.set(structureKey(spark.x, spark.y), { age: 0, tier: 0 });
        }
      }
      if (!setsEqual(keysOf(live), original)) {
        everDiffered = true;
        break;
      }
    }
    expect(everDiffered).toBe(true);
  });
});

describe('world-wide caps', () => {
  it('STRUCTURE_TIERS has between four and six distinct entries', () => {
    expect(STRUCTURE_TIERS.length).toBeGreaterThanOrEqual(4);
    expect(STRUCTURE_TIERS.length).toBeLessThanOrEqual(6);
    expect(new Set(STRUCTURE_TIERS).size).toBe(STRUCTURE_TIERS.length);
  });

  it('STRUCTURES_CAP is a positive, sane ceiling', () => {
    expect(STRUCTURES_CAP).toBeGreaterThan(0);
  });
});

const WORLD_SIZE = 160;
const DT = 0.1;
const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };
const ALL_WIRE_TYPE = `${STRUCTURES_PLUGIN_NAME}:${STRUCTURES_ALL_MESSAGE}`;
const CHANGES_WIRE_TYPE = `${STRUCTURES_PLUGIN_NAME}:${STRUCTURES_CHANGES_MESSAGE}`;

function flatOpenTerrain(): number {
  return OPEN_BAND * BAND_HEIGHT;
}

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function bootOn(world: World, restore?: unknown): Harness {
  resetStructuresState();
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(world, [structuresPlugin].map(asLoadedPlugin));
  if (restore !== undefined) host.restorePersistence({ [STRUCTURES_PLUGIN_NAME]: restore });
  host.worldCreate();
  return { world, host, sink };
}

function boot(): Harness {
  return bootOn(worldWithTerrain(WORLD_SIZE, flatOpenTerrain));
}

const SEEDED_BOARD: ReadonlyArray<readonly [number, number]> = [
  [40, 40], [41, 40], [40, 41], [41, 41],
  [80, 80], [81, 80], [80, 81], [81, 81],
  [121, 40], [122, 40], [120, 41], [123, 41], [121, 42], [122, 42],
];

function bootPopulated(): Harness {
  const rng = createStructuresRng(1);
  return bootOn(
    worldWithTerrain(WORLD_SIZE, flatOpenTerrain),
    saveStructures(boardOf(SEEDED_BOARD), 0, rng, -1),
  );
}

function join(harness: Harness): void {
  harness.world.addPlayer(PLAYER);
  grantTokenEveryUnlockedChunk(harness.world, PLAYER.token);
  harness.host.playerJoined(PLAYER);
}

function advance(harness: Harness, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) harness.host.tick(DT);
}

const HOST_TEST_TIMEOUT_MS = 20_000;

describe('the CA through the real host', () => {
  it('an empty world eventually seeds something, on its own cadence', () => {
    const harness = boot();
    advance(harness, 15 * 40);
    expect(standingStructures().length).toBeGreaterThan(0);
    expect(currentGeneration()).toBeGreaterThan(0);
  }, HOST_TEST_TIMEOUT_MS);

  it(
    'every standing structure is on buildable ground and a valid tier',
    () => {
      const harness = bootPopulated();
      advance(harness, 15 * 60);
      const world: StructuresWorld = {
        worldSize: harness.world.size,
        chunksPerEdge: harness.world.chunksPerEdge,
        heightAt: (x, y) => harness.world.heightAt(x, y),
        isChunkUnlocked: (cx, cy) => harness.world.isChunkUnlocked(cx, cy),
        isCellUnlocked: (x, y) => harness.world.isCellUnlocked(x, y),
      };
      expect(standingStructures().length).toBeGreaterThan(0);
      for (const structure of standingStructures()) {
        expect(isBuildableCell(world, structure.x, structure.y)).toBe(true);
        expect(structure.tier).toBeGreaterThanOrEqual(0);
        expect(structure.tier).toBeLessThanOrEqual(MAX_STRUCTURE_TIER);
      }
    },
    20_000,
  );
});

describe('demolition', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = bootPopulated();
    join(harness);
    advance(harness, 15 * 40);
    expect(standingStructures().length).toBeGreaterThan(0);
  });

  it('kills a live cell the instant its own cell is sculpted, and broadcasts it', () => {
    const victim = standingStructures()[0];
    harness.sink.clear();

    const outcome = handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: victim.x, y: victim.y, radius: MAX_BRUSH_RADIUS, dir: 1 },
    );
    expect(outcome.applied).toBe(true);
    expect(currentLive().has(structureKey(victim.x, victim.y))).toBe(false);

    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    const demolished = (changes[0].payload as { demolished: number[] }).demolished;
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i + 1 < demolished.length; i += 2) pairs.push([demolished[i], demolished[i + 1]]);
    expect(pairs).toContainEqual([victim.x, victim.y]);
  });

  it('does not kill a structure whose own cell was untouched by the diff', () => {
    const victim = standingStructures().find((s) => s.x > 30 && s.x < WORLD_SIZE - 30);
    expect(victim).toBeDefined();
    const other = standingStructures().find((s) => s.x !== victim!.x || s.y !== victim!.y);

    handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: victim!.x, y: victim!.y, radius: 1, dir: 1 },
    );

    if (other !== undefined && (other.x - victim!.x) ** 2 + (other.y - victim!.y) ** 2 > 4) {
      expect(currentLive().has(structureKey(other.x, other.y))).toBe(true);
    }
  });
});

describe('broadcast model', () => {
  it('sends the whole board to a joining player, and only to them', () => {
    const harness = boot();
    advance(harness, 15 * 40);
    harness.sink.clear();

    join(harness);

    const snapshots = harness.sink.ofType(ALL_WIRE_TYPE);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].target).toBe(PLAYER.id);
    const cells = parseStructureCells((snapshots[0].payload as { structures: number[] }).structures) ?? [];
    expect(cells).toHaveLength(standingStructures().length);
  }, HOST_TEST_TIMEOUT_MS);

  it('sends each connected player only the structures inside their own unlocked view', () => {
    const harness = boot();
    join(harness);
    advance(harness, 15 * 40);
    expect(standingStructures().length).toBeGreaterThan(0);

    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider);

    harness.sink.clear();
    const forOutsider = harness.sink.ofType(ALL_WIRE_TYPE).filter((m) => m.target === outsider.id);
    expect(forOutsider).toHaveLength(0);
  }, HOST_TEST_TIMEOUT_MS);

  it('pushes a targeted refresh when a player creeps into a chunk that already has a structure', () => {
    const harness = boot();
    advance(harness, 15 * 40);
    const victim = standingStructures()[0];
    expect(victim).toBeDefined();
    const cx = Math.floor(victim!.x / CHUNK_SIZE);
    const cy = Math.floor(victim!.y / CHUNK_SIZE);

    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider);
    harness.sink.clear();

    expect(harness.world.unlockChunkForToken(outsider.token, cx, cy)).toBe(true);
    harness.host.notifyChunkUnlockedForToken(outsider.token, cx, cy);

    const changes = harness.sink
      .ofType(CHANGES_WIRE_TYPE)
      .filter((m) => m.target === outsider.id);
    expect(changes).toHaveLength(1);
    const founded =
      parseStructureCells((changes[0].payload as { founded: number[] }).founded) ?? [];
    expect(founded).toContainEqual({ x: victim!.x, y: victim!.y, tier: victim!.tier });
  }, HOST_TEST_TIMEOUT_MS);
});

describe('persistence', () => {
  it('round-trips the board — including age, tier and the generation counter — across a restart', () => {
    const first = boot();
    advance(first, 15 * 40);
    const before = standingStructures();
    const generationBefore = currentGeneration();
    const liveBefore = new Map(currentLive());
    expect(before.length).toBeGreaterThan(0);
    expect(generationBefore).toBeGreaterThan(0);

    const slice = first.host.collectPersistence()[STRUCTURES_PLUGIN_NAME];

    const second = bootOn(worldWithTerrain(WORLD_SIZE, flatOpenTerrain), slice);
    expect(standingStructures()).toEqual(before);
    expect(currentGeneration()).toBe(generationBefore);
    expect(currentLive()).toEqual(liveBefore);
  }, HOST_TEST_TIMEOUT_MS);

  it('survives a truncated, foreign or hand-edited slice', () => {
    for (const junk of [
      null,
      undefined,
      42,
      'towns',
      {},
      { version: STRUCTURES_SLICE_VERSION + 1, live: [] },
      { version: STRUCTURES_SLICE_VERSION, live: 'nope' },
    ]) {
      const restored = loadStructures(junk);
      expect(restored.live.size).toBe(0);
      expect(Number.isInteger(restored.rngState)).toBe(true);
      expect(restored.generation).toBe(0);
    }
  });

  it('drops individually malformed entries and keeps the rest', () => {
    const restored = loadStructures({
      version: STRUCTURES_SLICE_VERSION,
      rngState: 1,
      generation: 12,
      live: [
        { x: 5, y: 6, age: 10, tier: 2 },
        { x: 7, y: 8, age: 10, tier: 99 },
        { x: -1, y: 0, age: 0, tier: 0 },
      ],
    });
    expect(restored.generation).toBe(12);
    expect(Array.from(restored.live.entries())).toEqual([
      [structureKey(5, 6), { age: 10, tier: 2 }],
    ]);
  });

  it('writes a slice this plugin can read back verbatim', () => {
    const rng = createStructuresRng(7);
    rng.next();
    const live = new Map<number, LiveCellRecord>([[structureKey(10, 11), { age: 5, tier: 2 }]]);

    const slice = saveStructures(live, 9, rng, -1);
    expect(slice.version).toBe(STRUCTURES_SLICE_VERSION);
    expect(slice.generation).toBe(9);

    const restored = loadStructures(JSON.parse(JSON.stringify(slice)));
    expect(restored.generation).toBe(9);
    expect(restored.live).toEqual(live);
    expect(restored.rngState).toBe(rng.state());
  });

  it('a structure restored onto ground it can no longer stand on is pruned immediately on load, not merely at the next generation', () => {
    const first = boot();
    advance(first, 15 * 40);
    const slice = first.host.collectPersistence()[STRUCTURES_PLUGIN_NAME];
    expect(standingStructures().length).toBeGreaterThan(0);

    const drowned = bootOn(worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT), slice);
    expect(standingStructures()).toHaveLength(0);

    advance(drowned, 15 + DT);
    expect(standingStructures()).toHaveLength(0);
  }, HOST_TEST_TIMEOUT_MS);

  it('a structure restored onto ground that still fits survives load untouched', () => {
    const first = boot();
    advance(first, 15 * 40);
    const before = standingStructures();
    expect(before.length).toBeGreaterThan(0);
    const slice = first.host.collectPersistence()[STRUCTURES_PLUGIN_NAME];

    bootOn(worldWithTerrain(WORLD_SIZE, flatOpenTerrain), slice);
    expect(standingStructures().length).toBe(before.length);
  }, HOST_TEST_TIMEOUT_MS);
});

describe('route blessings (pilgrim routes contract)', () => {
  function blinkerAt(x: number, y: number): Map<number, LiveCellRecord> {
    return boardOf([
      [x - 1, y],
      [x, y],
      [x + 1, y],
    ]);
  }

  function runGenerations(
    world: StructuresWorld,
    live: Map<number, LiveCellRecord>,
    generations: number,
  ): ReadonlyMap<number, LiveCellRecord> {
    let board: ReadonlyMap<number, LiveCellRecord> = live;
    for (let i = 0; i < generations; i++) board = stepGeneration(world, board).nextLive;
    return board;
  }

  beforeEach(() => {
    resetBlessings();
  });

  it('lets a blessed under-neighboured survivor earn tiers on the age schedule', () => {
    const world = openWorld();
    const centre = structureKey(20, 20);
    setBlessedStructureCells([centre]);

    const board = runGenerations(world, blinkerAt(20, 20), CA_GENERATIONS_PER_TIER);
    expect(board.get(centre)?.tier).toBe(1);

    const later = runGenerations(world, new Map(board), CA_GENERATIONS_PER_TIER);
    expect(later.get(centre)?.tier).toBe(2);
  });

  it('changes nothing for the same cell unblessed', () => {
    const world = openWorld();
    const centre = structureKey(20, 20);
    const board = runGenerations(world, blinkerAt(20, 20), CA_GENERATIONS_PER_TIER * 3);
    expect(board.get(centre)?.tier).toBe(0);
  });

  it('never keeps a blessed cell alive — the CA itself is untouched', () => {
    const world = openWorld();
    const a = structureKey(30, 30);
    const b = structureKey(31, 30);
    setBlessedStructureCells([a, b]);
    const board = runGenerations(world, boardOf([[30, 30], [31, 30]]), 1);
    expect(board.has(a)).toBe(false);
    expect(board.has(b)).toBe(false);
  });

  it('replaces the whole set on every call and clears on an empty one', () => {
    setBlessedStructureCells([1, 2, 3]);
    expect(blessedStructureCellCount()).toBe(3);
    setBlessedStructureCells([7]);
    expect(isBlessedStructureCell(7)).toBe(true);
    expect(isBlessedStructureCell(1)).toBe(false);
    setBlessedStructureCells([]);
    expect(blessedStructureCellCount()).toBe(0);
  });

  it('drops malformed keys and caps the set at the structure cap', () => {
    const flood: number[] = [];
    for (let n = 0; n < STRUCTURES_CAP + 10; n++) flood.push(n);
    setBlessedStructureCells([-1, 1.5, Number.NaN, ...flood]);
    expect(blessedStructureCellCount()).toBe(STRUCTURES_CAP);
  });

  it('waives only the neighbour gate in maybeAdvanceTier, never the age gate', () => {
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER - 1, 0, 0, true)).toBe(0);
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER, 0, 0, true)).toBe(1);
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER, 0, 0, false)).toBe(0);
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER, 0, STRUCTURE_UPGRADE_MIN_NEIGHBORS, false)).toBe(1);
  });
});

describe('world events (structures:changes)', () => {
  interface HeardEvent {
    readonly event: string;
    readonly payload: unknown;
  }

  function bootWithRecorder(
    board: ReadonlyArray<readonly [number, number]>,
  ): { world: World; host: PluginHost; events: HeardEvent[] } {
    resetStructuresState();
    const world = worldWithTerrain(OPEN_WORLD_SIZE, () => OPEN_BAND * BAND_HEIGHT);
    world.setSink(new RecordingSink());
    const events: HeardEvent[] = [];
    const recorder = {
      name: 'recorder',
      onWorldEvent(_world: unknown, event: string, payload: unknown): void {
        events.push({ event, payload });
      },
    };
    const host = new PluginHost(world, [structuresPlugin, recorder].map(asLoadedPlugin));
    const rng = createStructuresRng(1);
    host.restorePersistence({
      [STRUCTURES_PLUGIN_NAME]: saveStructures(boardOf(board), 0, rng, -1),
    });
    host.worldCreate();
    return { world, host, events };
  }

  it('a generation emits cause "generation" carrying the CA’s own deaths', () => {
    const { host, events } = bootWithRecorder([
      [30, 30],
      [31, 30],
      [32, 30],
    ]);

    for (let elapsed = 0; elapsed < 20; elapsed += DT) host.tick(DT);

    const changes = events.filter((heard) => heard.event === 'structures:changes');
    expect(changes.length).toBeGreaterThan(0);
    const first = changes[0].payload as {
      cause: string;
      died: Array<{ x: number; y: number }>;
    };
    expect(first.cause).toBe('generation');
    expect(first.died).toContainEqual({ x: 30, y: 30 });
    expect(first.died).toContainEqual({ x: 32, y: 30 });
  });

  it('a sculpt demolition emits cause "sculpt" with the demolished cells — and nothing on a miss', () => {
    const { world, host, events } = bootWithRecorder([
      [40, 40],
      [41, 40],
      [40, 41],
      [41, 41],
    ]);
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);

    handleSculptIntent(
      { world, interceptors: host },
      PLAYER,
      { type: 'sculpt', x: 10, y: 10, radius: 1, dir: 1 },
    );
    expect(events.filter((heard) => heard.event === 'structures:changes')).toHaveLength(0);

    handleSculptIntent(
      { world, interceptors: host },
      PLAYER,
      { type: 'sculpt', x: 40, y: 40, radius: MAX_BRUSH_RADIUS, dir: 1 },
    );
    const changes = events.filter((heard) => heard.event === 'structures:changes');
    expect(changes).toHaveLength(1);
    const payload = changes[0].payload as {
      cause: string;
      died: Array<{ x: number; y: number }>;
    };
    expect(payload.cause).toBe('sculpt');
    expect(payload.died).toHaveLength(4);
    expect(payload.died).toContainEqual({ x: 40, y: 40 });
  });
});

describe('farmland predicate (card 28)', () => {
  const FARMLAND_BAND = 2;
  const DEEP = SEA_LEVEL - 10 * BAND_HEIGHT;

  const dryInBand0 = (fifth: number): number => Math.floor((BAND_HEIGHT * fifth) / 5);

  function farmlandTerrain(x: number, y: number): number {
    if (x === 11 && y === 10) return DEEP;

    if (x === 29 && y === 30) return (FARMLAND_BAND + 1) * BAND_HEIGHT;
    if (x === 30 && y === 29) return DEEP;

    if (x === 40 && y === 40) return dryInBand0(1);
    if (x === 39 && y === 40) return dryInBand0(2);
    if (x === 41 && y === 40) return SEA_LEVEL;
    if (x === 40 && y === 39) return dryInBand0(4);
    if (x === 40 && y === 41) return dryInBand0(3);

    if (x === 50 && y === 50) return SEA_LEVEL;
    if (x === 49 && y === 50) return dryInBand0(1);
    if (x === 51 && y === 50) return dryInBand0(1);
    if (x === 50 && y === 49) return dryInBand0(1);
    if (x === 50 && y === 51) return dryInBand0(1);

    return FARMLAND_BAND * BAND_HEIGHT;
  }

  const FARMLAND_WORLD_SIZE = 64;

  function farmlandWorld(isChunkLocked?: (cx: number, cy: number) => boolean): StructuresWorld {
    const w = worldWithTerrain(FARMLAND_WORLD_SIZE, farmlandTerrain, isChunkLocked);
    return {
      worldSize: w.size,
      chunksPerEdge: w.chunksPerEdge,
      heightAt: (x, y) => w.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => w.isCellUnlocked(x, y),
    };
  }

  it('accepts a flat terrace edged by ordinary (deep) water', () => {
    const world = farmlandWorld();
    expect(isFarmlandCell(world, 10, 10)).toBe(true);
  });

  it('proves the deliberate divergence from isFlatEnough: the SAME cell fails suitability\'s buildability test', () => {
    const world = farmlandWorld();
    expect(isFarmlandCell(world, 10, 10)).toBe(true);
    expect(isFlatEnough(world, 10, 10)).toBe(false);
    expect(isBuildableCell(world, 10, 10)).toBe(false);
  });

  it('rejects flat, dry ground with no water neighbour anywhere', () => {
    const world = farmlandWorld();
    expect(isFarmlandCell(world, 20, 20)).toBe(false);
  });

  it('rejects a cell that touches water but is not flat among its dry neighbours ("sloped")', () => {
    const world = farmlandWorld();
    expect(isFarmlandCell(world, 30, 30)).toBe(false);
  });

  it('handles the sea-level (band 0) boundary: water at height exactly 0 still counts as water, even though it shares band 0 with the dry cell beside it', () => {
    const world = farmlandWorld();
    expect(isFarmlandCell(world, 40, 40)).toBe(true);
  });

  it('rejects a cell that is itself water, however farmland-like its neighbours look', () => {
    const world = farmlandWorld();
    expect(isFarmlandCell(world, 50, 50)).toBe(false);
  });

  it('rejects a cell that runs off the world edge', () => {
    const world = farmlandWorld();
    expect(isFarmlandCell(world, 0, 0)).toBe(false);
  });

  it('requires the cell itself to be unlocked (never leaks a verdict about locked ground)', () => {
    const isLocked = (cx: number, cy: number): boolean => cx === 0 && cy === 0;
    const world = farmlandWorld(isLocked);
    expect(isFarmlandCell(world, 10, 10)).toBe(false);
  });

  it('hasNearbyFarmland is true for farmland itself and for its Moore neighbours, false beyond them', () => {
    const world = farmlandWorld();
    expect(hasNearbyFarmland(world, 10, 10)).toBe(true);
    expect(hasNearbyFarmland(world, 9, 9)).toBe(true);
    expect(hasNearbyFarmland(world, 8, 8)).toBe(false);
    expect(hasNearbyFarmland(world, 20, 20)).toBe(false);
  });
});

describe('birth rate near fed towns (card 28) — bounded to exactly one extra neighbour class', () => {
  const FARMLAND_BAND = 2;
  const DEEP = SEA_LEVEL - 10 * BAND_HEIGHT;
  const WORLD_SIZE = 64;

  function terrainWithFarmlandBeside(x: number, y: number): number {
    if (x === 22 && y === 21) return DEEP;
    return FARMLAND_BAND * BAND_HEIGHT;
  }

  function boostWorld(carveFarmland: boolean): StructuresWorld {
    const heightOf = carveFarmland ? terrainWithFarmlandBeside : () => FARMLAND_BAND * BAND_HEIGHT;
    const w = worldWithTerrain(WORLD_SIZE, heightOf);
    return {
      worldSize: w.size,
      chunksPerEdge: w.chunksPerEdge,
      heightAt: (cx, cy) => w.heightAt(cx, cy),
      isChunkUnlocked: (cx, cy) => w.isChunkUnlocked(cx, cy),
      isCellUnlocked: (cx, cy) => w.isCellUnlocked(cx, cy),
    };
  }

  it('sets up the fixture correctly: the farmland carve works, and the candidate beside it is NO LONGER buildable — the widened footprint square reaches the water that feeds the farm', () => {
    const with_ = boostWorld(true);
    expect(isFarmlandCell(with_, 21, 21)).toBe(true);
    expect(hasNearbyFarmland(with_, 20, 20)).toBe(true);
    expect(isBuildableCell(with_, 20, 20)).toBe(false);

    const without = boostWorld(false);
    expect(isBuildableCell(without, 20, 20)).toBe(true);
    expect(isFarmlandCell(without, 21, 21)).toBe(false);
    expect(hasNearbyFarmland(without, 20, 20)).toBe(false);
  });

  it('a dead cell with exactly 2 live neighbours near farmland is NOT born — the fed birth is unreachable because the ground beside farmland never passes the footprint check', () => {
    const world = boostWorld(true);
    const live = boardOf([[19, 19], [19, 21]]);
    expect(hasNearbyFarmland(world, 20, 20)).toBe(true);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
    expect(outcome.born.some((cell) => cell.x === 20 && cell.y === 20)).toBe(false);
  });

  it('the identical board with exactly 2 live neighbours does NOT birth without farmland nearby — the boost, isolated', () => {
    const world = boostWorld(false);
    const live = boardOf([[19, 19], [19, 21]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
  });

  it('CEILING: farmland never admits a birth at 1 live neighbour', () => {
    const world = boostWorld(true);
    const live = boardOf([[19, 19]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
  });

  it('CEILING: farmland never admits a birth at 4 live neighbours (nor does ordinary B3/S23)', () => {
    const world = boostWorld(true);
    const live = boardOf([[19, 19], [19, 20], [19, 21], [20, 19]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
  });

  it('ordinary B3 birth (3 neighbours) is unaffected by the farmland carve — same outcome on carved and uncarved ground, because neither can use the fed-birth path', () => {
    const live = boardOf([[19, 19], [19, 21], [21, 19]]);
    const withFarmland = stepGeneration(boostWorld(true), live);
    const without = stepGeneration(boostWorld(false), live);
    expect(withFarmland.nextLive.has(structureKey(20, 20))).toBe(false);
    expect(without.nextLive.has(structureKey(20, 20))).toBe(true);
  });

  it('REGRESSION: an entirely unfarmed world (openWorld — no water anywhere) grows exactly as it always did', () => {
    const world = openWorld();
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) {
        expect(hasNearbyFarmland(world, x, y)).toBe(false);
      }
    }
    const live = boardOf([[9, 9], [9, 11]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(10, 10))).toBe(false);
  });
});

describe('settlers arrive on Mondays, and only to an empty world', () => {
  const EMPTY = new Map<number, LiveCellRecord>();
  const INHABITED = new Map<number, LiveCellRecord>([[structureKey(3, 4), { age: 1, tier: 0 }]]);
  const NEVER_SEEDED = -1;

  it('seeds an empty world on a Monday', () => {
    expect(shouldSeed(EMPTY, 0, NEVER_SEEDED)).toBe(true);
    expect(shouldSeed(EMPTY, DAYS_PER_WEEK, NEVER_SEEDED)).toBe(true);
  });

  it('never seeds a world that still has settlements', () => {
    expect(shouldSeed(INHABITED, 0, NEVER_SEEDED)).toBe(false);
  });

  it('never seeds on any other day of the week', () => {
    for (let day = 1; day < DAYS_PER_WEEK; day++) {
      expect(shouldSeed(EMPTY, day, NEVER_SEEDED)).toBe(false);
    }
  });

  it('seeds once per Monday, not once per generation on a Monday', () => {
    expect(shouldSeed(EMPTY, 7, 7)).toBe(false);
    expect(shouldSeed(EMPTY, 14, 7)).toBe(true);
  });

  it('treats day 0 as a real Monday, so "never seeded" cannot be -1 by accident', () => {
    expect(isSettlingDay(0)).toBe(true);
    expect(shouldSeed(EMPTY, 0, 0)).toBe(false);
  });
});
