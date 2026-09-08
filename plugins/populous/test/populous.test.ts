import { beforeEach, describe, expect, it } from 'vitest';
import {
  POPULOUS_CAPACITY_BY_TIER,
  POPULOUS_GROWTH_PER_STEP,
  POPULOUS_POPULATION_AFTER_EMIT,
  POPULOUS_TIER_BY_FLAT_NEIGHBORS,
  POPULOUS_TIER_CLIMB_PER_STEP,
  populousTierFor,
  stepPopulous,
  type PopulousCellRecord,
  type PopulousContext,
  type PopulousWorld,
} from '../server/model.ts';
import { growthModelForTest, plugin as populousPlugin } from '../server/index.ts';
import {
  loadStructuresBridge,
  registerGrowthModel,
  resetStructuresBridge,
} from '../server/structures-bridge.ts';
import { loadPilgrimsBridge, resetPilgrimsBridge } from '../server/pilgrims-bridge.ts';
import { worldWithSibling } from '../../../server/test/support/harness.ts';

const WORLD_SIZE = 64;
const MAX_TIER = 5;
const KEY_STRIDE = 65536;

function key(x: number, y: number): number {
  return y * KEY_STRIDE + x;
}

const world: PopulousWorld = { worldSize: WORLD_SIZE };

const SEPARATION = 5;

function separationCheck(
  cells: ReadonlyMap<number, PopulousCellRecord>,
  x: number,
  y: number,
): boolean {
  for (let dy = -SEPARATION; dy <= SEPARATION; dy++) {
    for (let dx = -SEPARATION; dx <= SEPARATION; dx++) {
      if (dx === 0 && dy === 0) continue;
      const record = cells.get(key(x + dx, y + dy));
      if (record !== undefined && record.tier > 0) return true;
    }
  }
  return false;
}

function contextExcept(blocked: ReadonlyArray<readonly [number, number]>): PopulousContext {
  const denied = new Set(blocked.map(([x, y]) => key(x, y)));
  return {
    maxTier: MAX_TIER,
    isBuildable(x: number, y: number): boolean {
      if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return false;
      return !denied.has(key(x, y));
    },
    hasBuildingWithinSeparation: separationCheck,
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
    for (let count = 0; count <= 8; count++) {
      expect(populousTierFor(count, 2)).toBeLessThanOrEqual(2);
      expect(populousTierFor(count, MAX_TIER)).toBeLessThanOrEqual(MAX_TIER);
      expect(populousTierFor(count, MAX_TIER)).toBeGreaterThanOrEqual(0);
    }
  });

  it('has a capacity for every tier the ceiling can reach', () => {
    expect(POPULOUS_CAPACITY_BY_TIER.length).toBe(
      Math.max(...POPULOUS_TIER_BY_FLAT_NEIGHBORS) + 1,
    );
    for (const capacity of POPULOUS_CAPACITY_BY_TIER) expect(capacity).toBeGreaterThan(0);
  });
});

describe('tier follows the flat, buildable ground around a house', () => {
  it('climbs one tier per step toward the top tier on a perfect site', () => {
    let live = boardOf([[10, 10]]);
    const ctx = contextExcept([]);
    const top = populousTierFor(8, MAX_TIER);
    for (let expected = POPULOUS_TIER_CLIMB_PER_STEP; expected <= top; expected += POPULOUS_TIER_CLIMB_PER_STEP) {
      const result = stepPopulous(world, live, ctx);
      live = result.nextLive;
      expect(live.get(key(10, 10))!.tier).toBe(Math.min(top, expected));
    }
    const settled = stepPopulous(world, live, ctx);
    expect(settled.nextLive.get(key(10, 10))!.tier).toBe(top);
    expect(settled.upgraded).toEqual([]);
  });

  it('gives a house on a spit of land a low tier, and stops there', () => {
    const blocked: Array<readonly [number, number]> = [];
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]]) {
      blocked.push([10 + dx, 10 + dy]);
    }
    let live = boardOf([[10, 10]]);
    const ctx = contextExcept(blocked);
    for (let step = 0; step < MAX_TIER + 1; step++) live = stepPopulous(world, live, ctx).nextLive;
    expect(live.get(key(10, 10))!.tier).toBe(populousTierFor(1, MAX_TIER));
  });

  it('DOWN-tiers a house when the ground around it closes up', () => {
    const live = boardOf([[10, 10]], { age: 9, tier: MAX_TIER, population: 0 });
    const blocked: Array<readonly [number, number]> = [
      [9, 9], [10, 9], [11, 9], [9, 10], [11, 10], [9, 11],
    ];
    const result = stepPopulous(world, live, contextExcept(blocked));
    const after = result.nextLive.get(key(10, 10))!;
    expect(after.tier).toBe(populousTierFor(2, MAX_TIER));
    expect(after.tier).toBeLessThan(MAX_TIER);
    expect(result.upgraded).toEqual([{ x: 10, y: 10, tier: after.tier }]);
  });

  it('never births a house from neighbour count alone', () => {
    const live = boardOf([[10, 10], [11, 10], [10, 11]]);
    const result = stepPopulous(world, live, contextExcept([]));
    expect(result.born).toEqual([]);
    for (const cellKey of result.nextLive.keys()) expect(live.has(cellKey)).toBe(true);
  });
});

describe('population', () => {
  it('grows by a fixed amount per step until the tier capacity is reached', () => {
    const ctx = contextExcept([]);
    const tier = populousTierFor(8, MAX_TIER);
    let live = boardOf([[10, 10]], { age: 0, tier, population: 0 });
    const capacity = POPULOUS_CAPACITY_BY_TIER[tier];

    for (let step = 1; step < capacity; step++) {
      const result = stepPopulous(world, live, ctx);
      live = result.nextLive;
      expect(result.emitted).toEqual([]);
      expect(live.get(key(10, 10))!.population).toBe(step * POPULOUS_GROWTH_PER_STEP);
    }
  });

  it('emits exactly one settler when it fills, and resets', () => {
    const ctx = contextExcept([]);
    const tier = populousTierFor(8, MAX_TIER);
    let live = boardOf([[10, 10]], { age: 0, tier, population: 0 });
    const capacity = POPULOUS_CAPACITY_BY_TIER[tier];
    const stepsToFill = Math.ceil(capacity / POPULOUS_GROWTH_PER_STEP);

    let emissions = 0;
    for (let step = 0; step < stepsToFill; step++) {
      const outcome = stepPopulous(world, live, ctx);
      live = outcome.nextLive;
      emissions += outcome.emitted.length;
      if (outcome.emitted.length > 0) {
        expect(outcome.emitted).toEqual([{ x: 10, y: 10 }]);
      }
    }
    expect(emissions).toBe(1);
    expect(live.get(key(10, 10))!.population).toBe(POPULOUS_POPULATION_AFTER_EMIT);
  });

  it('a bigger house sends people out sooner than a smaller one', () => {
    for (let tier = 1; tier < POPULOUS_CAPACITY_BY_TIER.length; tier++) {
      expect(POPULOUS_CAPACITY_BY_TIER[tier]).toBeLessThanOrEqual(
        POPULOUS_CAPACITY_BY_TIER[tier - 1],
      );
    }
  });
});

describe('houses die from the ground under them, never from their neighbour count', () => {
  it('removes a house whose own cell is no longer buildable', () => {
    const live = boardOf([[10, 10], [30, 30]]);
    const result = stepPopulous(world, live, contextExcept([[10, 10]]));
    expect(result.died).toEqual([{ x: 10, y: 10 }]);
    expect(result.nextLive.has(key(10, 10))).toBe(false);
    expect(result.nextLive.has(key(30, 30))).toBe(true);
  });

  it('leaves a lone house standing forever — there is no loneliness rule', () => {
    let live = boardOf([[10, 10]]);
    const ctx = contextExcept([]);
    for (let step = 0; step < 50; step++) live = stepPopulous(world, live, ctx).nextLive;
    expect(live.has(key(10, 10))).toBe(true);
  });

  it('a dead house emits nobody, even with a full population', () => {
    const capacity = POPULOUS_CAPACITY_BY_TIER[0];
    const live = boardOf([[10, 10]], { age: 0, tier: 0, population: capacity });
    const result = stepPopulous(world, live, contextExcept([[10, 10]]));
    expect(result.emitted).toEqual([]);
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
        const result = stepPopulous(world, live, ctx);
        live = result.nextLive;
        log.push({
          live: [...live.entries()].sort((a, b) => a[0] - b[0]),
          born: result.born,
          upgraded: result.upgraded,
          died: result.died,
          emitted: result.emitted,
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
    const a = stepPopulous(world, boardOf(forward), ctx);
    const b = stepPopulous(world, boardOf(reversed), ctx);
    expect(JSON.stringify(a.upgraded)).toBe(JSON.stringify(b.upgraded));
    expect([...a.nextLive.keys()]).toEqual([...b.nextLive.keys()]);
  });
});

describe('the plugin', () => {
  beforeEach(() => {
    resetStructuresBridge();
    resetPilgrimsBridge();
  });

  it('offers its model on every open and takes it back when the world closes', () => {
    const registered: unknown[] = [];
    const world = worldWithSibling('structures', {
      setGrowthModel: (m: unknown) => registered.push(m),
    });

    populousPlugin.onWorldCreate?.(world);
    expect(registered).toEqual([growthModelForTest()]);

    populousPlugin.onWorldClose?.(world);
    expect(registered).toEqual([growthModelForTest(), null]);
  });

  it('registers its model with a structures that only starts running later', () => {
    const registered: unknown[] = [];

    loadStructuresBridge(worldWithSibling('structures', null));
    registerGrowthModel(growthModelForTest());
    expect(registered).toEqual([]);

    loadStructuresBridge(
      worldWithSibling('structures', { setGrowthModel: (m: unknown) => registered.push(m) }),
    );
    expect(registered).toEqual([growthModelForTest()]);
  });

  it('loads with structures absent rather than throwing', () => {
    registerGrowthModel(growthModelForTest());
    loadStructuresBridge(worldWithSibling('structures', {}));
  });

  it('sends a settler out of the house that filled, through pilgrims', () => {
    const asked: Array<{ x: number; y: number }> = [];
    loadPilgrimsBridge(
      worldWithSibling('pilgrims', {
        emitSettlerFrom: (x: number, y: number) => {
          asked.push({ x, y });
          return true;
        },
      }),
    );

    const model = growthModelForTest();
    const ctx = contextExcept([]);
    const tier = populousTierFor(8, MAX_TIER);
    const capacity = POPULOUS_CAPACITY_BY_TIER[tier];
    let live: ReadonlyMap<number, PopulousCellRecord> = boardOf([[10, 10]], {
      age: 0,
      tier,
      population: capacity - POPULOUS_GROWTH_PER_STEP,
    });
    const outcome = model.step(world, live, ctx);
    expect(asked).toEqual([]);
    model.afterSwap(outcome.emitted);
    live = outcome.nextLive;

    expect(asked).toEqual([{ x: 10, y: 10 }]);
    expect(live.get(key(10, 10))!.population).toBe(POPULOUS_POPULATION_AFTER_EMIT);
  });

  it('houses fill up and nobody walks out when pilgrims is absent', () => {
    loadPilgrimsBridge(worldWithSibling('pilgrims', {}));

    const model = growthModelForTest();
    const ctx = contextExcept([]);
    let live: ReadonlyMap<number, PopulousCellRecord> = boardOf([[10, 10]]);
    for (let step = 0; step < 30; step++) {
      const outcome = model.step(world, live, ctx);
      model.afterSwap(outcome.emitted);
      live = outcome.nextLive;
    }
    expect(live.has(key(10, 10))).toBe(true);
  });
});

describe('buildings never stand within the separation of one another', () => {
  const STEPS = Math.ceil(MAX_TIER / POPULOUS_TIER_CLIMB_PER_STEP) + 1;

  it('promotes one cell of a 2×2 homestead and demolishes the other three', () => {
    const ctx = contextExcept([]);
    let live: ReadonlyMap<number, PopulousCellRecord> = boardOf([
      [10, 10],
      [11, 10],
      [10, 11],
      [11, 11],
    ]);
    for (let step = 0; step < STEPS; step++) {
      live = stepPopulous(world, live, ctx).nextLive;
    }

    expect(live.size).toBe(1);
    const buildings = [...live.entries()].filter(([, record]) => record.tier > 0);
    expect(buildings.length).toBe(1);
    expect(buildings[0][0]).toBe(key(10, 10));
    expect(live.get(key(10, 10))!.tier).toBe(populousTierFor(8, MAX_TIER));
  });

  it('reports the cell it clears in `died`, and emits nobody from it', () => {
    const ctx = contextExcept([]);
    const result = stepPopulous(world, boardOf([[10, 10], [11, 10]]), ctx);
    expect(result.died).toContainEqual({ x: 11, y: 10 });
    expect(result.nextLive.has(key(11, 10))).toBe(false);
    expect(result.emitted).not.toContainEqual({ x: 11, y: 10 });
  });

  it('is deterministic: insertion order of the board cannot change the outcome', () => {
    const ctx = contextExcept([]);
    const forwards = boardOf([[10, 10], [11, 10], [10, 11], [11, 11]]);
    const backwards = new Map(
      [...boardOf([[10, 10], [11, 10], [10, 11], [11, 11]]).entries()].reverse(),
    );
    const a = stepPopulous(world, forwards, ctx);
    const b = stepPopulous(world, backwards, ctx);
    expect([...a.nextLive.entries()].sort((l, r) => l[0] - r[0])).toEqual(
      [...b.nextLive.entries()].sort((l, r) => l[0] - r[0]),
    );
    expect(a.upgraded).toEqual(b.upgraded);
    expect(a.died).toEqual(b.died);
    expect(a.emitted).toEqual(b.emitted);
  });

  it('collapses an already-overlapping pair to one building, not to two camps', () => {
    const ctx = contextExcept([]);
    const live = boardOf([[10, 10], [11, 10]], { age: 9, tier: MAX_TIER, population: 0 });
    const result = stepPopulous(world, live, ctx);
    expect(result.nextLive.has(key(10, 10))).toBe(false);
    expect(result.died).toContainEqual({ x: 10, y: 10 });
    expect(result.nextLive.get(key(11, 10))!.tier).toBe(MAX_TIER);

    const again = stepPopulous(world, result.nextLive, ctx);
    expect(again.nextLive.size).toBe(1);
    expect(again.died).toEqual([]);
    expect(again.nextLive.get(key(11, 10))!.tier).toBe(MAX_TIER);
  });
});
