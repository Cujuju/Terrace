// THE GROWTH-MODEL SEAM — the contract that lets a second settlement-growth
// model drive this plugin's board without owning any of it.
//
// The subject is the SEAM, not either model: which code the interval runs
// under each STRUCTURES_MODEL setting, that a registered model's outcome
// reaches the wire and the persistence slice through the SAME path the CA's
// own outcome takes, and that population survives a restart (and its absence
// in an older slice reads as zero). The CA's own behaviour under the default
// setting is asserted by structures.test.ts, which this file deliberately
// does not duplicate.

import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
} from '../../../server/test/support/harness.ts';
import type { Player } from '../../../server/src/player.ts';
import {
  STRUCTURES_CHANGES_MESSAGE,
  STRUCTURES_PLUGIN_NAME,
  STRUCTURE_SEPARATION_CELLS,
  parseStructureCells,
  structureKey,
} from '../protocol.ts';
import {
  STRUCTURES_MODEL_ENV,
  STRUCTURES_MODEL_LIFE,
  STRUCTURES_MODEL_POPULOUS,
  growthModel,
  readStructuresModel,
  setGrowthModel,
  type BoardCellRecord,
  type GrowthContext,
  type GrowthModel,
  type GrowthStepResult,
} from '../server/growth-model.ts';
import { CA_GENERATION_INTERVAL_SECONDS } from '../server/life.ts';
import { loadStructures, saveStructures } from '../server/persistence.ts';
import { createStructuresRng } from '../server/rng.ts';
import {
  plugin as structuresPlugin,
  currentGeneration,
  currentLive,
  resetStructuresState,
  setStructuresModel,
  structuresModel,
} from '../server/index.ts';
import { worldWithTerrain } from './support/world.ts';

const WORLD_SIZE = 64;
const OPEN_BAND = 4;
const DT = 0.1;
const CHANGES_WIRE_TYPE = `${STRUCTURES_PLUGIN_NAME}:${STRUCTURES_CHANGES_MESSAGE}`;
const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

describe(`${STRUCTURES_MODEL_ENV} validation`, () => {
  it('is read from the environment ONCE, at module load, and never re-read', () => {
    // The old form of this test compared structuresModel() to
    // readStructuresModel(process.env) — the same pure function over the same
    // input the module itself had already applied, so it could only ever
    // agree. What the module actually promises is that the value is FIXED at
    // load: a world may not change settlement model under a running server
    // (index.ts's `selectedModel`), and that is what this asserts.
    const wired = structuresModel();
    const previous = process.env[STRUCTURES_MODEL_ENV];
    process.env[STRUCTURES_MODEL_ENV] = STRUCTURES_MODEL_POPULOUS;
    try {
      expect(structuresModel()).toBe(wired);
    } finally {
      if (previous === undefined) delete process.env[STRUCTURES_MODEL_ENV];
      else process.env[STRUCTURES_MODEL_ENV] = previous;
    }
    // And the suite runs with the variable unset, so the wired value is the
    // default — the setting under which every OTHER file's tests were written.
    expect(wired).toBe(STRUCTURES_MODEL_LIFE);
  });

  it('defaults to the Conway CA when unset or blank', () => {
    expect(readStructuresModel({})).toBe(STRUCTURES_MODEL_LIFE);
    expect(readStructuresModel({ [STRUCTURES_MODEL_ENV]: '  ' })).toBe(STRUCTURES_MODEL_LIFE);
  });

  it('accepts both shipped models', () => {
    expect(readStructuresModel({ [STRUCTURES_MODEL_ENV]: 'life' })).toBe(STRUCTURES_MODEL_LIFE);
    expect(readStructuresModel({ [STRUCTURES_MODEL_ENV]: 'populous' })).toBe(
      STRUCTURES_MODEL_POPULOUS,
    );
  });

  it('refuses an unknown value at boot rather than silently defaulting', () => {
    expect(() => readStructuresModel({ [STRUCTURES_MODEL_ENV]: 'conway' })).toThrow(
      /STRUCTURES_MODEL/,
    );
  });
});

describe('the growth-model registry', () => {
  beforeEach(() => {
    setGrowthModel(null);
  });

  it('holds at most one model, and hands back exactly what was registered', () => {
    expect(growthModel()).toBeNull();
    const model = stubModel();
    setGrowthModel(model);
    expect(growthModel()).toBe(model);
    setGrowthModel(null);
    expect(growthModel()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the REAL plugin host, so the interval, the wire and the persistence
// slice are exercised exactly as the server runs them.
// ─────────────────────────────────────────────────────────────────────────────

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function boot(restore?: unknown): Harness {
  resetStructuresState();
  const world = worldWithTerrain(WORLD_SIZE, () => OPEN_BAND * BAND_HEIGHT);
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(world, [structuresPlugin].map(asLoadedPlugin));
  if (restore !== undefined) host.restorePersistence({ [STRUCTURES_PLUGIN_NAME]: restore });
  host.worldCreate();
  world.addPlayer(PLAYER);
  grantTokenEveryUnlockedChunk(world, PLAYER.token);
  host.playerJoined(PLAYER);
  return { world, host, sink };
}

function advance(harness: Harness, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += DT) harness.host.tick(DT);
}

/** A model that records what it was handed and plants one house per step. */
function stubModel(): GrowthModel & {
  readonly calls: Array<{ live: number; buildableHere: boolean }>;
} {
  const calls: Array<{ live: number; buildableHere: boolean }> = [];
  return {
    name: 'stub',
    calls,
    step(_world, live, ctx: GrowthContext): GrowthStepResult {
      calls.push({ live: live.size, buildableHere: ctx.isBuildable(20, 20) });
      const nextLive = new Map<number, BoardCellRecord>(live);
      const born = [];
      const key = structureKey(20, 20);
      if (!nextLive.has(key)) {
        nextLive.set(key, { age: 0, tier: 1, population: 7 });
        born.push({ x: 20, y: 20, tier: 1 });
      }
      return { nextLive, born, upgraded: [], died: [], emitted: [] };
    },
  };
}

describe('STRUCTURES_MODEL=life (the default)', () => {
  beforeEach(() => {
    setGrowthModel(null);
    setStructuresModel(STRUCTURES_MODEL_LIFE);
  });

  it('never calls a registered growth model', () => {
    const model = stubModel();
    setGrowthModel(model);
    const harness = boot();
    advance(harness, CA_GENERATION_INTERVAL_SECONDS * 3);
    expect(model.calls).toEqual([]);
    expect(currentGeneration()).toBeGreaterThan(0); // the CA did run
  });
});

describe('STRUCTURES_MODEL=populous', () => {
  beforeEach(() => {
    setGrowthModel(null);
    setStructuresModel(STRUCTURES_MODEL_POPULOUS);
  });

  it('routes the generation interval to the registered model', () => {
    const model = stubModel();
    setGrowthModel(model);
    const harness = boot();
    advance(harness, CA_GENERATION_INTERVAL_SECONDS * 2.5);
    expect(model.calls.length).toBe(2);
    expect(model.calls[0].buildableHere).toBe(true);
    expect(currentGeneration()).toBe(2);
  });

  it('applies the model’s outcome to the board and the wire', () => {
    setGrowthModel(stubModel());
    const harness = boot();
    advance(harness, CA_GENERATION_INTERVAL_SECONDS * 1.5);

    expect(currentLive().get(structureKey(20, 20))).toEqual({ age: 0, tier: 1, population: 7 });

    const changes = harness.sink.ofType(CHANGES_WIRE_TYPE);
    expect(changes.length).toBeGreaterThan(0);
    const founded = parseStructureCells(
      (changes[changes.length - 1].payload as { founded: number[] }).founded,
    );
    expect(founded).toContainEqual({ x: 20, y: 20, tier: 1 });
  });

  /**
   * THE KEEP-CLEAR RULE REACHES EVERY MODEL, not just the CA that used to be
   * the only thing enforcing it (F2). The seam hands the predicate over; this
   * asserts the one the model receives really is clearance.ts's, answering
   * about STRUCTURE_SEPARATION_CELLS rather than about adjacency or nothing.
   */
  it('hands the model this plugin’s own keep-clear predicate', () => {
    let answered: { near: boolean; far: boolean } | null = null;
    setGrowthModel({
      name: 'clearance-probe',
      step(_world, live, ctx: GrowthContext): GrowthStepResult {
        const board = new Map<number, BoardCellRecord>([
          [structureKey(20, 20), { age: 0, tier: 1 }],
        ]);
        // The rule is RADIAL AND STRICT (protocol.ts, STRUCTURE_SEPARATION_
        // CELLS_SQUARED): at exactly the separation the discs are tangent, and
        // tangent is not overlapping — so the scan bound itself is the first
        // FREE cell, and one cell inside it is the last held one.
        answered = {
          near: ctx.hasBuildingWithinSeparation(board, 20 + STRUCTURE_SEPARATION_CELLS - 1, 20),
          far: ctx.hasBuildingWithinSeparation(board, 20 + STRUCTURE_SEPARATION_CELLS, 20),
        };
        return { nextLive: new Map(live), born: [], upgraded: [], died: [], emitted: [] };
      },
    });
    const harness = boot();
    advance(harness, CA_GENERATION_INTERVAL_SECONDS * 1.5);
    expect(answered).toEqual({ near: true, far: false });
  });

  /**
   * WHERE A MODEL'S SIDE EFFECTS HAPPEN (F4). A model that wants somebody sent
   * out of a house reports the cell and this plugin calls back AFTER the board
   * has been swapped in — so whatever the emission reaches (pilgrims, and
   * through it a settler who may found the next house) observes the generation
   * that just completed, never the one it replaced.
   */
  it('runs the post-swap hook against the swapped board', () => {
    const CELL = structureKey(21, 21);
    let observed: { onBoard: boolean; generation: number; emitted: number } | null = null;
    setGrowthModel({
      name: 'emitter',
      step(_world, live): GrowthStepResult {
        const nextLive = new Map<number, BoardCellRecord>(live);
        nextLive.set(CELL, { age: 0, tier: 2, population: 0 });
        return {
          nextLive,
          born: [{ x: 21, y: 21, tier: 2 }],
          upgraded: [],
          died: [],
          emitted: [{ x: 21, y: 21 }],
        };
      },
      afterSwap(emitted): void {
        observed = {
          onBoard: currentLive().has(CELL),
          generation: currentGeneration(),
          emitted: emitted.length,
        };
      },
    });
    const harness = boot();
    advance(harness, CA_GENERATION_INTERVAL_SECONDS * 1.5);
    expect(observed).toEqual({ onBoard: true, generation: 1, emitted: 1 });
  });

  it('does not seed or stir: under this model, houses come only from the model', () => {
    // WITH A MODEL REGISTERED, and one that plants nothing. The old form of
    // this test registered NO model at all, so the empty board it asserted was
    // just advanceGrowthModel's early return — it would have passed even if
    // this plugin seeded on every generation, because it never reached the
    // code that would have done so.
    //
    // The CA's own anti-starvation backstops (attemptSeed's Monday arrival,
    // attemptStir's spark) must not fire under a registered model: a model
    // with no birth-by-neighbour rule has neither failure mode, and sprinkling
    // unrequested houses into its board would be this plugin overruling the
    // model it was told to run.
    const inert: GrowthModel = {
      name: 'inert',
      step(_world, live): GrowthStepResult {
        return { nextLive: new Map(live), born: [], upgraded: [], died: [], emitted: [] };
      },
    };
    setGrowthModel(inert);
    const harness = boot();
    // Several generation intervals: under the CA path each of these ticks is
    // where seeding and stirring would be attempted. Under this path that code
    // is never reached at all, which is the property being asserted.
    advance(harness, CA_GENERATION_INTERVAL_SECONDS * 8);
    expect(currentGeneration()).toBeGreaterThan(0); // the model really did run
    expect(currentLive().size).toBe(0);
  });
});

describe('population persistence', () => {
  it('survives a restart', () => {
    const live = new Map<number, BoardCellRecord>([
      [structureKey(9, 9), { age: 2, tier: 3, population: 5 }],
    ]);
    const slice = saveStructures(live, 4, createStructuresRng(1), -1);
    const restored = loadStructures(slice);
    expect(restored.live.get(structureKey(9, 9))).toEqual({ age: 2, tier: 3, population: 5 });
  });

  it('reads a slice written before populations existed as zero', () => {
    const legacy = saveStructures(
      new Map<number, BoardCellRecord>([[structureKey(9, 9), { age: 2, tier: 3 }]]),
      4,
      createStructuresRng(1),
      -1,
    );
    const withoutPopulation = {
      ...legacy,
      live: legacy.live.map(({ x, y, age, tier }) => ({ x, y, age, tier })),
    };
    const restored = loadStructures(withoutPopulation);
    // ABSENT, not zeroed — and the seam's own reader turns that into zero.
    expect(restored.live.get(structureKey(9, 9))).toEqual({ age: 2, tier: 3 });
    expect(restored.live.get(structureKey(9, 9))!.population ?? 0).toBe(0);
  });
});
