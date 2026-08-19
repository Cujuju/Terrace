// The monsters sim, driven through the REAL plugin host and the REAL intent
// pipeline — no stub for either, except where a stub is the only way to express
// the scenario (see the lair-collapse block, which says so on the spot).
//
// The load-bearing claims under test are the singleton and the gates: at most
// one monster exists, it arrives only as a stochastic event on a qualifying
// lair, losing its lair removes it, and neither a restart nor a thousand ticks
// can produce a second.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  SEA_LEVEL,
  isWater,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import type { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin } from '../../../server/test/support/harness.ts';
import {
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  MONSTER_KINDS,
  type MonsterState,
} from '../protocol.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  DEEP_WATER_MAX_HEIGHT,
  HABITAT_REGIMES,
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
  SNOW_LINE_MIN_HEIGHT,
  WATER_HABITAT,
  type LairRegion,
  type LairSurvey,
  type LairWorld,
  habitatReachHeightUnits,
  isDeepWaterHeight,
  isLairCell,
  isSnowHeight,
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
  KRAKEN_LURK_SPEED_CELLS_PER_SECOND,
  KRAKEN_MIN_LAIR_DEEP_CELLS,
  KRAKEN_RESPAWN_COOLDOWN_SECONDS,
  MAX_LIVING_MONSTERS,
  MAX_LIVING_MONSTERS_PER_HABITAT,
  MIN_LAIR_DEEP_CELLS,
  SUMMON_MEAN_WAIT_SECONDS,
  YETI_AMBLE_SPEED_CELLS_PER_SECOND,
  YETI_FOOTPRINT_CELLS,
  YETI_LAIR_COLLAPSE_SNOW_CELLS,
  YETI_MIN_LAIR_SNOW_CELLS,
  YETI_RESPAWN_COOLDOWN_SECONDS,
  groundProtectionRadiusCells,
  kindsInHabitat,
  profileOf,
} from '../server/kinds.ts';
import { advanceMonster, isStranded } from '../server/lurk.ts';
import { loadMonsters, saveMonsters } from '../server/persistence.ts';
import { setMonsterRandomSource } from '../server/rng.ts';
import {
  LAIR_SURVEY_INTERVAL_SECONDS,
  type Monster,
  advanceSummoning,
  cooldownRemainingSeconds,
  enforceHabitat,
  livingMonsterIn,
  livingMonsterCount,
  livingMonsters,
} from '../server/summoning.ts';
import { seededRandom, worldWithTerrain } from './support/world.ts';

/** 128² cells = 8×8 chunks — room for a basin far larger than the minimum lair. */
const WORLD_SIZE = 128;
const WORLD_CENTER = WORLD_SIZE / 2;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

/**
 * Wall-clock budget for the statistical trials, in milliseconds.
 *
 * Vitest's default is 5 s, and the seeded mean-wait trial deliberately simulates
 * about ninety minutes of world time across two dozen worlds — one full habitat
 * survey per five simulated seconds PER HABITAT, which is where the time goes.
 * Raised rather than trimmed because the trial count is what makes the assertion
 * about the mean meaningful, and trimming it would loosen the bound it checks.
 * Measured at ~5 s on this machine, so this is a 6× margin for a slower one.
 */
const SEEDED_TRIAL_TIMEOUT_MS = 30_000;

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

/**
 * Centre of every mountain in this file, stubbed or real.
 *
 * 24, and it is a CLEARANCE: it is 56.6 cells from the basin's centre, and the
 * largest deep disc any test here digs has radius 46 while the largest snowfield
 * has radius 14 — so 56.6 > 46 + 14 and no mountain in this file can ever touch
 * the sea. A world where the two habitats overlapped would make every sea test
 * quietly a mountain test as well.
 */
const MASSIF_CENTER = 24;

/**
 * A SHEER MESA raised out of the bowl's dry land: the yeti's country.
 *
 * Sheer-sided rather than a cone, and that is a real-world shape rather than a
 * convenience: the hard stamp's level-fill brush (the player-facing default)
 * builds exactly this, a plateau with a cliff edge. It also keeps the mountain
 * from reaching the sea — a 29-cell skirt at any walkable grade would have eaten
 * a third of the basin, and then the sea tests would quietly have been mountain
 * tests.
 *
 * Two bands over the snow line, so a level-fill stroke has to take three whole
 * bands off it before it stops being habitat. Radius 14 → ~613 cells, over the
 * yeti's 512-cell demand and under a fifth of the map.
 */
const ALPINE_PEAK_HEIGHT = (SNOW_LINE_BANDS_ABOVE_SEA + 2) * BAND_HEIGHT;
const ALPINE_PLATEAU_RADIUS = 14;

/**
 * The bowl, with the mesa standing in the dry land north-west of it.
 *
 * Its centre is MASSIF_CENTER — 56.6 cells from the basin's, so the mesa's rim
 * is 42 cells clear of the deep water and neither habitat can touch the other.
 */
function alpine(seaRadius: number): (x: number, y: number) => number {
  const sea = bowl(seaRadius);
  return (x, y) => {
    const dx = x - MASSIF_CENTER;
    const dy = y - MASSIF_CENTER;
    if (Math.sqrt(dx * dx + dy * dy) <= ALPINE_PLATEAU_RADIUS) return ALPINE_PEAK_HEIGHT;
    return sea(x, y);
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

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

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

/**
 * The world's single living monster.
 *
 * Every world in this file except the alpine ones holds no snow at all (pinned
 * by a test below), so its land slot can never fill and "the" monster is
 * unambiguous. The helper ASSERTS that rather than assuming it, which is what
 * makes every pre-yeti test in this file also a test that the yeti stays off a
 * map with no mountain on it.
 */
function livingMonster(): Monster | null {
  const alive = livingMonsters();
  // A throw rather than an `expect`: this is called from inside loops that run
  // tens of thousands of iterations, and a matcher per iteration is measurably
  // slower than the simulation it is watching.
  if (alive.length > MAX_LIVING_MONSTERS_PER_HABITAT) {
    throw new Error(`expected at most one monster, found ${alive.length}`);
  }
  return alive[0] ?? null;
}

/** The monster in the water / on the snow, or null. */
const seaMonster = (): Monster | null => livingMonsterIn(WATER_HABITAT);
const snowMonster = (): Monster | null => livingMonsterIn(LAND_HABITAT);

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

describe('the snow line', () => {
  it('is nine bands above sea level — the palette\'s snow stop', () => {
    // The client draws band 9 and above as snow (client/src/terrain/
    // bandColors.ts). Restated here rather than imported, so this is the test
    // that says the two are meant to agree.
    expect(SNOW_LINE_BANDS_ABOVE_SEA).toBe(9);
    expect(SNOW_LINE_MIN_HEIGHT).toBe(SEA_LEVEL + 9 * BAND_HEIGHT);
    // Whole bands, for the reason the deep-water line is: the threshold has to
    // survive a BAND_HEIGHT retune as a statement about terraces.
    expect(SNOW_LINE_MIN_HEIGHT % BAND_HEIGHT === 0).toBe(true);
  });

  it('classifies the boundary the same way on both sides', () => {
    expect(isSnowHeight(SNOW_LINE_MIN_HEIGHT)).toBe(true);
    expect(isSnowHeight(SNOW_LINE_MIN_HEIGHT + 1)).toBe(true);
    expect(isSnowHeight(SNOW_LINE_MIN_HEIGHT - 1)).toBe(false);
    expect(isSnowHeight(SEA_LEVEL)).toBe(false);
  });

  it('is never water, and deep water is never snow — the two habitats are disjoint', () => {
    for (let h = MIN_HEIGHT; h <= MAX_HEIGHT; h++) {
      if (isSnowHeight(h)) expect(isWater(h)).toBe(false);
      expect(isSnowHeight(h) && isDeepWaterHeight(h)).toBe(false);
    }
  });

  it('is at least eighteen cells from any shoreline, by the gradient limit', () => {
    // MAX_STEP is BAND_HEIGHT/2, so terrain climbs at most half a band per cell:
    // nine bands up is eighteen cells of slope at the steepest legal grade. That
    // is what makes the threshold mean "the high country" rather than "a colour
    // someone picked" — three times the six cells the deep-water line buys.
    expect(MAX_STEP).toBe(BAND_HEIGHT / 2);
    expect(SNOW_LINE_MIN_HEIGHT / MAX_STEP).toBe(18);
  });
});

describe('habitat regimes', () => {
  it('measures reach inward, whichever way inward is', () => {
    // THE one primitive: everything else in habitat.ts is a comparison of two of
    // these, which is what stops the land regime disagreeing with itself about
    // which way is up.
    expect(habitatReachHeightUnits(WATER_HABITAT, SEA_LEVEL - 100)).toBe(100);
    expect(habitatReachHeightUnits(WATER_HABITAT, SEA_LEVEL + 100)).toBe(-100);
    expect(habitatReachHeightUnits(LAND_HABITAT, SEA_LEVEL + 100)).toBe(100);
    expect(habitatReachHeightUnits(LAND_HABITAT, SEA_LEVEL - 100)).toBe(-100);
  });

  it('gives every kind a habitat, and every habitat its kinds', () => {
    expect(kindsInHabitat(WATER_HABITAT)).toEqual(['kraken', 'cthulhu']);
    expect(kindsInHabitat(LAND_HABITAT)).toEqual(['yeti']);
    // Every kind lands in exactly one habitat's list — no kind is homeless and
    // none is in two, which is what makes "one slot per habitat" a partition.
    const listed = HABITAT_REGIMES.flatMap((regime) => [...kindsInHabitat(regime)]);
    expect([...listed].sort()).toEqual([...MONSTER_KINDS].sort());
  });

  it('derives the world cap from the per-habitat one', () => {
    expect(MAX_LIVING_MONSTERS_PER_HABITAT).toBe(1);
    expect(MAX_LIVING_MONSTERS).toBe(MAX_LIVING_MONSTERS_PER_HABITAT * HABITAT_REGIMES.length);
  });
});

describe('lair survey', () => {
  it('counts a whole basin as one region and picks its deepest cell', () => {
    const heightOf = bowl(GREAT_BASIN_RADIUS);
    const harness = boot(heightOf);
    const survey = surveyLairs(WATER_HABITAT, lairView(harness.world));

    expect(survey.regions).toHaveLength(1);
    const region = survey.regions[0]!;
    expect(region.cells).toBe(countDeepCells(heightOf));
    expect(region.cells).toBeGreaterThan(MIN_LAIR_DEEP_CELLS);
    // The bowl's floor is its centre, and the survey reports how deep it is —
    // which is the number a kind with a trench requirement is admitted on.
    expect({ x: region.x, y: region.y }).toEqual({ x: WORLD_CENTER, y: WORLD_CENTER });
    expect(region.extremeHeight).toBe(heightOf(WORLD_CENTER, WORLD_CENTER));
  });

  it('ignores locked territory entirely', () => {
    const heightOf = bowl(GREAT_BASIN_RADIUS);
    // The chunk containing the bowl's deepest point.
    const lockedCX = WORLD_CENTER / CHUNK_SIZE;
    const lockedCY = WORLD_CENTER / CHUNK_SIZE;
    const inLockedChunk = (x: number, y: number): boolean =>
      Math.floor(x / CHUNK_SIZE) === lockedCX && Math.floor(y / CHUNK_SIZE) === lockedCY;

    const harness = boot(heightOf, (cx, cy) => cx === lockedCX && cy === lockedCY);
    const survey = surveyLairs(WATER_HABITAT, lairView(harness.world));

    // The basin minus one chunk is still a single connected region (the notch is
    // interior, and the water goes round it).
    const region = largestRegion(survey)!;
    expect(region.cells).toBe(countDeepCells(heightOf, (x, y) => !inLockedChunk(x, y)));
    expect(inLockedChunk(region.x, region.y)).toBe(false);
  });

  it('reports nothing when there is no deep water', () => {
    const harness = boot(bowl(NO_DEEP_WATER_RADIUS));
    const survey = surveyLairs(WATER_HABITAT, lairView(harness.world));
    expect(survey.regions).toHaveLength(0);
    expect(largestRegion(survey)).toBeNull();
  });

  it('reports the size of the region under the queried cell, not the biggest one', () => {
    const harness = boot(bowl(GREAT_BASIN_RADIUS));
    const view = lairView(harness.world);

    const inside = surveyLairs(WATER_HABITAT, view, { x: WORLD_CENTER, y: WORLD_CENTER });
    expect(inside.occupiedRegionCells).toBe(largestRegion(inside)!.cells);

    // A cell on dry land belongs to no region at all.
    const outside = surveyLairs(WATER_HABITAT, view, { x: 0, y: 0 });
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
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS_PER_HABITAT);
    expect(livingMonster()!.id).toBe(id);
  });

  it('summons into deep, unlocked water', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);

    const monster = livingMonster();
    expect(monster).not.toBeNull();
    expect(isLairCell(WATER_HABITAT, lairView(harness.world), monster!.x, monster!.y)).toBe(true);
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
  }, SEEDED_TRIAL_TIMEOUT_MS);
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

/**
 * Ground everywhere neither feature covers: one band above the sea. Dry land,
 * so it is not water; nine bands under the snow line, so it is not snow either.
 * A stubbed world's "everywhere else" must belong to NO habitat, or a test about
 * one feature would silently be a test about a world-sized second one.
 */
const NEUTRAL_GROUND_HEIGHT = BAND_HEIGHT;

/** Height inside the basin, or null outside it. */
function basinHeightAt(state: BasinState, x: number, y: number): number | null {
  const dx = x - WORLD_CENTER;
  const dy = y - WORLD_CENTER;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (state.radius <= 0 || distance > state.radius) return null;
  const toRim = distance / state.radius;
  return Math.round(state.floorHeight + (DEEP_WATER_MAX_HEIGHT - state.floorHeight) * toRim);
}

function basinWorld(state: BasinState): LairWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt: (x, y) => basinHeightAt(state, x, y) ?? NEUTRAL_GROUND_HEIGHT,
    isCellUnlocked: () => true,
  };
}

/**
 * A round MASSIF, stubbed — the mirror image of the basin above, and the land
 * habitat's equivalent of it.
 *
 * Highest at its centre, so the survey's summon cell is the summit and not a rim
 * cell a shrink would strand, falling linearly to exactly the snow line at the
 * rim. It sits well away from the basin's centre so a world can hold both
 * without them overlapping (asserted where they are combined).
 */
interface MassifState {
  radius: number;
  peakHeight: number;
}

/** Height inside the massif, or null outside it. */
function massifHeightAt(state: MassifState, x: number, y: number): number | null {
  const dx = x - MASSIF_CENTER;
  const dy = y - MASSIF_CENTER;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (state.radius <= 0 || distance > state.radius) return null;
  const toRim = distance / state.radius;
  return Math.round(state.peakHeight + (SNOW_LINE_MIN_HEIGHT - state.peakHeight) * toRim);
}

function massifWorld(state: MassifState): LairWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt: (x, y) => massifHeightAt(state, x, y) ?? NEUTRAL_GROUND_HEIGHT,
    isCellUnlocked: () => true,
  };
}

/**
 * A world holding BOTH — one basin and one massif, each with its own dial.
 *
 * The two features never overlap (the basin is centred on the map, the massif a
 * quarter of the way in), so `heightAt` can answer with whichever one covers the
 * cell and neither is a `Math.max` of the other. This is the only world in the
 * file whose two habitats are both non-empty, and it is what the per-habitat
 * slot and cooldown rules are tested against.
 */
function alpineStubWorld(sea: BasinState, snow: MassifState): LairWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt(x, y) {
      const summit = massifHeightAt(snow, x, y);
      if (summit !== null) return summit;
      return basinHeightAt(sea, x, y) ?? NEUTRAL_GROUND_HEIGHT;
    },
    isCellUnlocked: () => true,
  };
}

/**
 * A snowfield the yeti qualifies for: radius 14 → ~613 cells, past his 512-cell
 * demand, and its summit two bands over the line. The radius is also what keeps
 * it clear of every basin here — see MASSIF_CENTER.
 */
function yetiMassif(): MassifState {
  return { radius: 14, peakHeight: SNOW_LINE_MIN_HEIGHT + 2 * BAND_HEIGHT };
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
    expect(isLairCell(WATER_HABITAT, world, livingMonster()!.x, livingMonster()!.y)).toBe(false);

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
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(0);
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
    expect(isLairCell(WATER_HABITAT, world, livingMonster()!.x, livingMonster()!.y)).toBe(true);

    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).not.toBeNull();
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(0);
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
    expect(isLairCell(WATER_HABITAT, world, monster.x, monster.y)).toBe(true);
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
    expect(isLairCell(WATER_HABITAT, world, livingMonster()!.x, livingMonster()!.y)).toBe(true);

    // Survey cadence: the collapse is noticed on the next survey, not instantly.
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
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
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
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
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBeGreaterThan(0);

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
    expect(isLairCell(WATER_HABITAT, lairView(harness.world), monster!.x, monster!.y)).toBe(true);
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS_PER_HABITAT);
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
    expect(snapshot.monsters).toEqual([]);
    expect(snapshot.cooldownSeconds.water).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
    // The mountain never had anything to do with this and is not written at all.
    expect(snapshot.cooldownSeconds.land).toBeUndefined();

    // Reboot onto the same world. Without the persisted cooldown, the very next
    // tick would roll for a fresh monster — a restart would be a way to skip the
    // banishment.
    const rebooted = boot(bowl(TRENCH_RADIUS));
    loadMonsters(JSON.parse(JSON.stringify(snapshot)) as unknown);
    tick(rebooted, 100);
    expect(livingMonster()).toBeNull();
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBeGreaterThan(0);
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

    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS_PER_HABITAT);
    expect(livingMonster()!.id).toBe(id);
  });

  it('degrades to an empty, uncooled world on a corrupt slice', () => {
    const corrupt: unknown[] = [
      null,
      undefined,
      42,
      {},
      { version: 999, monsters: [{ id: 1, kind: 'cthulhu', x: 1, y: 1, heading: 0 }] },
      { version: 2, monsters: 'yes', nextId: 2 },
      { version: 2, monsters: [{ id: 0, kind: 'cthulhu', x: 1, y: 1, heading: 0 }], nextId: 2 },
      { version: 2, monsters: [{ id: 1, kind: 'dagon', x: 1, y: 1, heading: 0 }], nextId: 2 },
      { version: 2, monsters: [{ id: 1, kind: 'cthulhu', x: NaN, y: 1, heading: 0 }], nextId: 2 },
      { version: 2, monsters: ['yes'], nextId: 2 },
      { version: 2, monsters: [], cooldownSeconds: 'later', nextId: 2 },
      // The same garbage in the version-1 shape, which is still read (migrated).
      { version: 1, monster: { id: 0, kind: 'cthulhu', x: 1, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: { id: 1, kind: 'dagon', x: 1, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: { id: 1, kind: 'cthulhu', x: NaN, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: 'yes', nextId: 2 },
    ];

    for (const slice of corrupt) {
      resetMonstersState();
      loadMonsters(slice);
      expect(livingMonsters()).toEqual([]);
      // No invented banishment, in EITHER habitat: a bad byte must not suppress
      // arrivals.
      for (const regime of HABITAT_REGIMES) {
        expect(cooldownRemainingSeconds(regime)).toBe(0);
      }
    }
  });

  it('clamps a nonsense cooldown instead of trusting it', () => {
    for (const cooldownSeconds of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      resetMonstersState();
      loadMonsters({ version: 2, monsters: [], nextId: 3, cooldownSeconds: { water: cooldownSeconds, land: cooldownSeconds } });
      for (const regime of HABITAT_REGIMES) {
        expect(cooldownRemainingSeconds(regime)).toBe(0);
      }

      // ...and in the version-1 shape, where the cooldown was one scalar.
      resetMonstersState();
      loadMonsters({ version: 1, monster: null, nextId: 3, cooldownSeconds });
      expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(0);
    }
  });

  it('never reuses an id after a restore, even from a garbage counter', () => {
    resetMonstersState();
    loadMonsters({
      version: 2,
      nextId: 'nonsense',
      monsters: [{ id: 9, kind: 'cthulhu', x: WORLD_CENTER, y: WORLD_CENTER, heading: 0 }],
    });
    expect(livingMonster()!.id).toBe(9);

    // Banish it and let the world summon another: the new id must be past the
    // restored one. A KRAKEN, restored onto its own trench world — Cthulhu
    // could not be banished to make room for the successor.
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    loadMonsters({
      version: 2,
      nextId: 'nonsense',
      monsters: [{ id: 9, kind: 'kraken', x: 0, y: 0, heading: 0 }],
    });
    // (0, 0) is dry land in the bowl, so the first tick's habitat check removes
    // it — which is also the "restored onto a changed world" path.
    tick(harness, 1);
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBeGreaterThan(0);

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
      version: 2,
      nextId: 20,
      monsters: [{ id: 9, kind: 'cthulhu', x: 0, y: 0, heading: 0 }],
    });
    tick(harness, 100);

    expect(livingMonster()).not.toBeNull();
    expect(livingMonster()!.id).toBe(9);
    expect(isLairCell(WATER_HABITAT, lairView(harness.world), 0, 0)).toBe(false);
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(0);
  });

  it('migrates a version-1 slice, and its cooldown is the WATER habitat\'s', () => {
    // Version 1 predates the land habitat entirely — every kind it could name
    // lives in the sea — so its one world-wide cooldown is a water cooldown by
    // construction rather than by guess, and the mountain starts free.
    resetMonstersState();
    loadMonsters({
      version: 1,
      nextId: 12,
      cooldownSeconds: 42,
      monster: { id: 11, kind: 'kraken', x: 3.5, y: 4.5, heading: 1 },
    });

    expect(seaMonster()).toMatchObject({ id: 11, kind: 'kraken', x: 3.5, y: 4.5 });
    expect(snowMonster()).toBeNull();
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(42);
    expect(cooldownRemainingSeconds(LAND_HABITAT)).toBe(0);
  });

  it('round-trips one monster per habitat, and drops a smuggled duplicate', () => {
    resetMonstersState();
    loadMonsters({
      version: 2,
      nextId: 30,
      cooldownSeconds: { land: 7 },
      monsters: [
        { id: 21, kind: 'cthulhu', x: 1.5, y: 2.5, heading: 0 },
        { id: 22, kind: 'yeti', x: 3.5, y: 4.5, heading: 1 },
        // A hand-edited second sea monster. The slot is the gate: it is dropped.
        { id: 23, kind: 'kraken', x: 5.5, y: 6.5, heading: 2 },
      ],
    });

    expect(livingMonsterCount()).toBe(2);
    expect(seaMonster()!.id).toBe(21);
    expect(snowMonster()!.id).toBe(22);
    expect(cooldownRemainingSeconds(LAND_HABITAT)).toBe(7);

    // ...and the save side agrees, per habitat, in the fixed regime order.
    const saved = saveMonsters();
    expect(saved.monsters.map((entry) => entry.kind)).toEqual(['cthulhu', 'yeti']);
    expect(saved.cooldownSeconds).toEqual({ land: 7 });
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
      expect(isLairCell(WATER_HABITAT, view, monster!.x, monster!.y)).toBe(true);
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

describe('the yeti in the high Alps', () => {
  /** Counts snow cells directly, as an independent check on the flood fill. */
  function countSnowCells(heightOf: (x: number, y: number) => number): number {
    let count = 0;
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        if (isSnowHeight(heightOf(x, y))) count++;
      }
    }
    return count;
  }

  it('leaves every sea-only world in this file alone — none of them holds snow', () => {
    // This is what makes the `livingMonster()` helper's "at most one" assertion
    // safe in every other block, and it is worth pinning rather than assuming:
    // the bowl worlds climb to band 5 at the map corners, four bands short.
    for (const radius of [
      GREAT_BASIN_RADIUS,
      TRENCH_RADIUS,
      SMALL_POOL_RADIUS,
      NO_DEEP_WATER_RADIUS,
    ]) {
      expect(countSnowCells(bowl(radius))).toBe(0);
    }
    // ...and the stubbed basins are dry land (one band up) everywhere else.
    expect(isSnowHeight(NEUTRAL_GROUND_HEIGHT)).toBe(false);
  });

  it('surveys a massif exactly as it surveys a basin, and picks the SUMMIT', () => {
    const snow = yetiMassif();
    const world = massifWorld(snow);
    const survey = surveyLairs(LAND_HABITAT, world);

    expect(survey.regions).toHaveLength(1);
    const region = survey.regions[0]!;
    expect(region.cells).toBeGreaterThan(YETI_MIN_LAIR_SNOW_CELLS);
    // The extreme cell of a land region is its HIGHEST, where a basin's is its
    // deepest — the one behaviour the generalisation had to get right.
    expect({ x: region.x, y: region.y }).toEqual({ x: MASSIF_CENTER, y: MASSIF_CENTER });
    expect(region.extremeHeight).toBe(snow.peakHeight);
    // The same world holds no water habitat at all.
    expect(surveyLairs(WATER_HABITAT, world).regions).toHaveLength(0);
  });

  it('arrives on a snowfield, at its summit', () => {
    setMonsterRandomSource(ALWAYS);
    const world = massifWorld(yetiMassif());
    advanceSummoning(world, TICK_DT);

    const yeti = snowMonster();
    expect(yeti).not.toBeNull();
    expect(yeti!.kind).toBe('yeti');
    expect(isLairCell(LAND_HABITAT, world, yeti!.x, yeti!.y)).toBe(true);
    // Cell centre, at the summit the survey named.
    expect(yeti!.x).toBe(MASSIF_CENTER + 0.5);
    expect(seaMonster()).toBeNull();
  });

  it('never arrives on a snowfield too small to be a lair', () => {
    setMonsterRandomSource(ALWAYS);
    // Deep enough into the snow, far too little of it: height alone is not a
    // lair, which is the half of the rule the area threshold carries.
    const world = massifWorld({ radius: 8, peakHeight: SNOW_LINE_MIN_HEIGHT + 4 * BAND_HEIGHT });
    expect(Math.PI * 8 * 8).toBeLessThan(YETI_MIN_LAIR_SNOW_CELLS);

    for (let n = 0; n < 600; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonsters()).toEqual([]);
  });

  it('never arrives on high ground that is below the snow line', () => {
    setMonsterRandomSource(ALWAYS);
    // A whole map of band-8 plateau: enormous, high, and one band short.
    const world: LairWorld = {
      worldSize: WORLD_SIZE,
      heightAt: () => SNOW_LINE_MIN_HEIGHT - BAND_HEIGHT,
      isCellUnlocked: () => true,
    };
    for (let n = 0; n < 600; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonsters()).toEqual([]);
  });

  it('holds the mountain and the sea AT ONCE — the slots are per habitat', () => {
    // THE decision this feature turns on. A world with both a basin and a
    // snowfield gets both monsters; neither blocks the other, because a player
    // standing on a peak and a player looking at the sea are looking at
    // different places.
    setMonsterRandomSource(ALWAYS);
    const heightOf = alpine(GREAT_BASIN_RADIUS);
    expect(countSnowCells(heightOf)).toBeGreaterThan(YETI_MIN_LAIR_SNOW_CELLS);
    expect(countDeepCells(heightOf)).toBeGreaterThan(MIN_LAIR_DEEP_CELLS);

    const harness = boot(heightOf);
    tick(harness, 1);

    expect(seaMonster()!.kind).toBe('cthulhu');
    expect(snowMonster()!.kind).toBe('yeti');
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS);

    // Five simulated minutes of a roll that fires on EVERY tick: if either slot
    // could take a second occupant, three thousand chances is where it shows up.
    const ids = livingMonsters().map((monster) => monster.id);
    tick(harness, 3000);
    expect(livingMonsters().map((monster) => monster.id)).toEqual(ids);
  });

  it('broadcasts both, each under its own kind, in a stable order', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot(alpine(GREAT_BASIN_RADIUS));
    tick(harness, 1);
    harness.sink.clear();
    tick(harness, BROADCAST_TICK_INTERVAL);

    const messages = harness.sink
      .ofType(`${MONSTERS_PLUGIN_NAME}:${MONSTERS_STATE_MESSAGE}`)
      .map((message) => (message.payload as { monsters: MonsterState[] }).monsters);
    expect(messages).toHaveLength(1);
    // Water first, then land: HABITAT_REGIMES order, so the payload does not
    // wobble between ticks.
    expect(messages[0]!.map((entry) => entry.kind)).toEqual(['cthulhu', 'yeti']);
    expect(monsterStates().map((entry) => entry.kind)).toEqual(['cthulhu', 'yeti']);
  });

  it('leaves when his snowfield collapses, and serves the full cooldown', () => {
    const snow = yetiMassif();
    const world = massifWorld(snow);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    expect(snowMonster()!.kind).toBe('yeti');

    // Shrink it below the collapse threshold while his own cell stays snow, so
    // the ONLY thing that can drive him off is the region test.
    snow.radius = 4;
    expect(Math.PI * snow.radius * snow.radius).toBeLessThan(YETI_LAIR_COLLAPSE_SNOW_CELLS);
    expect(isLairCell(LAND_HABITAT, world, snowMonster()!.x, snowMonster()!.y)).toBe(true);

    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(snowMonster()).toBeNull();
    expect(cooldownRemainingSeconds(LAND_HABITAT)).toBe(YETI_RESPAWN_COOLDOWN_SECONDS);
  });

  it('leaves when a player levels the peak out from under him', () => {
    // The owner's rule, through the REAL intent pipeline: the hard stamp's
    // level-fill takes a whole band off the plateau per stroke, and the third
    // one puts his cell below the snow line.
    setMonsterRandomSource(ALWAYS);
    const harness = boot(alpine(GREAT_BASIN_RADIUS));
    tick(harness, 1);
    expect(snowMonster()!.kind).toBe('yeti');
    // Stop the roll: this test is about the departure.
    setMonsterRandomSource(NEVER);

    const cellX = Math.floor(snowMonster()!.x);
    const cellY = Math.floor(snowMonster()!.y);

    // No ticks in between, so he cannot walk away — this is specifically the
    // "the world changed under him" case. He does not protect his ground, so
    // the intents are accepted.
    let strokes = 0;
    for (let n = 0; n < 40 && isSnowHeight(harness.world.heightAt(cellX, cellY)); n++) {
      handleSculptIntent({ world: harness.world, interceptors: harness.host }, PLAYER, {
        type: 'sculpt',
        x: cellX,
        y: cellY,
        radius: MAX_BRUSH_RADIUS,
        dir: -1,
        tool: 'stamp',
        profile: 'hard',
      });
      strokes++;
    }

    expect(isSnowHeight(harness.world.heightAt(cellX, cellY))).toBe(false);
    // Three bands to take off a summit two bands over the line, one per stroke.
    expect(strokes).toBe(3);
    // The terrain reaction fires inside the sculpt — no tick needed.
    expect(snowMonster()).toBeNull();
    expect(cooldownRemainingSeconds(LAND_HABITAT)).toBe(YETI_RESPAWN_COOLDOWN_SECONDS);
    // ...and the sea is untouched by any of it.
    expect(seaMonster()).not.toBeNull();
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(0);
  });

  it('cools down without suppressing the sea, and vice versa', () => {
    // The other half of the per-habitat decision: banishing one must not keep
    // the other's habitat empty. A stubbed world with both features, a yeti and
    // a kraken in it, and the mountain taken away.
    const sea = krakenTrench();
    const snow = yetiMassif();
    const world = alpineStubWorld(sea, snow);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    expect(seaMonster()!.kind).toBe('kraken');
    expect(snowMonster()!.kind).toBe('yeti');
    const krakenId = seaMonster()!.id;

    snow.radius = 4;
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(snowMonster()).toBeNull();
    expect(cooldownRemainingSeconds(LAND_HABITAT)).toBeGreaterThan(0);

    // The kraken is exactly where it was, on no cooldown at all.
    expect(seaMonster()!.id).toBe(krakenId);
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(0);

    // Now drain the sea instead. The mountain is back and still cooling: each
    // habitat serves its own absence and neither reads the other's.
    snow.radius = yetiMassif().radius;
    sea.radius = 4;
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(seaMonster()).toBeNull();
    expect(cooldownRemainingSeconds(WATER_HABITAT)).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
    expect(cooldownRemainingSeconds(LAND_HABITAT)).toBeLessThan(YETI_RESPAWN_COOLDOWN_SECONDS);
    expect(cooldownRemainingSeconds(LAND_HABITAT)).toBeGreaterThan(0);
    expect(snowMonster()).toBeNull();
  });

  it('does not protect the ground he stands on — you may build under him', () => {
    // He is banishable BY levelling, so a yeti that vetoed raises would be a
    // monster whose only counter it had half-vetoed. Raising is allowed too:
    // it makes his mountain taller, which is nothing he objects to.
    setMonsterRandomSource(ALWAYS);
    const harness = boot(alpine(GREAT_BASIN_RADIUS));
    tick(harness, 1);
    const yeti = snowMonster()!;
    setMonsterRandomSource(NEVER);

    expect(profileOf('yeti').protectsGround).toBe(false);
    const outcome = handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      {
        type: 'sculpt',
        x: Math.floor(yeti.x),
        y: Math.floor(yeti.y),
        radius: MAX_BRUSH_RADIUS,
        dir: 1,
        tool: 'stamp',
        profile: 'hard',
      },
    );
    expect(outcome.applied).toBe(true);
    expect(snowMonster()).not.toBeNull();
  });

  it('never leaves the snow, over a long run', () => {
    const harness = boot(alpine(GREAT_BASIN_RADIUS));
    setMonsterRandomSource(ALWAYS);
    tick(harness, 1);
    setMonsterRandomSource(seededRandom(4242));

    const view = lairView(harness.world);
    // Ten simulated minutes of ambling, on a plateau 28 cells across.
    for (let n = 0; n < 6000; n++) {
      tick(harness, 1);
      const yeti = snowMonster();
      expect(yeti).not.toBeNull();
      expect(isLairCell(LAND_HABITAT, view, yeti!.x, yeti!.y)).toBe(true);
    }
  });

  it('ambles between the two sea kinds\' speeds, and far under a grazer', () => {
    // The comparison that matters is the last one: the wildlife plugin's grazer
    // cruises at 1.6 cells/s on the same hillsides (plugins/wildlife/server/
    // species.ts). Cross-referenced, not imported — plugins must not depend on
    // each other for a number. A monster that moved like livestock would undo
    // every silhouette decision in the model.
    const WILDLIFE_GRAZER_CRUISE_CELLS_PER_SECOND = 1.6;
    expect(YETI_AMBLE_SPEED_CELLS_PER_SECOND).toBeGreaterThan(
      CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
    );
    expect(YETI_AMBLE_SPEED_CELLS_PER_SECOND).toBeLessThan(KRAKEN_LURK_SPEED_CELLS_PER_SECOND);
    expect(YETI_AMBLE_SPEED_CELLS_PER_SECOND).toBeLessThan(
      WILDLIFE_GRAZER_CRUISE_CELLS_PER_SECOND / 3,
    );
  });

  it('probes at least half its own body ahead', () => {
    // Same guarantee the sea kinds get: the look-ahead is what keeps a 5-cell
    // body out of cliffs its centre point would clear.
    expect(YETI_FOOTPRINT_CELLS / 2).toBeGreaterThan(
      YETI_AMBLE_SPEED_CELLS_PER_SECOND * TICK_DT,
    );
  });

  it('halts often and briefly, where Cthulhu broods rarely and at length', () => {
    // Similar SHARE of the time stationary, decomposed the opposite way. Share
    // is not what a player reads; beat length is.
    const yeti = profileOf('yeti');
    const cthulhu = profileOf('cthulhu');
    const shareOf = (profile: typeof yeti): number =>
      profile.idleOnsetPerSecond / (profile.idleOnsetPerSecond + profile.idleEndPerSecond);
    const beatOf = (profile: typeof yeti): number => 1 / profile.idleEndPerSecond;

    expect(Math.abs(shareOf(yeti) - shareOf(cthulhu))).toBeLessThan(0.1);
    expect(beatOf(yeti)).toBeLessThan(beatOf(cthulhu) / 2);
  });
});
