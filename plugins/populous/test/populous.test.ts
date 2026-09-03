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

/**
 * structures' STRUCTURE_SEPARATION_CELLS, restated — this plugin's tests may
 * no more import that plugin than the plugin itself may. 5 is what protocol.ts
 * derives today; the exact value is not what any test below asserts, only that
 * two buildings inside it cannot both stand.
 */
const SEPARATION = 5;

/**
 * The clearance predicate structures supplies through the context, implemented
 * here exactly as clearance.ts implements it: Chebyshev SEPARATION, (x, y)
 * itself excluded, buildings only (`tier > 0`) — teepees and camps may cluster.
 */
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

/** Everything in-bounds is buildable unless it is in `blocked`. */
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
    // A structures build with fewer tiers than this table assumes must never
    // be handed a tier it cannot render.
    for (let count = 0; count <= 8; count++) {
      expect(populousTierFor(count, 2)).toBeLessThanOrEqual(2);
      expect(populousTierFor(count, MAX_TIER)).toBeLessThanOrEqual(MAX_TIER);
      expect(populousTierFor(count, MAX_TIER)).toBeGreaterThanOrEqual(0);
    }
  });

  it('has a capacity for every tier the ceiling can reach', () => {
    // DERIVED FROM THE LADDER ITSELF, not from a restated ceiling: the
    // capacity table must cover every tier the tier table can actually
    // produce, whatever that top tier happens to be.
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
    // And holds there: nothing left to climb, nothing on the wire.
    const settled = stepPopulous(world, live, ctx);
    expect(settled.nextLive.get(key(10, 10))!.tier).toBe(top);
    expect(settled.upgraded).toEqual([]);
  });

  it('gives a house on a spit of land a low tier, and stops there', () => {
    // Only (11, 10) is buildable beside it: one flat Moore neighbour.
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
    // A tier change of either direction travels on the same list — the wire
    // carries the new tier, not a direction.
    expect(result.upgraded).toEqual([{ x: 10, y: 10, tier: after.tier }]);
  });

  it('never births a house from neighbour count alone', () => {
    // Conway's B3 would fill in the fourth corner of this L. This model has no
    // birth rule at all, so the board can only ever LOSE cells in a step —
    // asserted as a subset rather than as a count, because the keep-clear rule
    // does remove two of these three (see CLEARANCE below).
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
    // Already at its site's tier, so the capacity in play is one fixed number
    // rather than the sliding one a house still climbing would have.
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
    // The whole point of the ladder: capacity falls as tier rises.
    for (let tier = 1; tier < POPULOUS_CAPACITY_BY_TIER.length; tier++) {
      expect(POPULOUS_CAPACITY_BY_TIER[tier]).toBeLessThanOrEqual(
        POPULOUS_CAPACITY_BY_TIER[tier - 1],
      );
    }
  });
});

// The terrain half of the death rule. The other half — a building's keep-clear
// disc claiming the ground — is asserted under CLEARANCE below.
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

// ─────────────────────────────────────────────────────────────────────────────
// The plugin wiring: what registers where, and what happens when the plugins
// it talks to are not there. Both bridges are driven through a stub world whose
// sibling lookup answers with a fake module, so no sibling plugin is imported
// and the whole file still passes with structures and pilgrims deleted.
// ─────────────────────────────────────────────────────────────────────────────

describe('the plugin', () => {
  beforeEach(() => {
    resetStructuresBridge();
    resetPilgrimsBridge();
  });

  it('offers its model on every open and takes it back when the world closes', () => {
    // WHICH RULE A WORLD RUNS IS STRUCTURES' SETTING, not this plugin's env
    // gate any more (per-world plugin settings, 2026-08-25): this plugin
    // registers wherever it runs, and the slot is emptied on close so the next
    // world cannot inherit a rule it never chose.
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

    // Registered while no structures is running — rule 3 of the bridge pattern.
    loadStructuresBridge(worldWithSibling('structures', null));
    registerGrowthModel(growthModelForTest());
    expect(registered).toEqual([]);

    // The reopen that switches structures on replays it.
    loadStructuresBridge(
      worldWithSibling('structures', { setGrowthModel: (m: unknown) => registered.push(m) }),
    );
    expect(registered).toEqual([growthModelForTest()]);
  });

  it('loads with structures absent rather than throwing', () => {
    registerGrowthModel(growthModelForTest());
    loadStructuresBridge(worldWithSibling('structures', {})); // no throw is the assertion
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
    // One step short of full, so this single step fills it and empties it.
    let live: ReadonlyMap<number, PopulousCellRecord> = boardOf([[10, 10]], {
      age: 0,
      tier,
      population: capacity - POPULOUS_GROWTH_PER_STEP,
    });
    const outcome = model.step(world, live, ctx);
    // NOTHING HAS BEEN ASKED YET — the step only reports (structures calls the
    // hook back once it has swapped the board in; see GrowthModel.afterSwap).
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
    // The board is untouched by the missing plugin — the house still stands.
    expect(live.has(key(10, 10))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLEARANCE (F2). structures' keep-clear rule is a property of the BOARD, not
// of the Conway CA that happened to be enforcing it: under the CA, scanChunk
// refuses the teepee→building step inside another building's square and
// clearKeepClearSquare EMPTIES that square. This model ran neither, so a
// pilgrims 2×2 homestead on open ground became four adjacent top-tier
// buildings standing inside one another.
//
// BOTH HALVES OF THE RULE (owner, 2026-09-02: "it's okay if teepees spawn on
// top of each other, but nothing else should share a space"). Refusing the
// promotion is only the first half; a cell inside a building's disc is
// DEMOLISHED — reported in `died`, absent from `nextLive` — because holding it
// at tier 0 left camps standing under a house forever, still emitting settlers
// (GH #183).

describe('buildings never stand within the separation of one another', () => {
  /** Enough steps that every cell has long since climbed to its terrain tier. */
  const STEPS = Math.ceil(MAX_TIER / POPULOUS_TIER_CLIMB_PER_STEP) + 1;

  it('promotes one cell of a 2×2 homestead and demolishes the other three', () => {
    const ctx = contextExcept([]); // wide open flat ground: every cell earns the top tier
    let live: ReadonlyMap<number, PopulousCellRecord> = boardOf([
      [10, 10],
      [11, 10],
      [10, 11],
      [11, 11],
    ]);
    for (let step = 0; step < STEPS; step++) {
      live = stepPopulous(world, live, ctx).nextLive;
    }

    // THE BUILDING'S GROUND IS EMPTIED. The three cells that may not build sit
    // inside the promoted cell's keep-clear disc, so they are demolished rather
    // than left standing as camps under the house.
    expect(live.size).toBe(1);
    const buildings = [...live.entries()].filter(([, record]) => record.tier > 0);
    expect(buildings.length).toBe(1);
    // Among CAMPS climbing together the FIRST cell in ascending key order is
    // promoted, and every later cell then sees it standing; that is the
    // tie-break. (Among BUILDINGS it runs the other way — see the last case.)
    expect(buildings[0][0]).toBe(key(10, 10));
    expect(live.get(key(10, 10))!.tier).toBe(populousTierFor(8, MAX_TIER));
  });

  it('reports the cell it clears in `died`, and emits nobody from it', () => {
    // The demolition has to reach the wire: structures broadcasts `died` on the
    // same delta path a terrain death takes (its advanceGrowthModel), so a cell
    // merely dropped from the board would stay drawn on every client.
    const ctx = contextExcept([]);
    const result = stepPopulous(world, boardOf([[10, 10], [11, 10]]), ctx);
    expect(result.died).toContainEqual({ x: 11, y: 10 });
    expect(result.nextLive.has(key(11, 10))).toBe(false);
    // A demolished cell is never asked for a settler — that was the GH #183
    // failure, a camp under a house going on emitting for the life of the world.
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
    // Both cells arrive as buildings — a board written before this rule, or a
    // save from one. Demolishing BOTH (checking against the previous board
    // wholesale) would empty the site; holding both at 0 would make them flip
    // camp/building forever. Among BUILDINGS the LATER cell in key order keeps
    // its house: the earlier one is reached first, still sees the later one
    // undecided at its old tier, and goes.
    const ctx = contextExcept([]);
    const live = boardOf([[10, 10], [11, 10]], { age: 9, tier: MAX_TIER, population: 0 });
    const result = stepPopulous(world, live, ctx);
    expect(result.nextLive.has(key(10, 10))).toBe(false);
    expect(result.died).toContainEqual({ x: 10, y: 10 });
    expect(result.nextLive.get(key(11, 10))!.tier).toBe(MAX_TIER);

    // …and the survivor STAYS, rather than the pair oscillating.
    const again = stepPopulous(world, result.nextLive, ctx);
    expect(again.nextLive.size).toBe(1);
    expect(again.died).toEqual([]);
    expect(again.nextLive.get(key(11, 10))!.tier).toBe(MAX_TIER);
  });
});
