// The pilgrims plugin's contracts: the race copy's agreement with structures,
// the defensive wire parse, settledness, the journey state machine, the
// blessing hand-off, and both bridges' degraded paths. Pure node — the sim is
// deliberately testable without a server (see pilgrimage.ts's header).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEA_LEVEL, BAND_HEIGHT } from '@terrace/shared';
import {
  PILGRIMS_CAP,
  WALKERS_WIRE_CAP,
  WANDERERS_CAP,
  parseEntitiesPayload,
  roundBroadcastPosition,
  settlementRace,
} from '../protocol.ts';
import {
  ARRIVAL_RADIUS_CELLS,
  MONSTER_SETTLED_RADIUS_CELLS,
  PILGRIMAGE_CATCHMENT_CELLS,
  PILGRIMAGE_ONSET_SECONDS,
  PILGRIM_LINGER_SECONDS,
  Pilgrimage,
  SettlednessTracker,
  VIEWPOINT_RING_CELLS,
  WalkerIdAllocator,
  isWalkableCell,
  pickViewpoint,
  type PilgrimWorld,
} from '../server/pilgrimage.ts';
import {
  WANDERER_MIN_AGE_GENERATIONS,
  WANDER_EPOCH_SECONDS,
  WANDER_RANGE_CELLS,
  Wandering,
} from '../server/wandering.ts';
import {
  STRUCTURES_UNAVAILABLE_WARNING,
  applyBlessedCells,
  bridgedStructures,
  loadStructuresBridge,
  resetStructuresBridge,
  setStructuresModuleLoader,
  structuresBridgeReady,
} from '../server/structures-bridge.ts';
import {
  bridgedMonsters,
  loadMonstersBridge,
  resetMonstersBridge,
  setMonstersModuleLoader,
  monstersBridgeReady,
} from '../server/monsters-bridge.ts';

/** A flat, dry island world: land above sea everywhere except a border moat. */
function islandWorld(size = 128, landHeight = 2 * BAND_HEIGHT): PilgrimWorld {
  return {
    worldSize: size,
    heightAt: (x, y) =>
      x < 2 || y < 2 || x >= size - 2 || y >= size - 2 ? SEA_LEVEL - BAND_HEIGHT : landHeight,
  };
}

const TICK = 0.1; // the shipped 10 Hz

function runSeconds(
  sim: Pilgrimage,
  world: PilgrimWorld,
  monsters: ReadonlyArray<{ id: number; x: number; y: number }>,
  settlements: ReadonlyArray<{ x: number; y: number }>,
  seconds: number,
): void {
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i++) sim.advance(world, monsters, settlements, TICK);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the race copy', () => {
  it('matches structures’ pinned golden vectors exactly', () => {
    // The SAME vectors structures/test/client.test.ts pins. If either side's
    // derivation moves, one of the two suites fails — that agreement is the
    // whole cross-plugin contract (see protocol.ts).
    for (const [x, y, race] of [
      [0, 0, 'rudy'],
      [8, 12, 'rudy'],
      [16, 16, 'uno'],
      [100, 100, 'uno'],
      [255, 17, 'uno'],
      [511, 511, 'rudy'],
    ] as const) {
      expect(settlementRace(x, y)).toBe(race);
    }
  });
});

describe('the wire format', () => {
  it('round-trips a valid payload and drops malformed rows individually', () => {
    const good = { id: 1, kind: 'pilgrim', race: 'rudy', x: 3.25, y: 4.5, heading: 0.5 };
    const parsed = parseEntitiesPayload({
      pilgrims: [
        good,
        { id: 2, race: 'dragon', x: 0, y: 0, heading: 0 }, // unknown race
        { id: 'x', race: 'uno', x: 0, y: 0, heading: 0 }, // bad id
        { id: 3, race: 'uno', x: Number.NaN, y: 0, heading: 0 }, // bad x
        { id: 4, race: 'uno', x: 1, y: 2, heading: 3 },
      ],
    });
    // A row without a kind is from a pre-wanderer server, which only ever
    // sent pilgrims — the parser restores that meaning, never guesses.
    expect(parsed).toEqual([good, { id: 4, kind: 'pilgrim', race: 'uno', x: 1, y: 2, heading: 3 }]);
  });

  it('accepts wanderer rows and drops rows whose kind it does not know', () => {
    const parsed = parseEntitiesPayload({
      pilgrims: [
        { id: 1, kind: 'wanderer', race: 'uno', x: 1, y: 2, heading: 3 },
        { id: 2, kind: 'merchant', race: 'rudy', x: 0, y: 0, heading: 0 }, // future kind
      ],
    });
    // The unknown kind is dropped whole: a render loop must never meet a
    // model it cannot build (a newer server is an ordinary event).
    expect(parsed).toEqual([{ id: 1, kind: 'wanderer', race: 'uno', x: 1, y: 2, heading: 3 }]);
  });

  it('rejects a payload that is not a list at all', () => {
    expect(parseEntitiesPayload(null)).toBeNull();
    expect(parseEntitiesPayload({})).toBeNull();
    expect(parseEntitiesPayload({ pilgrims: 'nope' })).toBeNull();
  });

  it('never parses past the cap the client allocated for', () => {
    const rows = Array.from({ length: WALKERS_WIRE_CAP + 10 }, (_, i) => ({
      id: i,
      race: 'rudy',
      x: 0,
      y: 0,
      heading: 0,
    }));
    expect(parseEntitiesPayload({ pilgrims: rows })).toHaveLength(WALKERS_WIRE_CAP);
  });

  it('rounds broadcast positions to the declared precision', () => {
    expect(roundBroadcastPosition(1.23456)).toBe(1.23);
    expect(roundBroadcastPosition(87.999)).toBe(88);
  });
});

describe('settledness', () => {
  it('settles a monster that keeps to its circle for the onset time', () => {
    const tracker = new SettlednessTracker();
    // A few ticks past the threshold: dt accumulates in floating point, so
    // the crossing lands within a tick of the nominal onset, never exactly on
    // it — the same is true live, and one tick of slack is invisible there.
    const ticks = Math.round(PILGRIMAGE_ONSET_SECONDS / TICK) + 3;
    let settled: ReturnType<SettlednessTracker['advance']> = [];
    for (let i = 0; i <= ticks; i++) {
      // Small drift inside the circle must not reset the clock.
      const wobble = (i % 2) * 2;
      settled = tracker.advance([{ id: 7, x: 50 + wobble, y: 50 }], TICK);
    }
    expect(settled).toEqual([{ monsterId: 7, x: 50, y: 50 }]);
  });

  it('re-anchors a wanderer and starts the clock over', () => {
    const tracker = new SettlednessTracker();
    runTracker(tracker, 50, 50, PILGRIMAGE_ONSET_SECONDS * 0.9);
    // One long stride out of the circle...
    tracker.advance([{ id: 7, x: 50 + MONSTER_SETTLED_RADIUS_CELLS + 1, y: 50 }], TICK);
    // ...means 90% of the onset again is still not enough.
    const settled = runTracker(tracker, 50 + MONSTER_SETTLED_RADIUS_CELLS + 1, 50, PILGRIMAGE_ONSET_SECONDS * 0.9);
    expect(settled).toEqual([]);
  });

  it('forgets a monster missing from the feed', () => {
    const tracker = new SettlednessTracker();
    runTracker(tracker, 50, 50, PILGRIMAGE_ONSET_SECONDS);
    tracker.advance([], TICK); // banished
    const settled = runTracker(tracker, 50, 50, TICK * 2);
    expect(settled).toEqual([]);
  });

  function runTracker(
    tracker: SettlednessTracker,
    x: number,
    y: number,
    seconds: number,
  ): ReturnType<SettlednessTracker['advance']> {
    let settled: ReturnType<SettlednessTracker['advance']> = [];
    for (let i = 0; i < Math.round(seconds / TICK); i++) {
      settled = tracker.advance([{ id: 7, x, y }], TICK);
    }
    return settled;
  }
});

describe('terrain predicates', () => {
  it('walks land, refuses water and the world edge', () => {
    const world = islandWorld();
    expect(isWalkableCell(world, 50, 50)).toBe(true);
    expect(isWalkableCell(world, 0, 50)).toBe(false); // moat
    expect(isWalkableCell(world, -1, 50)).toBe(false);
    expect(isWalkableCell(world, 50, 1000)).toBe(false);
  });

  it('picks the highest walkable ring cell as the viewpoint, deterministically', () => {
    const size = 128;
    const ridgeX = 64 + VIEWPOINT_RING_CELLS; // the angle-0 sample cell
    const world: PilgrimWorld = {
      worldSize: size,
      heightAt: (x) => (x === ridgeX ? 5 * BAND_HEIGHT : 2 * BAND_HEIGHT),
    };
    expect(pickViewpoint(world, 64, 64)).toEqual({ x: ridgeX + 0.5, y: 64.5 });
  });

  it('returns null when the whole ring is at sea — an offshore beast draws no crowd', () => {
    const world: PilgrimWorld = { worldSize: 128, heightAt: () => SEA_LEVEL - BAND_HEIGHT };
    expect(pickViewpoint(world, 64, 64)).toBeNull();
  });
});

describe('the journey', () => {
  const MONSTER = { id: 1, x: 64, y: 64 };
  const HOME = { x: 64 - 40, y: 64 }; // inside the catchment, on land

  function settledSim(world: PilgrimWorld): Pilgrimage {
    const sim = new Pilgrimage();
    // +1 s of slack over the nominal onset — see the settledness suite's note
    // on floating-point dt accumulation.
    runSeconds(sim, world, [MONSTER], [HOME], PILGRIMAGE_ONSET_SECONDS + 1);
    return sim;
  }

  it('dispatches one pilgrim per settlement once the monster settles, and blesses the home', () => {
    const world = islandWorld();
    const sim = settledSim(world);
    expect(sim.populationCount()).toBe(1);
    expect(sim.blessedCellKeys()).toEqual([HOME.y * 65536 + HOME.x]);
    const [pilgrim] = sim.states();
    expect(pilgrim.race).toBe(settlementRace(HOME.x, HOME.y));
  });

  it('never dispatches for a settlement outside the catchment', () => {
    const world = islandWorld(256);
    const sim = new Pilgrimage();
    const far = { x: 64 + PILGRIMAGE_CATCHMENT_CELLS + 5, y: 64 };
    runSeconds(sim, world, [MONSTER], [far], PILGRIMAGE_ONSET_SECONDS + 1);
    expect(sim.populationCount()).toBe(0);
  });

  it('caps the crowd at PILGRIMS_CAP', () => {
    const world = islandWorld();
    const sim = new Pilgrimage();
    const towns: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < PILGRIMS_CAP + 8; i++) towns.push({ x: 34 + i, y: 60 });
    runSeconds(sim, world, [MONSTER], towns, PILGRIMAGE_ONSET_SECONDS + 1);
    expect(sim.populationCount()).toBe(PILGRIMS_CAP);
  });

  it('walks out, lingers facing the beast, walks home, and completes', () => {
    const world = islandWorld();
    const sim = settledSim(world);

    // Outbound: the walk to a ring 40-ish cells away takes ~50 s at 0.5 c/s.
    runSeconds(sim, world, [MONSTER], [HOME], 120);
    expect(sim.populationCount()).toBe(1); // arrived and lingering, or nearly
    const [watching] = sim.states();
    const toRing = Math.hypot(watching.x - MONSTER.x, watching.y - MONSTER.y);
    expect(toRing).toBeLessThanOrEqual(VIEWPOINT_RING_CELLS + ARRIVAL_RADIUS_CELLS + 1);

    // Linger + the walk home, generously budgeted: the journey must COMPLETE
    // and the blessing must lift.
    runSeconds(sim, world, [MONSTER], [HOME], PILGRIM_LINGER_SECONDS + 180);
    // The monster is still settled, so a fresh pilgrim may already have been
    // re-dispatched — completion is proven by the id turning over, not by an
    // empty population.
    const states = sim.states();
    expect(states.every((p) => p.id !== watching.id)).toBe(true);
  });

  it('recalls the crowd when the monster unsettles', () => {
    const world = islandWorld();
    const sim = settledSim(world);
    runSeconds(sim, world, [MONSTER], [HOME], 30); // mid-walk

    // The monster bolts: its anchor resets, it is no longer settled.
    runSeconds(sim, world, [{ id: 1, x: 120, y: 20 }], [HOME], 90);
    // Everyone is home (despawned) — and nothing new dispatched.
    expect(sim.populationCount()).toBe(0);
    expect(sim.blessedCellKeys()).toEqual([]);
  });

  it('keeps every pilgrim on land for the whole journey', () => {
    const world = islandWorld();
    const sim = settledSim(world);
    for (let i = 0; i < Math.round(200 / TICK); i++) {
      sim.advance(world, [MONSTER], [HOME], TICK);
      for (const p of sim.states()) {
        expect(isWalkableCell(world, p.x, p.y)).toBe(true);
      }
    }
  });
});

describe('the wandering', () => {
  // ROLL_EVERY_EPOCH collapses the dispatch hash to "every qualifying town,
  // every epoch" (the documented test seam) so journey and cap tests need no
  // hash hunting; the determinism test below runs the REAL modulus.
  const ROLL_EVERY_EPOCH = 1;

  function runWander(
    sim: Wandering,
    world: PilgrimWorld,
    settlements: ReadonlyArray<{ x: number; y: number; age?: number }>,
    seconds: number,
  ): void {
    const ticks = Math.round(seconds / TICK);
    for (let i = 0; i < ticks; i++) sim.advance(world, settlements, TICK);
  }

  const TOWN = { x: 40, y: 60, age: WANDERER_MIN_AGE_GENERATIONS };
  const NEIGHBOUR = { x: 52, y: 60, age: WANDERER_MIN_AGE_GENERATIONS }; // 12 cells away

  it('dispatches from an established town to a neighbour, visits, and walks home', () => {
    const world = islandWorld();
    const sim = new Wandering(undefined, ROLL_EVERY_EPOCH);
    sim.advance(world, [TOWN, NEIGHBOUR], TICK); // epoch 0 rolls on first tick

    expect(sim.populationCount()).toBe(2); // both towns rolled — each strolls
    const [first] = sim.states();
    expect(first.kind).toBe('wanderer');
    expect(first.race).toBe(settlementRace(TOWN.x, TOWN.y));

    // 12 cells out + visit + 12 back at 0.5 c/s ≈ 58 s; give slack, but stay
    // inside epoch 1 hasn't-re-rolled… it HAS re-rolled at 60 s — so prove
    // completion the pilgrims' way: the original ids are gone.
    runWander(sim, world, [TOWN, NEIGHBOUR], 90);
    expect(sim.states().every((w) => w.id !== first.id)).toBe(true);
  });

  it('establishment is the CA clock: one epoch of survived generations', () => {
    // Golden derivation pin: 4 generations × structures' 15 s cadence (own-
    // copy restatement) IS the dispatch epoch, so "old enough to stroll" and
    // "outlived a full roll cycle" stay the same statement. This gate shipped
    // twice as a TIER bar and both times silenced every stroll on the live
    // world — a changed relationship here must be a decision, not a drift.
    const STRUCTURES_GENERATION_SECONDS = 15;
    expect(WANDERER_MIN_AGE_GENERATIONS * STRUCTURES_GENERATION_SECONDS).toBe(
      WANDER_EPOCH_SECONDS,
    );
  });

  it('never dispatches from the too-young, and absent age qualifies', () => {
    const world = islandWorld();
    const newborn = { ...TOWN, age: WANDERER_MIN_AGE_GENERATIONS - 1 };
    const sim = new Wandering(undefined, ROLL_EVERY_EPOCH);
    sim.advance(world, [newborn, { ...NEIGHBOUR, age: 0 }], TICK);
    expect(sim.populationCount()).toBe(0); // fresh cells stroll nowhere

    // A structures build too old to send age: the gate degrades to ungated
    // (both endpoints dispatch), never to silence.
    const ageless = new Wandering(undefined, ROLL_EVERY_EPOCH);
    ageless.advance(world, [{ x: TOWN.x, y: TOWN.y }, { x: NEIGHBOUR.x, y: NEIGHBOUR.y }], TICK);
    expect(ageless.populationCount()).toBe(2);

    const lonely = new Wandering(undefined, ROLL_EVERY_EPOCH);
    lonely.advance(world, [TOWN], TICK); // no other town within range
    expect(lonely.populationCount()).toBe(0);

    const remote = { x: TOWN.x + WANDER_RANGE_CELLS + 5, y: TOWN.y, age: TOWN.age };
    const outOfRange = new Wandering(undefined, ROLL_EVERY_EPOCH);
    outOfRange.advance(world, [TOWN, remote], TICK);
    expect(outOfRange.populationCount()).toBe(0);
  });

  it('caps the ambient crowd at WANDERERS_CAP', () => {
    const world = islandWorld();
    const sim = new Wandering(undefined, ROLL_EVERY_EPOCH);
    const towns = Array.from({ length: WANDERERS_CAP + 8 }, (_, i) => ({
      x: 20 + i * 3,
      y: 60,
      age: WANDERER_MIN_AGE_GENERATIONS,
    }));
    sim.advance(world, towns, TICK);
    expect(sim.populationCount()).toBe(WANDERERS_CAP);
  });

  it('is deterministic at the real modulus: two sims, same feed, identical traffic', () => {
    const world = islandWorld();
    // A dense honest town grid — SOME cells roll at SOME epoch; which ones is
    // exactly what must reproduce.
    const towns: Array<{ x: number; y: number; age?: number }> = [];
    for (let x = 8; x < 120; x += 6) {
      for (let y = 40; y < 80; y += 6) towns.push({ x, y, age: WANDERER_MIN_AGE_GENERATIONS });
    }
    const a = new Wandering();
    const b = new Wandering();
    let sawTraffic = false;
    for (let s = 0; s < 3 * WANDER_EPOCH_SECONDS; s += 10) {
      runWander(a, world, towns, 10);
      runWander(b, world, towns, 10);
      expect(a.states()).toEqual(b.states());
      sawTraffic ||= a.populationCount() > 0;
    }
    // And the agreement was about something: the honest modulus really rolled
    // somebody in three epochs of a ~130-town grid (P(silence) ≈ 0.97^390).
    expect(sawTraffic).toBe(true);
  });

  it('keeps every wanderer on land for the whole stroll', () => {
    const world = islandWorld();
    const sim = new Wandering(undefined, ROLL_EVERY_EPOCH);
    for (let i = 0; i < Math.round(120 / TICK); i++) {
      sim.advance(world, [TOWN, NEIGHBOUR], TICK);
      for (const w of sim.states()) {
        expect(isWalkableCell(world, w.x, w.y)).toBe(true);
      }
    }
  });

  it('mints ids from the shared allocator — never colliding with pilgrims', () => {
    const world = islandWorld();
    const ids = new WalkerIdAllocator();
    const pilgrims = new Pilgrimage(ids);
    const wanderers = new Wandering(ids, ROLL_EVERY_EPOCH);

    const MONSTER = { id: 1, x: 64, y: 64 };
    const HOME = { x: 40, y: 64 };
    for (let i = 0; i < Math.round((PILGRIMAGE_ONSET_SECONDS + 5) / TICK); i++) {
      pilgrims.advance(world, [MONSTER], [HOME], TICK);
      wanderers.advance(world, [TOWN, NEIGHBOUR], TICK);
    }
    const all = [...pilgrims.states(), ...wanderers.states()];
    expect(all.length).toBeGreaterThan(1); // both populations are live
    expect(new Set(all.map((w) => w.id)).size).toBe(all.length);
  });
});

describe('the bridges', () => {
  beforeEach(() => {
    resetStructuresBridge();
    resetMonstersBridge();
    vi.restoreAllMocks();
  });

  it('degrades to an empty world and warns once when structures is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStructuresModuleLoader(() => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')));
    void loadStructuresBridge();
    void loadStructuresBridge(); // second call must not double-load or double-warn
    await structuresBridgeReady();
    expect(bridgedStructures()).toEqual([]);
    expect(applyBlessedCells([1])).toBeUndefined(); // buffered, no throw
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(STRUCTURES_UNAVAILABLE_WARNING, expect.any(Error));
  });

  it('rejects a module of the wrong shape the same way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStructuresModuleLoader(() => Promise.resolve({ somethingElse: true }));
    void loadStructuresBridge();
    await structuresBridgeReady();
    expect(bridgedStructures()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('replays the buffered blessed set into a late-arriving structures', async () => {
    const seen: Array<readonly number[]> = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setStructuresModuleLoader(async () => {
      await gate;
      return {
        standingStructures: () => [],
        setBlessedStructureCells: (keys: readonly number[]) => {
          seen.push(keys);
        },
      };
    });
    void loadStructuresBridge();
    applyBlessedCells([42, 43]); // before the module resolves
    release?.();
    await structuresBridgeReady();
    expect(seen).toEqual([[42, 43]]); // rule 3: buffered, replayed once
  });

  it('polls monsters through the bridge and re-validates rows structurally', async () => {
    setMonstersModuleLoader(() =>
      Promise.resolve({
        monsterStates: () => [
          { id: 1, kind: 'kraken', x: 3, y: 4 },
          { id: 'bad', kind: 'kraken', x: 0, y: 0 }, // dropped
          null, // dropped
        ],
      }),
    );
    void loadMonstersBridge();
    await monstersBridgeReady();
    expect(bridgedMonsters()).toEqual([{ id: 1, kind: 'kraken', x: 3, y: 4 }]);
  });

  it('degrades monsters to an empty list when the plugin is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setMonstersModuleLoader(() => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')));
    void loadMonstersBridge();
    await monstersBridgeReady();
    expect(bridgedMonsters()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
