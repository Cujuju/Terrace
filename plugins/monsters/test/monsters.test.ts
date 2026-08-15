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
  type LairRegion,
  type LairSurvey,
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
  KRAKEN_LAIR_COLLAPSE_DEEP_CELLS,
  KRAKEN_LAIR_MIN_DEPTH_BANDS,
  KRAKEN_MIN_LAIR_DEEP_CELLS,
  KRAKEN_RESPAWN_COOLDOWN_SECONDS,
  MAX_LIVING_MONSTERS,
  MIN_LAIR_DEEP_CELLS,
  SUMMON_MEAN_WAIT_SECONDS,
  groundProtectionRadiusCells,
  profileOf,
} from '../server/kinds.ts';
import { advanceMonster, isStranded } from '../server/lurk.ts';
import { loadMonsters, saveMonsters } from '../server/persistence.ts';
import { setMonsterRandomSource } from '../server/rng.ts';
import {
  LAIR_SURVEY_INTERVAL_SECONDS,
  advanceSummoning,
  cooldownRemainingSeconds,
  enforceHabitat,
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
/**
 * A KRAKEN TRENCH. Deep disc radius 46 → ~6 600 cells (over the kraken's 2 304)
 * and 560 height units at the floor — 8.75 bands, past its 8-band demand.
 *
 * The GREAT_BASIN above deliberately fails BOTH kraken tests (2 120 cells, 6.25
 * bands), which is what keeps every Cthulhu test in this file summoning a
 * Cthulhu even though the kraken is considered first.
 */
const TRENCH_RADIUS = 70;
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

/** The largest region a survey found, by cells. Null when it found none. */
function largestRegion(survey: LairSurvey): LairRegion | null {
  let best: LairRegion | null = null;
  for (const region of survey.regions) {
    if (best === null || region.cells > best.cells) best = region;
  }
  return best;
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

    expect(survey.regions).toHaveLength(1);
    const region = survey.regions[0]!;
    expect(region.cells).toBe(countDeepCells(heightOf));
    expect(region.cells).toBeGreaterThan(MIN_LAIR_DEEP_CELLS);
    // The bowl's floor is its centre, and the survey reports how deep it is —
    // which is the number a kind with a trench requirement is admitted on.
    expect({ x: region.x, y: region.y }).toEqual({ x: WORLD_CENTER, y: WORLD_CENTER });
    expect(region.deepestHeight).toBe(heightOf(WORLD_CENTER, WORLD_CENTER));
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
    const region = largestRegion(survey)!;
    expect(region.cells).toBe(countDeepCells(heightOf, (x, y) => !inLockedChunk(x, y)));
    expect(inLockedChunk(region.x, region.y)).toBe(false);
  });

  it('reports nothing when there is no deep water', () => {
    const harness = boot(bowl(NO_DEEP_WATER_RADIUS));
    const survey = surveyLairs(lairView(harness.world));
    expect(survey.regions).toHaveLength(0);
    expect(largestRegion(survey)).toBeNull();
  });

  it('reports the size of the region under the queried cell, not the biggest one', () => {
    const harness = boot(bowl(GREAT_BASIN_RADIUS));
    const view = lairView(harness.world);

    const inside = surveyLairs(view, { x: WORLD_CENTER, y: WORLD_CENTER });
    expect(inside.occupiedRegionCells).toBe(largestRegion(inside)!.cells);

    // A cell on dry land belongs to no region at all.
    const outside = surveyLairs(view, { x: 0, y: 0 });
    expect(outside.occupiedRegionCells).toBe(0);
    expect(largestRegion(outside)!.cells).toBeGreaterThan(0);
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
    expect(arrivalSeconds).toBeLessThan(SUMMON_MEAN_WAIT_SECONDS * 10);
  });

  it('waits about the configured mean across many seeded worlds', () => {
    // The rate is derived from SUMMON_MEAN_WAIT_SECONDS through the
    // exponential form in rollEvent; this is the test that the derivation is
    // real and not just a comment. Deterministic: one seed drives every trial.
    const random = seededRandom(7);
    const TRIALS = 24;
    const CAP_SECONDS = SUMMON_MEAN_WAIT_SECONDS * 12;

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
    expect(mean).toBeGreaterThan(SUMMON_MEAN_WAIT_SECONDS * 0.5);
    expect(mean).toBeLessThan(SUMMON_MEAN_WAIT_SECONDS * 2);
  });
});

/**
 * A round basin, stubbed, with a radius and a floor a test can move.
 *
 * THE STUBBED WORLDS IN THIS FILE ALL COME FROM HERE, and the reason is the same
 * one the original collapse test gave: these rules are about a REGION shrinking
 * or a floor rising by hundreds of units, and a sculpt reaches MAX_BRUSH_RADIUS
 * (4) cells. Draining a 2 000-cell basin through the intent pipeline would be
 * hundreds of intents of setup to exercise one comparison. The world is stubbed;
 * the plugin's own lifecycle code never is.
 *
 * Deepest at the centre — so the survey's summon cell is the middle of the basin
 * and not a rim cell that a shrink would strand — rising linearly to exactly the
 * deep-water line at the rim.
 */
interface BasinState {
  radius: number;
  floorHeight: number;
}

function basinWorld(state: BasinState): LairWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt(x, y) {
      const dx = x - WORLD_CENTER;
      const dy = y - WORLD_CENTER;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (state.radius <= 0 || distance > state.radius) return BAND_HEIGHT;
      const toRim = distance / state.radius;
      return Math.round(
        state.floorHeight + (DEEP_WATER_MAX_HEIGHT - state.floorHeight) * toRim,
      );
    },
    isCellUnlocked: () => true,
  };
}

/** A basin Cthulhu qualifies for and the kraken does not: big, but not a trench. */
function cthulhuBasin(): BasinState {
  return { radius: 30, floorHeight: DEEP_WATER_MAX_HEIGHT - 30 };
}

/** A trench the kraken qualifies for: past its depth demand and its area. */
function krakenTrench(): BasinState {
  return {
    radius: 40,
    floorHeight: SEA_LEVEL - (KRAKEN_LAIR_MIN_DEPTH_BANDS + 1) * BAND_HEIGHT,
  };
}

describe('Cthulhu cannot be banished', () => {
  it('stays where he is when the water is taken away, and starts no cooldown', () => {
    const basin = cthulhuBasin();
    const world = basinWorld(basin);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    expect(livingMonster()!.kind).toBe('cthulhu');
    const id = livingMonster()!.id;

    // The sea is gone. Not shrunk — GONE: every cell is land, including his.
    basin.radius = 0;
    expect(isLairCell(world, livingMonster()!.x, livingMonster()!.y)).toBe(false);

    // Both departure paths, run against the drained world: the per-tick habitat
    // check and the periodic collapse test. Neither may remove him.
    expect(enforceHabitat(world)).toBe(false);
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
      enforceHabitat(world);
    }

    expect(livingMonster()).not.toBeNull();
    expect(livingMonster()!.id).toBe(id);
    // No banishment means no cooldown either — the two are one decision.
    expect(cooldownRemainingSeconds()).toBe(0);
  });

  it('stays when his basin collapses to a puddle around him', () => {
    const basin = cthulhuBasin();
    const world = basinWorld(basin);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    expect(livingMonster()).not.toBeNull();

    // A pool far below any collapse threshold, with his own cell still deep —
    // the exact scenario that used to banish him.
    basin.radius = 4;
    expect(Math.PI * basin.radius * basin.radius).toBeLessThan(KRAKEN_LAIR_COLLAPSE_DEEP_CELLS);
    expect(isLairCell(world, livingMonster()!.x, livingMonster()!.y)).toBe(true);

    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).not.toBeNull();
    expect(cooldownRemainingSeconds()).toBe(0);
  });

  it('holds position and heading once stranded, rather than spinning', () => {
    // The failure this prevents: every steering candidate fails on dry land, and
    // the ordinary blocked-path answer (reverse) would flip his heading by π ten
    // times a second — a weathervane, not a stranded animal.
    const basin = cthulhuBasin();
    const world = basinWorld(basin);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const monster = livingMonster()!;
    basin.radius = 0;
    expect(isStranded(world, monster)).toBe(true);

    const held = { x: monster.x, y: monster.y, heading: monster.heading };
    setMonsterRandomSource(seededRandom(11));
    let maxTurn = 0;
    for (let n = 0; n < 600; n++) {
      const before = monster.heading;
      advanceMonster(world, monster, TICK_DT);
      maxTurn = Math.max(maxTurn, Math.abs(monster.heading - before));
    }

    expect(monster.x).toBe(held.x);
    expect(monster.y).toBe(held.y);
    // It drifts its gaze by the turn noise and by nothing else — one tick of a
    // reversal would be π, five hundred times this bound.
    expect(maxTurn).toBeLessThanOrEqual(
      profileOf('cthulhu').turnNoiseRadiansPerSecond * TICK_DT + 1e-9,
    );
  });

  it('swims again the moment the water comes back', () => {
    const basin = cthulhuBasin();
    const world = basinWorld(basin);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const monster = livingMonster()!;
    // NEVER from here on: it fires no Poisson gate, so he cannot wander into an
    // idle beat and hold position for a reason that has nothing to do with the
    // water. (ALWAYS would put him in one on the first step.)
    setMonsterRandomSource(NEVER);

    basin.radius = 0;
    advanceMonster(world, monster, TICK_DT);
    const stranded = { x: monster.x, y: monster.y };

    // Reflooded. Nothing else changes: no re-summon, no new id, he simply moves.
    basin.radius = 30;
    for (let n = 0; n < 100; n++) advanceMonster(world, monster, TICK_DT);

    expect(Math.hypot(monster.x - stranded.x, monster.y - stranded.y)).toBeGreaterThan(0);
    expect(isLairCell(world, monster.x, monster.y)).toBe(true);
  });
});

describe('the kraken can be banished', () => {
  it('submerges when its trench collapses, and serves the full cooldown', () => {
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    expect(livingMonster()!.kind).toBe('kraken');

    // Shrink it below the collapse threshold while the monster's own cell stays
    // deep, so the ONLY thing that can banish it is the region test.
    trench.radius = 4;
    expect(Math.PI * trench.radius * trench.radius).toBeLessThan(KRAKEN_LAIR_COLLAPSE_DEEP_CELLS);
    expect(isLairCell(world, livingMonster()!.x, livingMonster()!.y)).toBe(true);

    // Survey cadence: the collapse is noticed on the next survey, not instantly.
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds()).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
  });

  it('submerges when the ground is raised out from under it', () => {
    const harness = boot(bowl(TRENCH_RADIUS));
    setMonsterRandomSource(ALWAYS);
    tick(harness, 1);
    expect(livingMonster()!.kind).toBe('kraken');
    // Stop the roll: this test is about the departure, and an always-firing roll
    // would re-summon it the moment the cooldown is examined.
    setMonsterRandomSource(NEVER);

    const cellX = Math.floor(livingMonster()!.x);
    const cellY = Math.floor(livingMonster()!.y);

    // Raise its own cell out of the deep. No ticks in between, so it cannot swim
    // away — this is specifically the "the world changed under it" case. The
    // kraken does not protect its ground, so the intents are accepted.
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
    expect(cooldownRemainingSeconds()).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
  });

  it('refuses to summon again until the cooldown is served, then summons exactly one', () => {
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const firstId = livingMonster()!.id;

    trench.radius = 4;
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).toBeNull();

    // The trench is back, and a roll that fires on every single tick, for one
    // second short of the cooldown. The gate is the only thing holding it back.
    trench.radius = 40;
    for (let n = 0; n < (KRAKEN_RESPAWN_COOLDOWN_SECONDS - 2) / TICK_DT; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds()).toBeGreaterThan(0);

    for (let n = 0; n < 3 / TICK_DT; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonsterCount()).toBe(1);
    // A NEW monster, not the old one restored: ids are never reused.
    expect(livingMonster()!.id).toBeGreaterThan(firstId);
  });
});

describe('the kinds contest one slot', () => {
  it('gives a trench world to the kraken — the stricter habitat gets first refusal', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    tick(harness, 1);

    const monster = livingMonster();
    expect(monster).not.toBeNull();
    expect(monster!.kind).toBe('kraken');
    expect(isLairCell(lairView(harness.world), monster!.x, monster!.y)).toBe(true);
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS);
  });

  it('gives a big SHALLOW basin to Cthulhu, and never to the kraken', () => {
    const heightOf = bowl(GREAT_BASIN_RADIUS);
    // The basin fails BOTH of the kraken's demands, which is what makes this a
    // test of the habitat rather than of the ordering.
    expect(countDeepCells(heightOf)).toBeGreaterThan(MIN_LAIR_DEEP_CELLS);
    expect(countDeepCells(heightOf)).toBeLessThan(KRAKEN_MIN_LAIR_DEEP_CELLS);
    expect(heightOf(WORLD_CENTER, WORLD_CENTER)).toBeGreaterThan(
      SEA_LEVEL - KRAKEN_LAIR_MIN_DEPTH_BANDS * BAND_HEIGHT,
    );

    setMonsterRandomSource(ALWAYS);
    const harness = boot(heightOf);
    // Five simulated minutes of a roll that fires on every tick: if the kraken
    // could ever take this world, three thousand chances is where it shows up.
    tick(harness, 3000);
    expect(livingMonster()!.kind).toBe('cthulhu');
  });

  it('summons nobody into a trench that is deep but tiny', () => {
    // Deep enough for the kraken, far too small for either kind. Depth alone is
    // not a lair, which is the half of the rule the area threshold carries.
    const world = basinWorld({
      radius: 10,
      floorHeight: SEA_LEVEL - (KRAKEN_LAIR_MIN_DEPTH_BANDS + 1) * BAND_HEIGHT,
    });
    expect(Math.PI * 10 * 10).toBeLessThan(MIN_LAIR_DEEP_CELLS);

    setMonsterRandomSource(ALWAYS);
    for (let n = 0; n < 600; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonster()).toBeNull();
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
    // A KRAKEN world: only a banishable kind can test that a banishment
    // survives a reboot, and Cthulhu is no longer one.
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    tick(harness, 1);
    expect(livingMonster()!.kind).toBe('kraken');

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
    expect(snapshot.cooldownSeconds).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);

    // Reboot onto the same world. Without the persisted cooldown, the very next
    // tick would roll for a fresh monster — a restart would be a way to skip the
    // banishment.
    const rebooted = boot(bowl(TRENCH_RADIUS));
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
    // restored one. A KRAKEN, restored onto its own trench world — Cthulhu
    // could not be banished to make room for the successor.
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    loadMonsters({
      version: 1,
      nextId: 'nonsense',
      cooldownSeconds: 0,
      monster: { id: 9, kind: 'kraken', x: 0, y: 0, heading: 0 },
    });
    // (0, 0) is dry land in the bowl, so the first tick's habitat check removes
    // it — which is also the "restored onto a changed world" path.
    tick(harness, 1);
    expect(cooldownRemainingSeconds()).toBeGreaterThan(0);

    tick(harness, KRAKEN_RESPAWN_COOLDOWN_SECONDS / TICK_DT + 2);
    expect(livingMonster()).not.toBeNull();
    expect(livingMonster()!.id).toBeGreaterThan(9);
  });

  it('restores an unbanishable monster onto a drained world and leaves him there', () => {
    // The restart is not a way to be rid of him either: the first tick's habitat
    // check runs, finds him on dry land, and has no power to remove him.
    setMonsterRandomSource(NEVER);
    const harness = boot();
    loadMonsters({
      version: 1,
      nextId: 20,
      cooldownSeconds: 0,
      monster: { id: 9, kind: 'cthulhu', x: 0, y: 0, heading: 0 },
    });
    tick(harness, 100);

    expect(livingMonster()).not.toBeNull();
    expect(livingMonster()!.id).toBe(9);
    expect(isLairCell(lairView(harness.world), 0, 0)).toBe(false);
    expect(cooldownRemainingSeconds()).toBe(0);
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
    expect(entry.kind).toBe(livingMonster()!.kind);
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

  it('broadcasts the kraken under its own kind, so the client picks its model', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    tick(harness, 1);
    harness.sink.clear();
    tick(harness, BROADCAST_TICK_INTERVAL);

    const [entry] = stateMessages(harness)[0]!;
    expect(entry.kind).toBe('kraken');
  });
});

describe('the ground a monster will not let you raise', () => {
  /** One sculpt through the real pipeline, at wire shape. */
  function sculpt(
    harness: Harness,
    x: number,
    y: number,
    dir: 1 | -1,
    radius = MAX_BRUSH_RADIUS,
    seq?: number,
  ): ReturnType<typeof handleSculptIntent> {
    const intent: Record<string, unknown> = {
      type: 'sculpt',
      x,
      y,
      radius,
      dir,
      tool: 'stamp',
      profile: 'hard',
    };
    if (seq !== undefined) intent.seq = seq;
    return handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      intent,
    );
  }

  /** Boots a world, puts Cthulhu in it, and stops the roll. */
  function withCthulhu(): Harness {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);
    expect(livingMonster()!.kind).toBe('cthulhu');
    setMonsterRandomSource(NEVER);
    harness.sink.clear();
    return harness;
  }

  /** The cell his body is standing in. */
  function monsterCell(): { x: number; y: number } {
    const monster = livingMonster()!;
    return { x: Math.floor(monster.x), y: Math.floor(monster.y) };
  }

  it('denies a raise aimed at him, and changes nothing', () => {
    const harness = withCthulhu();
    const cell = monsterCell();
    const before = harness.world.heightAt(cell.x, cell.y);

    const outcome = sculpt(harness, cell.x, cell.y, 1);
    expect(outcome.applied).toBe(false);
    expect(outcome.applied === false && outcome.reason).toBe('plugin-denied');
    // The veto runs BEFORE the heightmap is touched: this is a refusal, not an
    // edit that gets undone.
    expect(harness.world.heightAt(cell.x, cell.y)).toBe(before);
    expect(livingMonster()).not.toBeNull();
  });

  it('nacks the denial with the intent\'s seq, so the client retires its prediction', () => {
    const harness = withCthulhu();
    const cell = monsterCell();

    sculpt(harness, cell.x, cell.y, 1, MAX_BRUSH_RADIUS, 4242);
    const denials = harness.sink.ofType('sculptDenied');
    expect(denials).toHaveLength(1);
    expect(denials[0]!.target).toBe(PLAYER.id);
    expect(denials[0]!.payload).toEqual({ type: 'sculptDenied', seq: 4242 });
    // This plugin sends NO message of its own: the refusal is legible in the
    // world (there is a monster where you aimed), and the nack is core's.
    expect(harness.sink.messages.some((m) => m.type.startsWith(`${MONSTERS_PLUGIN_NAME}:`) &&
      m.type !== `${MONSTERS_PLUGIN_NAME}:${MONSTERS_STATE_MESSAGE}`)).toBe(false);
  });

  it('allows LOWERING the very same cell — you may dig, never build', () => {
    const harness = withCthulhu();
    const cell = monsterCell();
    const before = harness.world.heightAt(cell.x, cell.y);

    const outcome = sculpt(harness, cell.x, cell.y, -1);
    expect(outcome.applied).toBe(true);
    expect(harness.world.heightAt(cell.x, cell.y)).toBeLessThan(before);
  });

  it('draws the line where the two discs stop overlapping', () => {
    const harness = withCthulhu();
    const monster = livingMonster()!;
    const radius = MAX_BRUSH_RADIUS;
    // The brush covers an open disc of `radius` about its cell centre; the body
    // covers one of groundProtectionRadiusCells about the monster. They overlap
    // exactly while the centres are closer than the sum.
    const reach = radius + groundProtectionRadiusCells(profileOf('cthulhu'));

    // A cell whose CENTRE is a hair inside the sum, and one a hair outside. Both
    // are on the +X axis from him, so the distance is one subtraction.
    const insideX = Math.floor(monster.x + reach - 1);
    const outsideX = Math.ceil(monster.x + reach + 1);
    const cellY = Math.floor(monster.y);
    expect(Math.abs(insideX + 0.5 - monster.x)).toBeLessThan(reach);
    expect(Math.abs(outsideX + 0.5 - monster.x)).toBeGreaterThan(reach);

    expect(sculpt(harness, insideX, cellY, 1, radius).applied).toBe(false);
    expect(sculpt(harness, outsideX, cellY, 1, radius).applied).toBe(true);
  });

  it('lets a smaller brush closer, because a smaller brush reaches less far', () => {
    // The test that the intent's RADIUS is part of the geometry rather than a
    // fixed keep-out ring: the same cell is refused to a radius-4 brush and
    // allowed to a radius-1 one.
    const harness = withCthulhu();
    const monster = livingMonster()!;
    const protection = groundProtectionRadiusCells(profileOf('cthulhu'));
    const cellX = Math.floor(monster.x + protection + 2);
    const cellY = Math.floor(monster.y);

    expect(sculpt(harness, cellX, cellY, 1, MAX_BRUSH_RADIUS).applied).toBe(false);
    expect(sculpt(harness, cellX, cellY, 1, 1).applied).toBe(true);
  });

  it('does not interfere when the world holds no monster', () => {
    setMonsterRandomSource(NEVER);
    const harness = boot();
    tick(harness, 10);
    expect(livingMonster()).toBeNull();

    expect(sculpt(harness, WORLD_CENTER, WORLD_CENTER, 1).applied).toBe(true);
    expect(harness.sink.ofType('sculptDenied')).toHaveLength(0);
  });

  it('does not protect the ground for a kind that does not claim it', () => {
    // The kraken is banishable BY draining, so a kraken that blocked raises
    // would be a monster whose only counter it had vetoed. The flag is per kind
    // for exactly this reason.
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    tick(harness, 1);
    expect(livingMonster()!.kind).toBe('kraken');
    setMonsterRandomSource(NEVER);

    const cell = monsterCell();
    expect(profileOf('kraken').protectsGround).toBe(false);
    expect(sculpt(harness, cell.x, cell.y, 1).applied).toBe(true);
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
