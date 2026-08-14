// The monsters sim, driven through the REAL plugin host and the REAL intent
// pipeline — no stub for either, except where a stub is the only way to express
// the scenario (see the lair-collapse block, which says so on the spot).
//
// The load-bearing claims under test are the singleton and the gates: at most
// one monster exists, it arrives only as a stochastic event on a qualifying
// lair, losing its lair removes it, and neither a restart nor a thousand ticks
// can produce a second.

import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, MAX_BRUSH_RADIUS, SEA_LEVEL, isWater } from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin } from '../../../server/test/support/harness.ts';
import { MONSTERS_PLUGIN_NAME, MONSTERS_STATE_MESSAGE, type MonsterState } from '../protocol.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  DEEP_WATER_MAX_HEIGHT,
  type LairWorld,
  isDeepWaterHeight,
  isLairCell,
  surveyLairs,
} from '../server/habitat.ts';
import {
  BROADCAST_TICK_INTERVAL,
  monsterStates,
  plugin as monstersPlugin,
  resetMonstersState,
} from '../server/index.ts';
import {
  CTHULHU_FOOTPRINT_CELLS,
  CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
  CTHULHU_RESPAWN_COOLDOWN_SECONDS,
  CTHULHU_SUMMON_MEAN_WAIT_SECONDS,
  LAIR_COLLAPSE_DEEP_CELLS,
  MAX_LIVING_MONSTERS,
  MIN_LAIR_DEEP_CELLS,
  profileOf,
} from '../server/kinds.ts';
import { advanceMonster } from '../server/lurk.ts';
import { loadMonsters, saveMonsters } from '../server/persistence.ts';
import { setMonsterRandomSource } from '../server/rng.ts';
import {
  LAIR_SURVEY_INTERVAL_SECONDS,
  advanceSummoning,
  cooldownRemainingSeconds,
  livingMonster,
  livingMonsterCount,
} from '../server/summoning.ts';
import { seededRandom, worldWithTerrain } from './support/world.ts';

/** 128² cells = 8×8 chunks — room for a basin far larger than the minimum lair. */
const WORLD_SIZE = 128;
const WORLD_CENTER = WORLD_SIZE / 2;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

/**
 * A conical bowl centred on the map: height rises linearly with distance from
 * the centre and crosses sea level at `radius`.
 *
 * Slope is 8 height units per cell — a quarter of MAX_STEP — so the world
 * already satisfies the gradient limit and a sculpt anywhere in it produces a
 * small local diff instead of a map-wide relaxation cascade.
 *
 * The DEEP disc is therefore a circle of radius `radius - 24`, since 24 cells of
 * slope is exactly the three bands (192 units) of the deep-water threshold.
 */
const BOWL_SLOPE_PER_CELL = 8;

function bowl(radius: number): (x: number, y: number) => number {
  return (x, y) => {
    const dx = x - WORLD_CENTER;
    const dy = y - WORLD_CENTER;
    return Math.round((Math.sqrt(dx * dx + dy * dy) - radius) * BOWL_SLOPE_PER_CELL);
  };
}

/** Deep disc radius 26 → ~2 120 cells, comfortably over MIN_LAIR_DEEP_CELLS. */
const GREAT_BASIN_RADIUS = 50;
/** Deep disc radius 16 → ~800 cells: real deep water, but not a lair. */
const SMALL_POOL_RADIUS = 40;
/** No cell anywhere reaches the deep threshold. */
const NO_DEEP_WATER_RADIUS = 20;

const PLAYER: Player = { id: 'session-1', name: 'Tester' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

function boot(
  heightOf: (x: number, y: number) => number = bowl(GREAT_BASIN_RADIUS),
  isChunkLocked?: (cx: number, cy: number) => boolean,
): Harness {
  resetMonstersState();

  const world = worldWithTerrain(WORLD_SIZE, heightOf, isChunkLocked);
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [monstersPlugin].map(asLoadedPlugin));
  host.worldCreate();
  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

function tick(harness: Harness, times: number): void {
  for (let n = 0; n < times; n++) harness.host.tick(TICK_DT);
}

/**
 * The World as the plugin sees it. Core's World exposes `size`; the WorldApi the
 * host hands plugins renames it `worldSize`, so a test calling the plugin's own
 * predicates has to bridge that one field.
 */
function lairView(world: World): LairWorld {
  return {
    worldSize: world.size,
    heightAt: (x, y) => world.heightAt(x, y),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

/** Counts deep cells directly, as an independent check on the flood fill. */
function countDeepCells(
  heightOf: (x: number, y: number) => number,
  include: (x: number, y: number) => boolean = () => true,
): number {
  let count = 0;
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      if (isDeepWaterHeight(heightOf(x, y)) && include(x, y)) count++;
    }
  }
  return count;
}

/** A random source that always fires every Poisson gate. */
const ALWAYS = (): number => 0;
/** A random source that never fires any Poisson gate. */
const NEVER = (): number => 1;

beforeEach(() => {
  resetMonstersState();
  setMonsterRandomSource(null);
});

describe('deep water', () => {
  it('is three bands below sea level, restating wildlife\'s threshold', () => {
    expect(DEEP_WATER_BANDS_BELOW_SEA).toBe(3);
    expect(DEEP_WATER_MAX_HEIGHT).toBe(SEA_LEVEL - 3 * BAND_HEIGHT);
    // Whole bands: the threshold has to survive a BAND_HEIGHT retune as a
    // statement about terraces, not as a raw height. (`%` yields -0 for an exact
    // negative multiple, so compare with ===.)
    expect(DEEP_WATER_MAX_HEIGHT % BAND_HEIGHT === 0).toBe(true);
  });

  it('classifies the boundary the same way on both sides', () => {
    expect(isDeepWaterHeight(DEEP_WATER_MAX_HEIGHT)).toBe(true);
    expect(isDeepWaterHeight(DEEP_WATER_MAX_HEIGHT - 1)).toBe(true);
    expect(isDeepWaterHeight(DEEP_WATER_MAX_HEIGHT + 1)).toBe(false);
    expect(isDeepWaterHeight(SEA_LEVEL)).toBe(false);
  });

  it('is always water by shared\'s definition, never a second opinion about the sea', () => {
    for (let h = -1024; h <= 1024; h++) {
      if (isDeepWaterHeight(h)) expect(isWater(h)).toBe(true);
    }
  });
});

describe('lair survey', () => {
  it('counts a whole basin as one region and picks its deepest cell', () => {
    const heightOf = bowl(GREAT_BASIN_RADIUS);
    const harness = boot(heightOf);
    const survey = surveyLairs(lairView(harness.world));

    expect(survey.largestRegionCells).toBe(countDeepCells(heightOf));
    expect(survey.largestRegionCells).toBeGreaterThan(MIN_LAIR_DEEP_CELLS);
    // The bowl's floor is its centre.
    expect(survey.summonCell).toEqual({ x: WORLD_CENTER, y: WORLD_CENTER });
  });

  it('ignores locked territory entirely', () => {
    const heightOf = bowl(GREAT_BASIN_RADIUS);
    // The chunk containing the bowl's deepest point.
    const lockedCX = WORLD_CENTER / CHUNK_SIZE;
    const lockedCY = WORLD_CENTER / CHUNK_SIZE;
    const inLockedChunk = (x: number, y: number): boolean =>
      Math.floor(x / CHUNK_SIZE) === lockedCX && Math.floor(y / CHUNK_SIZE) === lockedCY;

    const harness = boot(heightOf, (cx, cy) => cx === lockedCX && cy === lockedCY);
    const survey = surveyLairs(lairView(harness.world));

    // The basin minus one chunk is still a single connected region (the notch is
    // interior, and the water goes round it).
    expect(survey.largestRegionCells).toBe(
      countDeepCells(heightOf, (x, y) => !inLockedChunk(x, y)),
    );
    expect(survey.summonCell).not.toBeNull();
    expect(inLockedChunk(survey.summonCell!.x, survey.summonCell!.y)).toBe(false);
  });

  it('reports nothing when there is no deep water', () => {
    const harness = boot(bowl(NO_DEEP_WATER_RADIUS));
    const survey = surveyLairs(lairView(harness.world));
    expect(survey.largestRegionCells).toBe(0);
    expect(survey.summonCell).toBeNull();
  });

  it('reports the size of the region under the queried cell, not the biggest one', () => {
    const harness = boot(bowl(GREAT_BASIN_RADIUS));
    const view = lairView(harness.world);

    const inside = surveyLairs(view, { x: WORLD_CENTER, y: WORLD_CENTER });
    expect(inside.occupiedRegionCells).toBe(inside.largestRegionCells);

    // A cell on dry land belongs to no region at all.
    const outside = surveyLairs(view, { x: 0, y: 0 });
    expect(outside.occupiedRegionCells).toBe(0);
    expect(outside.largestRegionCells).toBeGreaterThan(0);
  });
});

describe('the arrival gates', () => {
  it('never summons while the roll does not fire, however long the world runs', () => {
    setMonsterRandomSource(NEVER);
    const harness = boot();
    // 10 simulated minutes — 2.5 mean waits.
    tick(harness, 6000);
    expect(livingMonster()).toBeNull();
  });

  it('never summons into deep water too small to be a lair, however the roll falls', () => {
    setMonsterRandomSource(ALWAYS);
    const smallPool = bowl(SMALL_POOL_RADIUS);
    expect(countDeepCells(smallPool)).toBeGreaterThan(0);
    expect(countDeepCells(smallPool)).toBeLessThan(MIN_LAIR_DEEP_CELLS);

    const harness = boot(smallPool);
    tick(harness, 600);
    expect(livingMonster()).toBeNull();
  });

  it('never summons where there is no deep water at all', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(NO_DEEP_WATER_RADIUS));
    tick(harness, 600);
    expect(livingMonster()).toBeNull();
  });

  it('summons ONE monster when every gate opens, and never a second', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();

    tick(harness, 1);
    const monster = livingMonster();
    expect(monster).not.toBeNull();
    expect(monster!.kind).toBe('cthulhu');
    const id = monster!.id;

    // Five simulated minutes of a roll that fires on EVERY tick. If anything in
    // the spawn path could add a second monster, three thousand chances is where
    // it shows up.
    tick(harness, 3000);
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS);
    expect(livingMonster()!.id).toBe(id);
  });

  it('summons into deep, unlocked water', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);

    const monster = livingMonster();
    expect(monster).not.toBeNull();
    expect(isLairCell(lairView(harness.world), monster!.x, monster!.y)).toBe(true);
  });
});

describe('the summon roll', () => {
  it('arrives exactly once over a long seeded run, at a plausible moment', () => {
    setMonsterRandomSource(seededRandom(20260814));
    const harness = boot();

    let arrivals = 0;
    let arrivalSeconds = 0;
    let seenId: number | null = null;
    // 40 simulated minutes = 10 mean waits.
    for (let n = 0; n < 24000; n++) {
      tick(harness, 1);
      const monster = livingMonster();
      if (monster === null || monster.id === seenId) continue;
      arrivals++;
      seenId = monster.id;
      arrivalSeconds = (n + 1) * TICK_DT;
    }

    expect(arrivals).toBe(1);
    // Not on the first tick (it is a roll, not boot inventory) and not absurdly
    // late. The bounds are wide on purpose: this pins the SHAPE — a stochastic
    // arrival on the order of the configured mean — not one seed's exact draw.
    expect(arrivalSeconds).toBeGreaterThan(TICK_DT);
    expect(arrivalSeconds).toBeLessThan(CTHULHU_SUMMON_MEAN_WAIT_SECONDS * 10);
  });

  it('waits about the configured mean across many seeded worlds', () => {
    // The rate is derived from CTHULHU_SUMMON_MEAN_WAIT_SECONDS through the
    // exponential form in rollEvent; this is the test that the derivation is
    // real and not just a comment. Deterministic: one seed drives every trial.
    const random = seededRandom(7);
    const TRIALS = 24;
    const CAP_SECONDS = CTHULHU_SUMMON_MEAN_WAIT_SECONDS * 12;

    let total = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      setMonsterRandomSource(random);
      const harness = boot();
      let waited = 0;
      while (livingMonster() === null && waited < CAP_SECONDS) {
        tick(harness, 1);
        waited += TICK_DT;
      }
      expect(livingMonster()).not.toBeNull();
      total += waited;
    }

    const mean = total / TRIALS;
    // ±2.4 standard errors of an exponential mean at n = 24 (SE = mean/√n).
    expect(mean).toBeGreaterThan(CTHULHU_SUMMON_MEAN_WAIT_SECONDS * 0.5);
    expect(mean).toBeLessThan(CTHULHU_SUMMON_MEAN_WAIT_SECONDS * 2);
  });
});

describe('losing the lair', () => {
  /** Ticks a harness until it holds a monster, with a bounded number of tries. */
  function summonNow(harness: Harness): number {
    setMonsterRandomSource(ALWAYS);
    tick(harness, 1);
    const monster = livingMonster();
    expect(monster).not.toBeNull();
    return monster!.id;
  }

  it('submerges when the ground is raised out from under it, and starts the cooldown', () => {
    const harness = boot();
    summonNow(harness);
    // Stop the roll: this test is about the departure, and an always-firing roll
    // would re-summon it the moment the cooldown is examined.
    setMonsterRandomSource(NEVER);

    const cellX = Math.floor(livingMonster()!.x);
    const cellY = Math.floor(livingMonster()!.y);

    // Raise its own cell out of the deep. No ticks in between, so it cannot swim
    // away — this is specifically the "the world changed under it" case.
    for (let n = 0; n < 40 && isDeepWaterHeight(harness.world.heightAt(cellX, cellY)); n++) {
      handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        {
          type: 'sculpt',
          x: cellX,
          y: cellY,
          radius: MAX_BRUSH_RADIUS,
          dir: 1,
          tool: 'stamp',
          profile: 'hard',
        },
      );
    }

    expect(isDeepWaterHeight(harness.world.heightAt(cellX, cellY))).toBe(false);
    // The terrain reaction fires inside the sculpt — no tick needed.
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds()).toBe(CTHULHU_RESPAWN_COOLDOWN_SECONDS);
  });

  it('refuses to summon again until the cooldown is served, then summons exactly one', () => {
    const harness = boot();
    const firstId = summonNow(harness);

    const cellX = Math.floor(livingMonster()!.x);
    const cellY = Math.floor(livingMonster()!.y);
    for (let n = 0; n < 40 && isDeepWaterHeight(harness.world.heightAt(cellX, cellY)); n++) {
      handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        {
          type: 'sculpt',
          x: cellX,
          y: cellY,
          radius: MAX_BRUSH_RADIUS,
          dir: 1,
          tool: 'stamp',
          profile: 'hard',
        },
      );
    }
    expect(livingMonster()).toBeNull();

    // A roll that fires on every single tick, for one second short of the
    // cooldown. The gate is the only thing holding it back.
    setMonsterRandomSource(ALWAYS);
    tick(harness, (CTHULHU_RESPAWN_COOLDOWN_SECONDS - 2) / TICK_DT);
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds()).toBeGreaterThan(0);

    tick(harness, 3 / TICK_DT);
    expect(livingMonsterCount()).toBe(1);
    // A NEW monster, not the old one restored: ids are never reused.
    expect(livingMonster()!.id).toBeGreaterThan(firstId);
  });

  it('submerges when its own basin collapses, even while its own cell stays deep', () => {
    // THE ONE STUBBED WORLD IN THIS FILE, and why: the collapse rule is about a
    // REGION shrinking below LAIR_COLLAPSE_DEEP_CELLS, and a sculpt reaches
    // MAX_BRUSH_RADIUS (4) cells. Draining a 2 000-cell basin through the intent
    // pipeline would be hundreds of intents of setup to exercise one comparison.
    // The world is stubbed; the plugin's own lifecycle code is not.
    let basinRadius = 30;
    const world: LairWorld = {
      worldSize: WORLD_SIZE,
      heightAt(x, y) {
        const dx = x - WORLD_CENTER;
        const dy = y - WORLD_CENTER;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > basinRadius) return BAND_HEIGHT;
        // Deepest at the centre, so the survey's summon cell is the middle of
        // the basin and not a rim cell that the shrink would strand.
        return DEEP_WATER_MAX_HEIGHT - (basinRadius - distance);
      },
      isCellUnlocked: () => true,
    };

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    expect(livingMonster()).not.toBeNull();

    // Shrink the basin to a pool far below the collapse threshold, while leaving
    // the cell the monster is standing in deep — so the ONLY thing that can
    // banish it is the region test.
    basinRadius = 4;
    expect(Math.PI * basinRadius * basinRadius).toBeLessThan(LAIR_COLLAPSE_DEEP_CELLS);
    expect(isLairCell(world, livingMonster()!.x, livingMonster()!.y)).toBe(true);

    // Survey cadence: the collapse is noticed on the next survey, not instantly.
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds()).toBeGreaterThan(0);
  });
});

describe('persistence', () => {
  it('round-trips the monster and the cooldown', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 30);

    const before = livingMonster()!;
    const snapshot = JSON.parse(JSON.stringify(saveMonsters())) as unknown;

    resetMonstersState();
    expect(livingMonster()).toBeNull();

    loadMonsters(snapshot);
    const after = livingMonster();
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before.id);
    expect(after!.kind).toBe(before.kind);
    expect(after!.x).toBeCloseTo(before.x, 10);
    expect(after!.y).toBeCloseTo(before.y, 10);
    expect(after!.heading).toBeCloseTo(before.heading, 10);
  });

  it('keeps a banished monster banished across a restart', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);

    const cellX = Math.floor(livingMonster()!.x);
    const cellY = Math.floor(livingMonster()!.y);
    for (let n = 0; n < 40 && isDeepWaterHeight(harness.world.heightAt(cellX, cellY)); n++) {
      handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        {
          type: 'sculpt',
          x: cellX,
          y: cellY,
          radius: MAX_BRUSH_RADIUS,
          dir: 1,
          tool: 'stamp',
          profile: 'hard',
        },
      );
    }
    const snapshot = saveMonsters();
    expect(snapshot.monster).toBeNull();
    expect(snapshot.cooldownSeconds).toBe(CTHULHU_RESPAWN_COOLDOWN_SECONDS);

    // Reboot onto the same world. Without the persisted cooldown, the very next
    // tick would roll for a fresh monster — a restart would be a way to skip the
    // banishment.
    const rebooted = boot();
    loadMonsters(JSON.parse(JSON.stringify(snapshot)) as unknown);
    tick(rebooted, 100);
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds()).toBeGreaterThan(0);
  });

  it('cannot be made to hold two monsters by a restart', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 30);
    const snapshot = JSON.parse(JSON.stringify(saveMonsters())) as unknown;
    const id = livingMonster()!.id;

    // Boot a fresh world, restore the snapshot into it, then run it hard with a
    // roll that fires every tick. The restored monster occupies the slot; the
    // gate is the slot itself.
    const rebooted = boot();
    loadMonsters(snapshot);
    tick(rebooted, 2000);

    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS);
    expect(livingMonster()!.id).toBe(id);
  });

  it('degrades to an empty, uncooled world on a corrupt slice', () => {
    const corrupt: unknown[] = [
      null,
      undefined,
      42,
      {},
      { version: 999, monster: { id: 1, kind: 'cthulhu', x: 1, y: 1, heading: 0 } },
      { version: 1, monster: { id: 0, kind: 'cthulhu', x: 1, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: { id: 1, kind: 'dagon', x: 1, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: { id: 1, kind: 'cthulhu', x: NaN, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: 'yes', nextId: 2 },
    ];

    for (const slice of corrupt) {
      resetMonstersState();
      loadMonsters(slice);
      expect(livingMonster()).toBeNull();
      // No invented banishment: a bad byte must not suppress arrivals.
      expect(cooldownRemainingSeconds()).toBe(0);
    }
  });

  it('clamps a nonsense cooldown instead of trusting it', () => {
    for (const cooldownSeconds of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      resetMonstersState();
      loadMonsters({ version: 1, monster: null, nextId: 3, cooldownSeconds });
      expect(cooldownRemainingSeconds()).toBe(0);
    }
  });

  it('never reuses an id after a restore, even from a garbage counter', () => {
    resetMonstersState();
    loadMonsters({
      version: 1,
      nextId: 'nonsense',
      cooldownSeconds: 0,
      monster: { id: 9, kind: 'cthulhu', x: WORLD_CENTER, y: WORLD_CENTER, heading: 0 },
    });
    expect(livingMonster()!.id).toBe(9);

    // Banish it and let the world summon another: the new id must be past the
    // restored one.
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    loadMonsters({
      version: 1,
      nextId: 'nonsense',
      cooldownSeconds: 0,
      monster: { id: 9, kind: 'cthulhu', x: 0, y: 0, heading: 0 },
    });
    // (0, 0) is dry land in the bowl, so the first tick's habitat check removes
    // it — which is also the "restored onto a changed world" path.
    tick(harness, 1);
    expect(cooldownRemainingSeconds()).toBeGreaterThan(0);

    tick(harness, CTHULHU_RESPAWN_COOLDOWN_SECONDS / TICK_DT + 2);
    expect(livingMonster()).not.toBeNull();
    expect(livingMonster()!.id).toBeGreaterThan(9);
  });
});

describe('broadcast', () => {
  function stateMessages(harness: Harness): MonsterState[][] {
    return harness.sink
      .ofType(`${MONSTERS_PLUGIN_NAME}:${MONSTERS_STATE_MESSAGE}`)
      .map((message) => (message.payload as { monsters: MonsterState[] }).monsters);
  }

  it('pushes full state on a 1 Hz cadence', () => {
    setMonsterRandomSource(NEVER);
    const harness = boot();
    harness.sink.clear();

    const TICKS = 100;
    tick(harness, TICKS);
    expect(stateMessages(harness)).toHaveLength(TICKS / BROADCAST_TICK_INTERVAL);
    // 10 ticks at TICK_HZ 10 is one second.
    expect(BROADCAST_TICK_INTERVAL * TICK_DT).toBe(1);
  });

  it('broadcasts an empty list while nothing is out there', () => {
    setMonsterRandomSource(NEVER);
    const harness = boot();
    harness.sink.clear();
    tick(harness, BROADCAST_TICK_INTERVAL);

    const messages = stateMessages(harness);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual([]);
  });

  it('broadcasts one entry, at wire precision, while the monster is alive', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);
    harness.sink.clear();
    tick(harness, BROADCAST_TICK_INTERVAL);

    const messages = stateMessages(harness);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toHaveLength(1);

    const [entry] = messages[0];
    expect(entry.kind).toBe('cthulhu');
    expect(entry.id).toBe(livingMonster()!.id);
    expect(Object.keys(entry).sort()).toEqual(['heading', 'id', 'kind', 'x', 'y']);
    for (const value of [entry.x, entry.y, entry.heading]) {
      expect(Number.isInteger(Math.round(value * 100))).toBe(true);
      expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-9);
    }
  });

  it('reports the empty list from monsterStates when the slot is empty', () => {
    expect(monsterStates()).toEqual([]);
  });
});

describe('lurking', () => {
  it('never leaves deep unlocked water, over a long run', () => {
    const harness = boot();
    setMonsterRandomSource(ALWAYS);
    tick(harness, 1);
    setMonsterRandomSource(seededRandom(99));

    const view = lairView(harness.world);
    // Ten simulated minutes of wandering.
    for (let n = 0; n < 6000; n++) {
      tick(harness, 1);
      const monster = livingMonster();
      expect(monster).not.toBeNull();
      expect(isLairCell(view, monster!.x, monster!.y)).toBe(true);
    }
  });

  it('moves no further than its lurk speed allows in one tick', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);
    setMonsterRandomSource(seededRandom(5));

    let previous = { x: livingMonster()!.x, y: livingMonster()!.y };
    for (let n = 0; n < 600; n++) {
      tick(harness, 1);
      const monster = livingMonster()!;
      const step = Math.hypot(monster.x - previous.x, monster.y - previous.y);
      expect(step).toBeLessThanOrEqual(CTHULHU_LURK_SPEED_CELLS_PER_SECOND * TICK_DT + 1e-9);
      previous = { x: monster.x, y: monster.y };
    }
  });

  it('lurks slower than anything the wildlife plugin puts in the water', () => {
    // The wildlife whale cruises at 0.8 cells/s (plugins/wildlife/server/
    // species.ts) and is the slowest creature there. Cross-referenced, not
    // imported: plugins must not depend on each other for a number.
    const WILDLIFE_WHALE_CRUISE_CELLS_PER_SECOND = 0.8;
    expect(CTHULHU_LURK_SPEED_CELLS_PER_SECOND).toBeLessThan(
      WILDLIFE_WHALE_CRUISE_CELLS_PER_SECOND,
    );
  });

  it('holds position during an idle beat but still turns', () => {
    const world = lairView(worldWithTerrain(WORLD_SIZE, bowl(GREAT_BASIN_RADIUS)));
    const profile = profileOf('cthulhu');
    const monster = {
      id: 1,
      kind: 'cthulhu' as const,
      x: WORLD_CENTER,
      y: WORLD_CENTER,
      heading: 0,
      idle: false,
    };

    // A source that fires every gate: the first step flips it into the idle beat
    // and the step after that is the one under test.
    setMonsterRandomSource(ALWAYS);
    advanceMonster(world, monster, TICK_DT);
    expect(monster.idle).toBe(true);

    const held = { x: monster.x, y: monster.y, heading: monster.heading };
    // Keep it idle for this step: NEVER never fires the "wake up" gate.
    setMonsterRandomSource(NEVER);
    advanceMonster(world, monster, TICK_DT);

    expect(monster.idle).toBe(true);
    expect(monster.x).toBe(held.x);
    expect(monster.y).toBe(held.y);
    // It still turns: NEVER returns 1, so the noise term is +turnNoise·dt.
    expect(monster.heading).toBeCloseTo(
      held.heading + profile.turnNoiseRadiansPerSecond * TICK_DT,
      10,
    );
  });

  it('spends roughly the designed share of its time holding still', () => {
    // The two idle rates are a Markov pair whose steady state is
    // onset/(onset + end) — 0.05/0.17 ≈ 29% (see the note in kinds.ts). This is
    // the test that the pair actually produces the beats they claim to, rather
    // than a comment about arithmetic nobody ran.
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);
    setMonsterRandomSource(seededRandom(99));

    const profile = profileOf('cthulhu');
    const predicted =
      profile.idleOnsetPerSecond / (profile.idleOnsetPerSecond + profile.idleEndPerSecond);

    const SAMPLES = 6000;
    let idleTicks = 0;
    for (let n = 0; n < SAMPLES; n++) {
      tick(harness, 1);
      if (livingMonster()!.idle) idleTicks++;
    }

    const observed = idleTicks / SAMPLES;
    expect(predicted).toBeCloseTo(0.29, 2);
    // Ten simulated minutes holds only ~30 beats, so the sampling error is
    // real: the bound is ±0.15, wide enough for the draw and far too tight for
    // a plugin that had lost its idle beats or never left them.
    expect(Math.abs(observed - predicted)).toBeLessThan(0.15);
  });

  it('probes at least half its own body ahead', () => {
    // The look-ahead is what keeps a 7-cell-wide body out of cliffs its centre
    // point would clear. Pinning it here because the failure it prevents is
    // invisible in a unit test of movement: the model clipping terrain.
    expect(CTHULHU_FOOTPRINT_CELLS / 2).toBeGreaterThan(
      CTHULHU_LURK_SPEED_CELLS_PER_SECOND * TICK_DT,
    );
  });
});
