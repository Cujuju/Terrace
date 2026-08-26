// The Populous growth model, asserted against its rules rather than its call
// sites: tier is a function of the flat ground around a house, population
// fills to that tier's capacity and then emits exactly one settler, a house
// whose own ground stops being buildable is removed, and two runs over the
// same inputs produce byte-identical outcomes.
//
// `stepPopulous` is pure — it REPORTS the settlers it wants emitted rather
// than emitting them (server/index.ts does that, across the pilgrims bridge)
// — which is what lets every rule below be tested with no world, no plugin
// host and no sibling plugin present.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  POPULOUS_CAPACITY_BY_TIER,
  POPULOUS_GROWTH_PER_STEP,
  POPULOUS_MAX_TIER_FALLBACK,
  POPULOUS_POPULATION_AFTER_EMIT,
  POPULOUS_TIER_BY_FLAT_NEIGHBORS,
  populousTierFor,
  stepPopulous,
  type PopulousCellRecord,
  type PopulousContext,
  type PopulousWorld,
} from '../server/model.ts';
import { growthModelForTest, isPopulousSelected } from '../server/index.ts';
import {
  loadStructuresBridge,
  registerGrowthModel,
  resetStructuresBridge,
  setStructuresModuleLoader,
  structuresBridgeReady,
} from '../server/structures-bridge.ts';
import {
  loadPilgrimsBridge,
  resetPilgrimsBridge,
  setPilgrimsModuleLoader,
} from '../server/pilgrims-bridge.ts';

const WORLD_SIZE = 64;
const MAX_TIER = 5;
const KEY_STRIDE = 65536;

function key(x: number, y: number): number {
  return y * KEY_STRIDE + x;
}

const world: PopulousWorld = { worldSize: WORLD_SIZE };

/** Everything in-bounds is buildable unless it is in `blocked`. */
function contextExcept(blocked: ReadonlyArray<readonly [number, number]>): PopulousContext {
  const denied = new Set(blocked.map(([x, y]) => key(x, y)));
  return {
    maxTier: MAX_TIER,
    isBuildable(x: number, y: number): boolean {
      if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return false;
      return !denied.has(key(x, y));
    },
  };
}

function boardOf(
  cells: ReadonlyArray<readonly [number, number]>,
  record: PopulousCellRecord = { age: 0, tier: 0, population: 0 },
): Map<number, PopulousCellRecord> {
  const live = new Map<number, PopulousCellRecord>();
  for (const [x, y] of cells) live.set(key(x, y), record);
  return live;
}

describe('the tier table', () => {
  it('covers every possible Moore-neighbour count, 0 through 8', () => {
    expect(POPULOUS_TIER_BY_FLAT_NEIGHBORS.length).toBe(9);
  });

  it('never decreases as the ground around a house opens up', () => {
    for (let i = 1; i < POPULOUS_TIER_BY_FLAT_NEIGHBORS.length; i++) {
      expect(POPULOUS_TIER_BY_FLAT_NEIGHBORS[i]).toBeGreaterThanOrEqual(
        POPULOUS_TIER_BY_FLAT_NEIGHBORS[i - 1],
      );
    }
  });

  it('is clamped to the board owner’s tier ceiling', () => {
    // A structures build with fewer tiers than this table assumes must never
    // be handed a tier it cannot render.
    for (let count = 0; count <= 8; count++) {
      expect(populousTierFor(count, 2)).toBeLessThanOrEqual(2);
      expect(populousTierFor(count, MAX_TIER)).toBeLessThanOrEqual(MAX_TIER);
      expect(populousTierFor(count, MAX_TIER)).toBeGreaterThanOrEqual(0);
    }
  });

  it('has a capacity for every tier the ceiling can reach', () => {
    expect(POPULOUS_CAPACITY_BY_TIER.length).toBe(POPULOUS_MAX_TIER_FALLBACK + 1);
    for (const capacity of POPULOUS_CAPACITY_BY_TIER) expect(capacity).toBeGreaterThan(0);
  });
});

describe('tier follows the flat, buildable ground around a house', () => {
  it('gives a house with all eight neighbours buildable the top tier', () => {
    const live = boardOf([[10, 10]]);
    const { result } = stepPopulous(world, live, contextExcept([]));
    expect(result.nextLive.get(key(10, 10))!.tier).toBe(populousTierFor(8, MAX_TIER));
  });

  it('gives a house on a spit of land a low tier', () => {
    // Only (11, 10) is buildable beside it: one flat Moore neighbour.
    const blocked: Array<readonly [number, number]> = [];
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]]) {
      blocked.push([10 + dx, 10 + dy]);
    }
    const live = boardOf([[10, 10]]);
    const { result } = stepPopulous(world, live, contextExcept(blocked));
    expect(result.nextLive.get(key(10, 10))!.tier).toBe(populousTierFor(1, MAX_TIER));
  });

  it('DOWN-tiers a house when the ground around it closes up', () => {
    const live = boardOf([[10, 10]], { age: 9, tier: MAX_TIER, population: 0 });
    const blocked: Array<readonly [number, number]> = [
      [9, 9], [10, 9], [11, 9], [9, 10], [11, 10], [9, 11],
    ];
    const { result } = stepPopulous(world, live, contextExcept(blocked));
    const after = result.nextLive.get(key(10, 10))!;
    expect(after.tier).toBe(populousTierFor(2, MAX_TIER));
    expect(after.tier).toBeLessThan(MAX_TIER);
    // A tier change of either direction travels on the same list — the wire
    // carries the new tier, not a direction.
    expect(result.upgraded).toEqual([{ x: 10, y: 10, tier: after.tier }]);
  });

  it('never births a house from neighbour count alone', () => {
    const live = boardOf([[10, 10], [11, 10], [10, 11]]);
    const { result } = stepPopulous(world, live, contextExcept([]));
    expect(result.born).toEqual([]);
    expect(result.nextLive.size).toBe(3);
  });
});

describe('population', () => {
  it('grows by a fixed amount per step until the tier capacity is reached', () => {
    let live = boardOf([[10, 10]]);
    const ctx = contextExcept([]);
    const tier = populousTierFor(8, MAX_TIER);
    const capacity = POPULOUS_CAPACITY_BY_TIER[tier];

    for (let step = 1; step < capacity; step++) {
      const { result, emitted } = stepPopulous(world, live, ctx);
      live = result.nextLive;
      expect(emitted).toEqual([]);
      expect(live.get(key(10, 10))!.population).toBe(step * POPULOUS_GROWTH_PER_STEP);
    }
  });

  it('emits exactly one settler when it fills, and resets', () => {
    let live = boardOf([[10, 10]]);
    const ctx = contextExcept([]);
    const tier = populousTierFor(8, MAX_TIER);
    const capacity = POPULOUS_CAPACITY_BY_TIER[tier];
    const stepsToFill = Math.ceil(capacity / POPULOUS_GROWTH_PER_STEP);

    let emissions = 0;
    for (let step = 0; step < stepsToFill; step++) {
      const outcome = stepPopulous(world, live, ctx);
      live = outcome.result.nextLive;
      emissions += outcome.emitted.length;
      if (outcome.emitted.length > 0) {
        expect(outcome.emitted).toEqual([{ x: 10, y: 10 }]);
      }
    }
    expect(emissions).toBe(1);
    expect(live.get(key(10, 10))!.population).toBe(POPULOUS_POPULATION_AFTER_EMIT);
  });

  it('a bigger house sends people out sooner than a smaller one', () => {
    // The whole point of the ladder: capacity falls as tier rises.
    for (let tier = 1; tier <= POPULOUS_MAX_TIER_FALLBACK; tier++) {
      expect(POPULOUS_CAPACITY_BY_TIER[tier]).toBeLessThanOrEqual(
        POPULOUS_CAPACITY_BY_TIER[tier - 1],
      );
    }
  });
});

describe('houses die only from the terrain', () => {
  it('removes a house whose own cell is no longer buildable', () => {
    const live = boardOf([[10, 10], [30, 30]]);
    const { result } = stepPopulous(world, live, contextExcept([[10, 10]]));
    expect(result.died).toEqual([{ x: 10, y: 10 }]);
    expect(result.nextLive.has(key(10, 10))).toBe(false);
    expect(result.nextLive.has(key(30, 30))).toBe(true);
  });

  it('leaves a lone house standing forever — there is no loneliness rule', () => {
    let live = boardOf([[10, 10]]);
    const ctx = contextExcept([]);
    for (let step = 0; step < 50; step++) live = stepPopulous(world, live, ctx).result.nextLive;
    expect(live.has(key(10, 10))).toBe(true);
  });

  it('a dead house emits nobody, even with a full population', () => {
    const capacity = POPULOUS_CAPACITY_BY_TIER[0];
    const live = boardOf([[10, 10]], { age: 0, tier: 0, population: capacity });
    const { result, emitted } = stepPopulous(world, live, contextExcept([[10, 10]]));
    expect(emitted).toEqual([]);
    expect(result.died).toEqual([{ x: 10, y: 10 }]);
  });
});

describe('determinism', () => {
  it('produces identical outcomes from identical inputs', () => {
    const cells: Array<readonly [number, number]> = [
      [10, 10], [11, 10], [10, 11], [40, 12], [41, 13], [5, 5], [63, 63], [0, 0],
    ];
    const ctx = contextExcept([[41, 13], [0, 0]]);

    const runOnce = (): string => {
      let live = boardOf(cells);
      const log: unknown[] = [];
      for (let step = 0; step < 12; step++) {
        const { result, emitted } = stepPopulous(world, live, ctx);
        live = result.nextLive;
        log.push({
          live: [...live.entries()].sort((a, b) => a[0] - b[0]),
          born: result.born,
          upgraded: result.upgraded,
          died: result.died,
          emitted,
        });
      }
      return JSON.stringify(log);
    };

    expect(runOnce()).toBe(runOnce());
  });

  it('iterates in a fixed order regardless of insertion order', () => {
    const forward: Array<readonly [number, number]> = [[1, 1], [2, 1], [3, 1]];
    const reversed = [...forward].reverse();
    const ctx = contextExcept([]);
    const a = stepPopulous(world, boardOf(forward), ctx).result;
    const b = stepPopulous(world, boardOf(reversed), ctx).result;
    expect(JSON.stringify(a.upgraded)).toBe(JSON.stringify(b.upgraded));
    expect([...a.nextLive.keys()]).toEqual([...b.nextLive.keys()]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The plugin wiring: what registers where, and what happens when the plugins
// it talks to are not there. Both bridges are driven through their loader test
// seams, so no sibling plugin is imported and the whole file still passes with
// structures and pilgrims deleted.
// ─────────────────────────────────────────────────────────────────────────────

describe('the plugin', () => {
  beforeEach(() => {
    resetStructuresBridge();
    resetPilgrimsBridge();
  });

  it('is inert unless this deployment selected it', () => {
    expect(isPopulousSelected({})).toBe(false);
    expect(isPopulousSelected({ STRUCTURES_MODEL: 'life' })).toBe(false);
    expect(isPopulousSelected({ STRUCTURES_MODEL: 'populous' })).toBe(true);
  });

  it('registers its model with structures, even when structures resolves late', async () => {
    const registered: unknown[] = [];
    setStructuresModuleLoader(async () => ({
      setGrowthModel: (m: unknown) => registered.push(m),
    }));

    // Registered BEFORE the bridge resolves — rule 3 of the bridge pattern.
    registerGrowthModel(growthModelForTest());
    expect(registered).toEqual([]);

    await loadStructuresBridge();
    await structuresBridgeReady();
    expect(registered).toEqual([growthModelForTest()]);
  });

  it('loads with structures absent rather than throwing', async () => {
    setStructuresModuleLoader(async () => ({}));
    registerGrowthModel(growthModelForTest());
    await loadStructuresBridge();
    await structuresBridgeReady(); // no throw is the assertion
  });

  it('sends a settler out of the house that filled, through pilgrims', async () => {
    const asked: Array<{ x: number; y: number }> = [];
    setPilgrimsModuleLoader(async () => ({
      emitSettlerFrom: (x: number, y: number) => {
        asked.push({ x, y });
        return true;
      },
    }));
    await loadPilgrimsBridge();

    const model = growthModelForTest();
    const ctx = contextExcept([]);
    const tier = populousTierFor(8, MAX_TIER);
    const capacity = POPULOUS_CAPACITY_BY_TIER[tier];
    // One step short of full, so this single step fills it and empties it.
    let live: ReadonlyMap<number, PopulousCellRecord> = boardOf([[10, 10]], {
      age: 0,
      tier,
      population: capacity - POPULOUS_GROWTH_PER_STEP,
    });
    live = model.step(world, live, ctx).nextLive;

    expect(asked).toEqual([{ x: 10, y: 10 }]);
    expect(live.get(key(10, 10))!.population).toBe(POPULOUS_POPULATION_AFTER_EMIT);
  });

  it('houses fill up and nobody walks out when pilgrims is absent', async () => {
    setPilgrimsModuleLoader(async () => ({}));
    await loadPilgrimsBridge();

    const model = growthModelForTest();
    const ctx = contextExcept([]);
    let live: ReadonlyMap<number, PopulousCellRecord> = boardOf([[10, 10]]);
    for (let step = 0; step < 30; step++) live = model.step(world, live, ctx).nextLive;
    // The board is untouched by the missing plugin — the house still stands.
    expect(live.has(key(10, 10))).toBe(true);
  });
});
