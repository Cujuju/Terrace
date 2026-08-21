// The structures CA, driven both directly (life.ts's pure stepGeneration, for
// exact B3/S23 correctness) and through the REAL plugin host and intent
// pipeline (for demolition, persistence, and the broadcast model) — no stub
// for either. CONTRACT tests: each names a rule the plugin promises (correct
// B3/S23 on open ground, terrain as permanent walls, tier requires BOTH age
// and neighbour density, demolition on terrain edit, the board survives a
// restart) and asserts it against the mechanism rather than a call site.
// Mirrors flora/test/flora.test.ts's shape.

import { beforeEach, describe, expect, it } from 'vitest';
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
import { hasClearFootprint, isBuildableCell, isFlatEnough, type StructuresWorld } from '../server/suitability.ts';
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

/** A big open, flat, dry, fully-unlocked test board — no walls anywhere near the patterns under test. */
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

// ─────────────────────────────────────────────────────────────────────────────

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
    expect(isBuildableCell(world, PLATEAU_MIN + 1, 79)).toBe(true);
  });

  it('refuses cells outside the world and inside locked chunks', () => {
    const isLocked = (_cx: number, cy: number): boolean => cy === 1;
    const world = view(worldWithTerrain(160, plateauHeight, isLocked));
    expect(isBuildableCell(world, 79, 20)).toBe(false); // dry & flat, but locked
    expect(isBuildableCell(world, 79, 79)).toBe(true);
    expect(isBuildableCell(world, -1, 79)).toBe(false);
    expect(isBuildableCell(world, 160, 79)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FOOTPRINT-FIT (owner directive 2026-08-20): the model can touch, but never
// cross, its own cell's true edge on every side including the diagonals (see
// hasClearFootprint's own doc comment for the full derivation from
// client/models.ts's STRUCTURE_FOOTPRINT_RADIUS). These tests build worlds
// where the four ORTHOGONAL neighbours all pass isFlatEnough on their own —
// proving the diagonal case is genuinely unreachable through the older,
// orthogonal-only check — and differ only in ONE diagonal neighbour.

describe('footprint fit (the model cannot overhang a terrace edge or the waterline)', () => {
  const CENTER_BAND = 4;
  const FOOTPRINT_WORLD_SIZE = 32; // a multiple of CHUNK_SIZE (16), as worldWithTerrain requires
  const CX = 20;
  const CY = 20;

  /** Every Moore offset except the one under test, all on CENTER_BAND. */
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
    // The older, orthogonal-only check would have let this stand — proving
    // the diagonal gap isFlatEnough itself cannot close.
    expect(isFlatEnough(world, CX, CY)).toBe(true);
    expect(hasClearFootprint(world, CX, CY)).toBe(false);
    expect(isBuildableCell(world, CX, CY)).toBe(false);
  });

  it('overhangs-water: rejected when a DIAGONAL neighbour is water at the SAME band as the (dry) centre — the reported shoreline defect', () => {
    // Band 0 straddles the waterline: height 0 is water, heights 1..BAND_HEIGHT-1
    // are dry, and both quantise to band 0. bandOf alone cannot tell them apart.
    // Derived from BAND_HEIGHT, not hard-coded, so this stays correct however
    // that constant is tuned.
    const SHORE_BAND = 0;
    const DRY_SHORE_HEIGHT = Math.floor(BAND_HEIGHT / 2); // dry, band 0
    const world = worldWithTerrain(FOOTPRINT_WORLD_SIZE, (x, y) => {
      if (x === CX + 1 && y === CY + 1) return SEA_LEVEL; // water, ALSO band 0
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
    expect(bandOf(DRY_SHORE_HEIGHT)).toBe(SHORE_BAND); // same band as the water neighbour — the trap
    // Orthogonal neighbours are all dry, same band: isFlatEnough sees no problem.
    expect(isFlatEnough(view, CX, CY)).toBe(true);
    expect(hasClearFootprint(view, CX, CY)).toBe(false);
    expect(isBuildableCell(view, CX, CY)).toBe(false);
  });

  it('tier-growth: a footprint that fits at birth is re-validated every generation for free, so no separate check is needed as a structure advances tiers', () => {
    // Every tier shares STRUCTURE_FOOTPRINT_RADIUS (client/models.ts) — the
    // ground a structure needs never changes as it upgrades, only its
    // silhouette does (tiers.ts's maybeAdvanceTier touches tier alone). What
    // DOES need proving is that the CA's own wall test (isBuildableCell)
    // keeps applying hasClearFootprint on every generation regardless of
    // tier: a structure that grows for a while on good ground, then loses
    // its footprint fit to a neighbour's edit, dies instead of continuing to
    // grow — with no tier-specific code path involved at all.
    const good = worldWithTerrain(FOOTPRINT_WORLD_SIZE, () => CENTER_BAND * BAND_HEIGHT);
    const goodView: StructuresWorld = {
      worldSize: good.size,
      chunksPerEdge: good.chunksPerEdge,
      heightAt: (x, y) => good.heightAt(x, y),
      isChunkUnlocked: (cx, cy) => good.isChunkUnlocked(cx, cy),
      isCellUnlocked: (x, y) => good.isCellUnlocked(x, y),
    };
    // A 2x2 block: a stable still life whose every cell keeps exactly 3 live
    // Moore neighbours forever (tiers.ts), so it advances a tier every
    // eligible generation — the fastest-growing shape available.
    let board = boardOf([[CX, CY], [CX + 1, CY], [CX, CY + 1], [CX + 1, CY + 1]]);
    for (let i = 0; i < CA_GENERATIONS_PER_TIER; i++) board = stepGeneration(goodView, board).nextLive;
    const grown = board.get(structureKey(CX, CY));
    expect(grown).toBeDefined();
    expect(grown!.tier).toBeGreaterThan(0); // regression: ordinary growth on good ground is unaffected

    // Now a diagonal neighbour becomes water — the block's own cell and its
    // orthogonal neighbours never move, so isFlatEnough alone would still
    // pass every one of them; only hasClearFootprint's Moore-8 check notices.
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
    expect(isFlatEnough(spoiledView, CX, CY)).toBe(true); // the orthogonal-only view still sees nothing wrong
    const outcome = stepGeneration(spoiledView, board);
    expect(outcome.nextLive.has(structureKey(CX, CY))).toBe(false); // dropped by the wall test, tier notwithstanding
    expect(outcome.died).toContainEqual({ x: CX, y: CY });
  });
});

describe('B3/S23 correctness on open ground', () => {
  it('a block (still life) never changes', () => {
    const world = openWorld();
    let live = boardOf([[10, 10], [11, 10], [10, 11], [11, 11]]);
    const before = keysOf(live);

    for (let gen = 0; gen < 5; gen++) {
      const outcome = stepGeneration(world, live);
      expect(outcome.born).toHaveLength(0);
      expect(outcome.died).toHaveLength(0);
      live = outcome.nextLive;
    }
    expect(keysOf(live)).toEqual(before);
  });

  it('a blinker oscillates with period 2', () => {
    const world = openWorld();
    const horizontal = boardOf([[9, 10], [10, 10], [11, 10]]);
    const vertical = boardOf([[10, 9], [10, 10], [10, 11]]);

    const step1 = stepGeneration(world, horizontal);
    expect(keysOf(step1.nextLive)).toEqual(keysOf(vertical));
    const step2 = stepGeneration(world, step1.nextLive);
    expect(keysOf(step2.nextLive)).toEqual(keysOf(horizontal));

    // The centre cell (10, 10) is alive in every phase and never re-born;
    // the two wing cells die and are reborn (fresh age) every half-period.
    // (Lexicographic string sort, not numeric — "10,11" sorts before "10,9".)
    expect(step1.born.map((c) => `${c.x},${c.y}`).sort()).toEqual(['10,11', '10,9']);
    expect(step1.died.map((c) => `${c.x},${c.y}`).sort()).toEqual(['11,10', '9,10']);
  });

  it('a glider translates diagonally by (1, 1) every 4 generations', () => {
    const world = openWorld();
    let live = boardOf([[11, 10], [12, 11], [10, 12], [11, 12], [12, 12]]);
    for (let step = 0; step < 4; step++) live = stepGeneration(world, live).nextLive;

    const translated = boardOf([[12, 11], [13, 12], [11, 13], [12, 13], [13, 13]]);
    expect(keysOf(live)).toEqual(keysOf(translated));
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
    // A 3×3 solid block: the centre cell has 8 live neighbours.
    const cells: Array<[number, number]> = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.push([20 + dx, 20 + dy]);
    const live = boardOf(cells);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false); // centre: 8 neighbours, dies
  });
});

describe('terrain as walls', () => {
  it('truncates a pattern at the water/steep edge — a wall cell is never born into', () => {
    // Land only for x < 32 on an otherwise all-water board; a glider aimed
    // across the boundary loses the cells that would have crossed it.
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

    // A block straddling the boundary: land is x < 32, so (30, y) is land
    // with both its x-neighbours also on land (flat, buildable), while
    // (31, y) is land whose neighbour at x = 32 is water — not flat, and
    // therefore a WALL despite being dry ground itself.
    const live = boardOf([[30, 10], [31, 10], [30, 11], [31, 11]]);
    const outcome = stepGeneration(world, live);

    // The two wall cells can never be alive, whatever their neighbour count.
    expect(outcome.nextLive.has(structureKey(31, 10))).toBe(false);
    expect(outcome.nextLive.has(structureKey(31, 11))).toBe(false);
    // Nothing at or beyond the water line is ever born.
    for (const key of outcome.nextLive.keys()) {
      expect(cellOfKey(key).x).toBeLessThan(31);
    }
    // The two buildable cells (30, y) each still had 3 live Moore neighbours
    // in the ORIGINAL board (the other three block cells, walls included —
    // a wall still counts as a live neighbour if it WAS alive at the start
    // of this step; only whether IT can end up alive is gated), so both
    // survive under the ordinary S23 rule.
    expect(outcome.nextLive.has(structureKey(30, 10))).toBe(true);
    expect(outcome.nextLive.has(structureKey(30, 11))).toBe(true);
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
    // Three cells that would birth a 4th at (10, 15) — inside the locked row
    // (y in [0, 15]) — via B3, on otherwise-open ground.
    const live = boardOf([[9, 15], [10, 15 - 1], [11, 15]]); // arranged so (10,15) would get 3 neighbours
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

  it('a dense still-life core (block) ages into higher tiers than an equally old, sparser oscillator', () => {
    const world = openWorld();
    // Far enough apart that neither pattern's neighbourhood ever sees the
    // other.
    let live = boardOf([
      [10, 10], [11, 10], [10, 11], [11, 11], // block
      [40, 10], [41, 10], [42, 10], // blinker
    ]);

    const generations = CA_GENERATIONS_PER_TIER * 2 + 1; // enough for 2 upgrade windows
    for (let gen = 0; gen < generations; gen++) live = stepGeneration(world, live).nextLive;

    // Every block cell has exactly 3 neighbours every generation (the other
    // three cells of the block) and therefore keeps qualifying for the
    // neighbour gate every window.
    for (const [x, y] of [[10, 10], [11, 10], [10, 11], [11, 11]] as const) {
      const record = live.get(structureKey(x, y));
      expect(record).toBeDefined();
      expect(record!.tier).toBeGreaterThan(0);
    }

    // The blinker's CENTRE cell survives every generation but always has
    // exactly 2 neighbours — never enough to clear
    // STRUCTURE_UPGRADE_MIN_NEIGHBORS (3) — so it stays at tier 0 forever.
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
    // Occupy the whole board's first quadrant, forcing every fixed pattern's
    // most likely anchors to collide — a deterministic seed over many
    // attempts should still either avoid it or (bounded) fail cleanly.
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

  /**
   * A flat, dry world where unlocking is per-chunk and hand-picked — the
   * shape a real world has (a small unlocked island in a mostly-locked map),
   * which the open-world fixture above deliberately does not model.
   */
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
    // One unlocked chunk in a 4x4-chunk world. The pre-2026-08-19 whole-world
    // draw missed it on most rolls; drawing from the unlocked list must place
    // a seed on (nearly) every roll, and every placed cell must be unlocked.
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
    // Two unlocked chunks; one already holds a live block. Every successful
    // seed must land in the empty one while it exists.
    const world = partiallyUnlockedWorld([[0, 0], [3, 3]]);
    const live = boardOf([[2, 2], [3, 2], [2, 3], [3, 3]]); // block in chunk (0,0)
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
    const live = boardOf([[20, 20], [21, 20], [20, 21], [21, 21]]); // block inside the one unlocked chunk
    const rng = createStructuresRng(3);
    const placed = attemptSeed(world, live, rng);
    // Placement may or may not succeed per roll (the block is in the way),
    // but when it does it must be in the only unlocked chunk and never on top
    // of the block.
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
    // Fill to within 2 of the cap: every pattern in the library (and any
    // soup, whose centre cell plus at least... its centre alone) has >= 3
    // cells except the block (4) — nothing fits in 2, so seeding must refuse.
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
    // Clean ground: places all cells at tier 0.
    const placed = placePatternAt(world, new Map(), 10, 10, block);
    expect(placed).not.toBeNull();
    expect(placed!.length).toBe(block.length);
    // Any overlap with a live cell rejects the whole pattern.
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
    // Fill to within 2 of the cap with a single solid rectangle, so plenty of
    // live cells sit on its edge with dead, buildable ground just outside —
    // real spark candidates — while the cap still binds to at most 2.
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

// ─────────────────────────────────────────────────────────────────────────────
// The following run through the REAL plugin host, so the CA's own cadence
// (CA_GENERATION_INTERVAL_SECONDS) and the reactive demolition path are
// exercised exactly as the server runs them.

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

function join(harness: Harness): void {
  harness.world.addPlayer(PLAYER);
  // Fog of war (issue #18): grant PLAYER's own token every chunk this
  // world's union mask already has unlocked, BEFORE playerJoined fires the
  // plugin's onPlayerJoin — the same order the real join path seeds a
  // token's starter square in. Every existing "the joining player gets the
  // whole board" assertion below assumes this player can see everything
  // boot() unlocked, exactly as it did before per-player masks existed.
  grantTokenEveryUnlockedChunk(harness.world, PLAYER.token);
  harness.host.playerJoined(PLAYER);
}

function advance(harness: Harness, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) harness.host.tick(DT);
}

describe('the CA through the real host', () => {
  it('an empty world eventually seeds something, on its own cadence', () => {
    const harness = boot();
    // Comfortably many generations at 15 s each; deterministic given the
    // fixed default RNG seed.
    advance(harness, 15 * 40);
    expect(standingStructures().length).toBeGreaterThan(0);
    expect(currentGeneration()).toBeGreaterThan(0);
  });

  it(
    'every standing structure is on buildable ground and a valid tier',
    () => {
      const harness = boot();
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
    // Explicit timeout, not the vitest default 5000ms. This test's own cost
    // (900 simulated seconds — 60 generations, the longest advance() in this
    // file — over a full 160x160 board's worth of scanChunk calls) already
    // sat close to the default under load, and isBuildableCell's footprint
    // check (suitability.ts's hasClearFootprint, added 2026-08-20) surveys
    // eight neighbours instead of isFlatEnough's four for every candidate
    // cell, every generation. Real synchronous CPU work, not a hung promise —
    // widening the budget is correct here, not papering over a hang.
    20_000,
  );
});

describe('demolition', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
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
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FOG OF WAR (issue #18): the migrated-plugin proof. Two players get
  // different subsets of the SAME board through the real broadcastVisible
  // path, and a chunk with buildings already in it reaches a player who just
  // earned it without waiting out the keepalive.
  // ──────────────────────────────────────────────────────────────────────────
  it('sends each connected player only the structures inside their own unlocked view', () => {
    const harness = boot();
    join(harness);
    advance(harness, 15 * 40);
    expect(standingStructures().length).toBeGreaterThan(0);

    // A second connection whose token has never unlocked anything of its own.
    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider);

    harness.sink.clear();
    // The join snapshot already proves PLAYER's own full view (the test
    // above); this proves the SAME broadcast call gives a second player,
    // with no unlocked territory of their own, none of it.
    const forOutsider = harness.sink.ofType(ALL_WIRE_TYPE).filter((m) => m.target === outsider.id);
    expect(forOutsider).toHaveLength(0);
  });

  it('pushes a targeted refresh when a player creeps into a chunk that already has a structure', () => {
    const harness = boot();
    advance(harness, 15 * 40);
    const victim = standingStructures()[0];
    expect(victim).toBeDefined();
    const cx = Math.floor(victim!.x / CHUNK_SIZE);
    const cy = Math.floor(victim!.y / CHUNK_SIZE);

    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider); // nothing to send yet — empty mask
    harness.sink.clear();

    // No reveal plugin is installed in this harness, so drive the same two
    // steps WorldApi.unlockChunkForToken performs for any real caller: the
    // World mutation, then the plugin fan-out it triggers.
    expect(harness.world.unlockChunkForToken(outsider.token, cx, cy)).toBe(true);
    harness.host.notifyChunkUnlockedForToken(outsider.token, cx, cy);

    const changes = harness.sink
      .ofType(CHANGES_WIRE_TYPE)
      .filter((m) => m.target === outsider.id);
    expect(changes).toHaveLength(1);
    const founded =
      parseStructureCells((changes[0].payload as { founded: number[] }).founded) ?? [];
    expect(founded).toContainEqual({ x: victim!.x, y: victim!.y, tier: victim!.tier });
  });
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
  });

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
        { x: 7, y: 8, age: 10, tier: 99 }, // out-of-range tier
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

    const slice = saveStructures(live, 9, rng);
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

    // Restore onto an all-water world: onWorldCreate's footprint-fit prune
    // (server/index.ts) filters every restored cell through isBuildableCell
    // BEFORE it ever becomes live, so the board is empty the instant the
    // world loads — nothing here can pass (isWater rejects every cell
    // outright) — not merely after the next generation happens to step.
    const drowned = bootOn(worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT), slice);
    expect(standingStructures()).toHaveLength(0); // pruned on load, before any generation ran

    advance(drowned, 15 + DT); // one generation — nothing left to step, stays empty
    expect(standingStructures()).toHaveLength(0);
  });

  it('a structure restored onto ground that still fits survives load untouched', () => {
    const first = boot();
    advance(first, 15 * 40);
    const before = standingStructures();
    expect(before.length).toBeGreaterThan(0);
    const slice = first.host.collectPersistence()[STRUCTURES_PLUGIN_NAME];

    // Restore onto the SAME terrain the structures were founded on: every
    // one of them still fits, so the load-time prune (server/index.ts's
    // onWorldCreate) must keep the board exactly as it was persisted, not
    // merely "some structures".
    bootOn(worldWithTerrain(WORLD_SIZE, flatOpenTerrain), slice);
    expect(standingStructures().length).toBe(before.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('route blessings (pilgrim routes contract)', () => {
  // The blinker's centre cell is the canonical under-neighboured survivor:
  // it lives forever with EXACTLY 2 neighbours (see tiers.ts), so without a
  // blessing it can never advance a tier — which makes it the sharpest probe
  // for "blessing waives the neighbour gate and changes nothing else".
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
    // Age met, neighbour gate waived: exactly one step up, not a jump.
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
    // A lone pair dies of underpopulation next generation, blessed or not.
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
    // Direct contract probe, no board: age below threshold stays put even
    // blessed; age met with 0 neighbours advances only when blessed.
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER - 1, 0, 0, true)).toBe(0);
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER, 0, 0, true)).toBe(1);
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER, 0, 0, false)).toBe(0);
    expect(maybeAdvanceTier(CA_GENERATIONS_PER_TIER, 0, STRUCTURE_UPGRADE_MIN_NEIGHBORS, false)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// World events — the emission half of the chronicle contract (2026-08-19).
// The chronicle's own suite tests consumption against synthetic events; these
// pin that THIS plugin actually emits them, with the agreed shape and cause.
// ─────────────────────────────────────────────────────────────────────────────

describe('world events (structures:changes)', () => {
  interface HeardEvent {
    readonly event: string;
    readonly payload: unknown;
  }

  /** Boots structures PLUS a recording consumer in one real host. */
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
      [STRUCTURES_PLUGIN_NAME]: saveStructures(boardOf(board), 0, rng),
    });
    host.worldCreate();
    return { world, host, events };
  }

  it('a generation emits cause "generation" carrying the CA’s own deaths', () => {
    // A blinker: (30,30)-(32,30) flips to vertical, so exactly (30,30) and
    // (32,30) die in generation one, whatever else the seed rolls do.
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
    // A 2×2 block: a still life, so no generation event competes.
    const { world, host, events } = bootWithRecorder([
      [40, 40],
      [41, 40],
      [40, 41],
      [41, 41],
    ]);
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);

    // A sculpt that touches no structure emits no event at all.
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

// ─────────────────────────────────────────────────────────────────────────────
// Card 28, "Terrace Farming". Two halves: the farmland predicate itself
// (farmland.ts), and its one consumer — the CA's relaxed birth rule
// (life.ts's scanChunk). A shared worked example ((10,10)'s cluster, (20,20)'s,
// (30,30)'s, (40,40)'s and (50,50)'s below) is DUPLICATED, by design, in
// flora/test/flora.test.ts's own farmland describe block — see
// structures/server/farmland.ts's header on why the two copies are pinned to
// agree by testing the same facts rather than by sharing code.
// ─────────────────────────────────────────────────────────────────────────────

describe('farmland predicate (card 28)', () => {
  const FARMLAND_BAND = 2;
  /** Deep background "open sea" — far enough below FARMLAND_BAND that it is never mistaken for a same-band neighbour. */
  const DEEP = SEA_LEVEL - 10 * BAND_HEIGHT;

  /**
   * A background of flat, dry FARMLAND_BAND land, with five independent,
   * widely-spaced clusters carved into it exercising one fact each. Widely
   * spaced (10 cells apart) so no cluster's carve is ever a neighbour of
   * another's cells.
   */
  function farmlandTerrain(x: number, y: number): number {
    // Cluster A (10,10): a textbook terrace — flat among its dry neighbours,
    // edged by ordinary deep water to its east. FARMLAND.
    if (x === 11 && y === 10) return DEEP;

    // Cluster B (20,20): flat, fully landlocked — no water neighbour anywhere.
    // NOT farmland (fails "adjacent to water").
    // (no carve needed; pure background suffices)

    // Cluster C (30,30): "sloped" — its west neighbour is DRY but on a
    // DIFFERENT band, and it also touches water (north). NOT farmland
    // (fails flatness among its dry neighbours), even though it does touch
    // water — proving the two conditions are independently enforced.
    if (x === 29 && y === 30) return (FARMLAND_BAND + 1) * BAND_HEIGHT;
    if (x === 30 && y === 29) return DEEP;

    // Cluster D (40,40): the sea-level boundary case. The cell itself sits
    // at height 5 (band 0, dry); its east neighbour sits at height exactly
    // SEA_LEVEL (0) — water by isWater, but band 0 same as the cell's own.
    // FARMLAND: the water branch must fire (touchesWater=true) before any
    // band-equality reasoning would (wrongly) treat this as "flat", which
    // would accidentally pass for the wrong reason if the water check were
    // ever removed or reordered.
    if (x === 40 && y === 40) return 5;
    if (x === 39 && y === 40) return 10;
    if (x === 41 && y === 40) return SEA_LEVEL;
    if (x === 40 && y === 39) return 20;
    if (x === 40 && y === 41) return 15;

    // Cluster E (50,50): the cell itself IS water (height exactly SEA_LEVEL),
    // surrounded by dry band-0 land on all four sides. NOT farmland — dry
    // land grows crops, water does not, whatever the neighbourhood says.
    if (x === 50 && y === 50) return SEA_LEVEL;
    if (x === 49 && y === 50) return 5;
    if (x === 51 && y === 50) return 5;
    if (x === 50 && y === 49) return 5;
    if (x === 50 && y === 51) return 5;

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
    // This is the load-bearing claim in farmland.ts's header: reusing
    // isFlatEnough here would make farmland vacuous. (10, 10) is farmland,
    // but it can never itself hold a BUILDING, because its water neighbour
    // sits on a different band.
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
    // (0, 0)'s north/west neighbours are off-map.
    expect(isFarmlandCell(world, 0, 0)).toBe(false);
  });

  it('requires the cell itself to be unlocked (never leaks a verdict about locked ground)', () => {
    const isLocked = (cx: number, cy: number): boolean => cx === 0 && cy === 0; // covers (10,10)'s chunk
    const world = farmlandWorld(isLocked);
    expect(isFarmlandCell(world, 10, 10)).toBe(false);
  });

  it('hasNearbyFarmland is true for farmland itself and for its Moore neighbours, false beyond them', () => {
    const world = farmlandWorld();
    expect(hasNearbyFarmland(world, 10, 10)).toBe(true); // the farmland cell itself
    expect(hasNearbyFarmland(world, 9, 9)).toBe(true); // Moore-adjacent to it
    expect(hasNearbyFarmland(world, 8, 8)).toBe(false); // two cells away — outside the Moore neighbourhood
    expect(hasNearbyFarmland(world, 20, 20)).toBe(false); // landlocked cluster: never farmland, never near it
  });
});

describe('birth rate near fed towns (card 28) — bounded to exactly one extra neighbour class', () => {
  const FARMLAND_BAND = 2;
  const DEEP = SEA_LEVEL - 10 * BAND_HEIGHT;
  const WORLD_SIZE = 64;

  /**
   * All background FARMLAND_BAND land, with ONE water cell at (22, 21) —
   * chosen so it is a neighbour of (21, 21) but NOT of (20, 20), the birth
   * candidate every test below uses. That keeps the candidate itself
   * comfortably BUILDABLE (all four of ITS OWN orthogonal neighbours stay
   * on FARMLAND_BAND) while (21, 21) — the candidate's Moore (diagonal)
   * neighbour — becomes farmland. This is the realistic shape the card
   * describes: a farm plot beside a founding settlement, not a building
   * standing in the farm itself (which the CA's own wall test already
   * forbids — see the previous describe block's "deliberate divergence"
   * test).
   */
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

  it('sets up the fixture correctly: the candidate is buildable and its Moore neighbour is farmland, only when carved', () => {
    const with_ = boostWorld(true);
    expect(isBuildableCell(with_, 20, 20)).toBe(true);
    expect(isFarmlandCell(with_, 21, 21)).toBe(true);
    expect(hasNearbyFarmland(with_, 20, 20)).toBe(true);

    const without = boostWorld(false);
    expect(isBuildableCell(without, 20, 20)).toBe(true);
    expect(isFarmlandCell(without, 21, 21)).toBe(false);
    expect(hasNearbyFarmland(without, 20, 20)).toBe(false);
  });

  it('a dead cell with exactly 2 live neighbours is born when near farmland (the whole "birth rate rises" mechanic)', () => {
    const world = boostWorld(true);
    const live = boardOf([[19, 19], [19, 21]]); // both Moore-adjacent to (20,20); neighbourCount = 2
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(true);
    expect(outcome.born).toContainEqual({ x: 20, y: 20, tier: 0 });
  });

  it('the identical board with exactly 2 live neighbours does NOT birth without farmland nearby — the boost, isolated', () => {
    const world = boostWorld(false);
    const live = boardOf([[19, 19], [19, 21]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
  });

  it('CEILING: farmland never admits a birth at 1 live neighbour', () => {
    const world = boostWorld(true);
    const live = boardOf([[19, 19]]); // neighbourCount = 1
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
  });

  it('CEILING: farmland never admits a birth at 4 live neighbours (nor does ordinary B3/S23)', () => {
    const world = boostWorld(true);
    const live = boardOf([[19, 19], [19, 20], [19, 21], [20, 19]]); // neighbourCount = 4
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(20, 20))).toBe(false);
  });

  it('ordinary B3 birth (3 neighbours) is unaffected by farmland — same outcome with or without it', () => {
    const live = boardOf([[19, 19], [19, 21], [21, 19]]); // neighbourCount = 3, none of which is (21,21)
    const withFarmland = stepGeneration(boostWorld(true), live);
    const without = stepGeneration(boostWorld(false), live);
    expect(withFarmland.nextLive.has(structureKey(20, 20))).toBe(true);
    expect(without.nextLive.has(structureKey(20, 20))).toBe(true);
  });

  it('REGRESSION: an entirely unfarmed world (openWorld — no water anywhere) grows exactly as it always did', () => {
    // openWorld() is used, unmodified, by every pre-existing B3/S23 test in
    // this file (the "B3/S23 correctness on open ground" describe block
    // above) — those 5 tests already re-ran unchanged against this same
    // code path and passed, which is the regression proof in the large.
    // This test adds the direct, targeted claim: farmland can never be
    // found on that world, so the boost provably never fires there.
    const world = openWorld();
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) {
        expect(hasNearbyFarmland(world, x, y)).toBe(false);
      }
    }
    // And the concrete case the boost exists for: a dead cell with exactly
    // 2 live neighbours, which the boost WOULD birth if any farmland were
    // reachable, stays dead — identical to pre-card-28 behaviour.
    const live = boardOf([[9, 9], [9, 11]]);
    const outcome = stepGeneration(world, live);
    expect(outcome.nextLive.has(structureKey(10, 10))).toBe(false);
  });
});
