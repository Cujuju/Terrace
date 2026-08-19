// The structures CA, driven both directly (life.ts's pure stepGeneration, for
// exact B3/S23 correctness) and through the REAL plugin host and intent
// pipeline (for demolition, persistence, and the broadcast model) — no stub
// for either. CONTRACT tests: each names a rule the plugin promises (correct
// B3/S23 on open ground, terrain as permanent walls, tier requires BOTH age
// and neighbour density, demolition on terrain edit, the board survives a
// restart) and asserts it against the mechanism rather than a call site.
// Mirrors flora/test/flora.test.ts's shape.

import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, MAX_BRUSH_RADIUS, SEA_LEVEL } from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin } from '../../../server/test/support/harness.ts';
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
  attemptSeed,
  stepGeneration,
  type LiveCellRecord,
} from '../server/life.ts';
import {
  CA_GENERATIONS_PER_TIER,
  STRUCTURE_UPGRADE_MIN_NEIGHBORS,
  maybeAdvanceTier,
} from '../server/tiers.ts';
import { isBuildableCell, isFlatEnough, type StructuresWorld } from '../server/suitability.ts';
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
const PLAYER: Player = { id: 'session-1', name: 'Tester' };
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

  it('every standing structure is on buildable ground and a valid tier', () => {
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
  });
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

  it('a structure restored onto ground it can no longer stand on dies at the very next generation', () => {
    const first = boot();
    advance(first, 15 * 40);
    const slice = first.host.collectPersistence()[STRUCTURES_PLUGIN_NAME];
    expect(standingStructures().length).toBeGreaterThan(0);

    // Restore onto an all-water world: nothing can survive a step.
    const drowned = bootOn(worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT), slice);
    expect(standingStructures().length).toBeGreaterThan(0); // restored, not yet stepped

    advance(drowned, 15 + DT); // one generation
    expect(standingStructures()).toHaveLength(0);
  });
});
