import { beforeEach, describe, expect, it, vi } from 'vitest';
import { worldWithSibling } from '../../../server/test/support/harness.ts';
import {
  BAND_HEIGHT,
  SEA_LEVEL,
  cellsAcross,
} from '@terrace/shared';
import {
  PILGRIMS_CAP,
  SETTLERS_CAP,
  WALKERS_WIRE_CAP,
  WANDERERS_CAP,
  parseEntitiesPayload,
  roundBroadcastPosition,
  SETTLER_DISTRICT_CELLS,
  settlementRace,
} from '../protocol.ts';
import {
  MONSTER_SETTLED_RADIUS_CELLS,
  PILGRIMAGE_ONSET_SECONDS,
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
  Wandering,
} from '../server/wandering.ts';
import { Settling } from '../server/settling.ts';
import {
  STRUCTURES_UNAVAILABLE_WARNING,
  applyBlessedCells,
  bridgedStructures,
  loadStructuresBridge,
  resetStructuresBridge,
} from '../server/structures-bridge.ts';
import {
  bridgedMonsters,
  loadMonstersBridge,
  resetMonstersBridge,
} from '../server/monsters-bridge.ts';

function islandWorld(size = cellsAcross(128), landHeight = 2 * BAND_HEIGHT): PilgrimWorld {
  return {
    worldSize: size,
    heightAt: (x, y) =>
      x < 2 || y < 2 || x >= size - 2 || y >= size - 2 ? SEA_LEVEL - BAND_HEIGHT : landHeight,
  };
}

const TICK = 0.1;

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

describe('the race copy', () => {
  it('matches structures’ pinned golden vectors exactly', () => {
    for (const [districtX, districtY, race] of [
      [0, 0, 'rudy'],
      [1, 1, 'uno'],
      [6, 6, 'uno'],
      [15, 1, 'uno'],
      [31, 31, 'rudy'],
    ] as const) {
      const x = districtX * SETTLER_DISTRICT_CELLS + 3;
      const y = districtY * SETTLER_DISTRICT_CELLS + 3;
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
        { id: 2, race: 'dragon', x: 0, y: 0, heading: 0 },
        { id: 'x', race: 'uno', x: 0, y: 0, heading: 0 },
        { id: 3, race: 'uno', x: Number.NaN, y: 0, heading: 0 },
        { id: 4, race: 'uno', x: 1, y: 2, heading: 3 },
      ],
    });
    expect(parsed).toEqual([
      { ...good, climbHeight: null, falling: false, stance: null },
      {
        id: 4,
        kind: 'pilgrim',
        race: 'uno',
        x: 1,
        y: 2,
        heading: 3,
        climbHeight: null,
        falling: false,
        stance: null,
      },
    ]);
  });

  it('accepts wanderer rows and drops rows whose kind it does not know', () => {
    const parsed = parseEntitiesPayload({
      pilgrims: [
        { id: 1, kind: 'wanderer', race: 'uno', x: 1, y: 2, heading: 3 },
        { id: 2, kind: 'merchant', race: 'rudy', x: 0, y: 0, heading: 0 },
      ],
    });
    expect(parsed).toEqual([
      {
        id: 1,
        kind: 'wanderer',
        race: 'uno',
        x: 1,
        y: 2,
        heading: 3,
        climbHeight: null,
        falling: false,
        stance: null,
      },
    ]);
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
    const ticks = Math.round(PILGRIMAGE_ONSET_SECONDS / TICK) + 3;
    let settled: ReturnType<SettlednessTracker['advance']> = [];
    for (let i = 0; i <= ticks; i++) {
      const wobble = (i % 2) * 2;
      settled = tracker.advance([{ id: 7, x: 50 + wobble, y: 50 }], TICK);
    }
    expect(settled).toEqual([{ monsterId: 7, x: 50, y: 50 }]);
  });

  it('re-anchors a wanderer and starts the clock over', () => {
    const tracker = new SettlednessTracker();
    runTracker(tracker, 50, 50, PILGRIMAGE_ONSET_SECONDS * 0.9);
    tracker.advance([{ id: 7, x: 50 + MONSTER_SETTLED_RADIUS_CELLS + 1, y: 50 }], TICK);
    const settled = runTracker(tracker, 50 + MONSTER_SETTLED_RADIUS_CELLS + 1, 50, PILGRIMAGE_ONSET_SECONDS * 0.9);
    expect(settled).toEqual([]);
  });

  it('forgets a monster missing from the feed', () => {
    const tracker = new SettlednessTracker();
    runTracker(tracker, 50, 50, PILGRIMAGE_ONSET_SECONDS);
    tracker.advance([], TICK);
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
    expect(isWalkableCell(world, 0, 50)).toBe(false);
    expect(isWalkableCell(world, -1, 50)).toBe(false);
    expect(isWalkableCell(world, 50, 1000)).toBe(false);
  });

  it('picks the highest walkable ring cell as the viewpoint, deterministically', () => {
    const size = cellsAcross(128);
    const ridgeX = 64 + VIEWPOINT_RING_CELLS;
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

  it('caps the crowd at PILGRIMS_CAP', () => {
    const world = islandWorld();
    const sim = new Pilgrimage();
    const towns: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < PILGRIMS_CAP + 8; i++) towns.push({ x: 34 + i, y: 60 });
    runSeconds(sim, world, [MONSTER], towns, PILGRIMAGE_ONSET_SECONDS + 1);
    expect(sim.populationCount()).toBe(PILGRIMS_CAP);
  });
});

describe('the wandering', () => {
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

  const TOWN = { x: cellsAcross(40), y: cellsAcross(60), age: WANDERER_MIN_AGE_GENERATIONS };
  const NEIGHBOUR = {
    x: cellsAcross(52),
    y: cellsAcross(60),
    age: WANDERER_MIN_AGE_GENERATIONS,
  };

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
    expect(sawTraffic).toBe(true);
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
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all.map((w) => w.id)).size).toBe(all.length);
  });
});

describe('the bridges', () => {
  beforeEach(() => {
    resetStructuresBridge();
    resetMonstersBridge();
    vi.restoreAllMocks();
  });

  it('degrades to an empty world and warns once when structures is not running', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = worldWithSibling('structures', null);
    loadStructuresBridge(world);
    loadStructuresBridge(world);
    expect(bridgedStructures()).toEqual([]);
    expect(applyBlessedCells([1])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(STRUCTURES_UNAVAILABLE_WARNING);
  });

  it('rejects a module of the wrong shape the same way', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadStructuresBridge(worldWithSibling('structures', { somethingElse: true }));
    expect(bridgedStructures()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('replays the buffered blessed set into a structures that starts later', () => {
    const seen: Array<readonly number[]> = [];
    loadStructuresBridge(worldWithSibling('structures', null));
    applyBlessedCells([42, 43]);
    expect(seen).toEqual([]);

    loadStructuresBridge(
      worldWithSibling('structures', {
        standingStructures: () => [],
        setBlessedStructureCells: (keys: readonly number[]) => {
          seen.push(keys);
        },
      }),
    );
    expect(seen).toEqual([[42, 43]]);
  });

  it('polls monsters through the bridge and re-validates rows structurally', () => {
    loadMonstersBridge(
      worldWithSibling('monsters', {
        monsterStates: () => [
          { id: 1, kind: 'kraken', x: 3, y: 4 },
          { id: 'bad', kind: 'kraken', x: 0, y: 0 },
          null,
        ],
      }),
    );
    expect(bridgedMonsters()).toEqual([{ id: 1, kind: 'kraken', x: 3, y: 4 }]);
  });
});

describe('a house sends a settler out (Settling.emitFrom)', () => {
  const HOUSE_X = 40;
  const HOUSE_Y = 40;

  beforeEach(() => {
    resetStructuresBridge();
  });

  it('respects SETTLERS_CAP — the temple’s cap, not a second one', () => {
    const world = islandWorld();
    const settling = new Settling();
    for (let i = 0; i < SETTLERS_CAP; i++) {
      expect(settling.emitFrom(world, HOUSE_X, HOUSE_Y)).toBe(true);
    }
    expect(settling.states().length).toBe(SETTLERS_CAP);
    expect(settling.emitFrom(world, HOUSE_X, HOUSE_Y)).toBe(false);
    expect(settling.states().length).toBe(SETTLERS_CAP);
  });
});
