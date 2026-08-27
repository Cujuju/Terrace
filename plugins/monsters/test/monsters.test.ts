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
  DEFAULT_WORLD_SPAN,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  SEA_LEVEL,
  WORLD_UNIT_CELLS,
  type SculptProfile,
  cellsAcross,
  cellsOverArea,
  forEachFootprintOffset,
  isWater,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import { initialUnlockFootprint } from '../../../server/src/world/initial-unlock.ts';
import {
  GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA,
  GENESIS_TRENCH_MIN_BASIN_CELLS,
  GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA,
  buildFreshGenesisTerrain,
  freshGenesisHeightAt,
} from '../../../server/src/world/genesis.ts';
import { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
} from '../../../server/test/support/harness.ts';
import {
  MANA_CAPACITY,
  MANA_COST_PER_MIN_RADIUS_SCULPT,
  POINT_BRUSH_RADIUS_CELLS,
  manaBalanceOf,
  plugin as manaPlugin,
  resetManaState,
} from '../../mana/server/index.ts';
import {
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  MONSTER_KINDS,
  type MonsterState,
} from '../protocol.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  DEEP_WATER_DEPTH_BELOW_SEA,
  DEEP_WATER_MAX_HEIGHT,
  HABITAT_REGIMES,
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
  SNOW_LINE_HEIGHT_ABOVE_SEA,
  SNOW_LINE_MIN_HEIGHT,
  WATER_HABITAT,
  type LairRegion,
  type LairSurvey,
  type LairWorld,
  habitatReachHeightUnits,
  isDeepWaterHeight,
  isLairCell,
  isLairPose,
  isSnowHeight,
  reachesIntoHabitat,
  surveyLairs,
} from '../server/habitat.ts';
import { releaseHabitatIndex } from '../server/habitat-index.ts';
import {
  BROADCAST_TICK_INTERVAL,
  monsterStates,
  plugin as monstersPlugin,
  resetMonstersState,
} from '../server/index.ts';
import {
  CTHULHU_FOOTPRINT_CELLS,
  CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
  GENESIS_DEEP_OCEAN_REFERENCE_BAND,
  GENESIS_DEEP_OCEAN_REFERENCE_DEPTH,
  KRAKEN_LAIR_MIN_DEPTH_BANDS,
  KRAKEN_LURK_SPEED_CELLS_PER_SECOND,
  KRAKEN_MIN_LAIR_DEEP_CELLS,
  KRAKEN_RESPAWN_COOLDOWN_SECONDS,
  MAX_LIVING_MONSTERS,
  MAX_LIVING_MONSTERS_PER_KIND,
  MIN_LAIR_DEEP_CELLS,
  NATURAL_OCEAN_FLOOR_MIN_DEPTH,
  SUMMON_MEAN_WAIT_SECONDS,
  YETI_AMBLE_SPEED_CELLS_PER_SECOND,
  YETI_FOOTPRINT_CELLS,
  YETI_LAIR_COLLAPSE_SNOW_CELLS,
  YETI_MIN_LAIR_SNOW_CELLS,
  YETI_RESPAWN_COOLDOWN_SECONDS,
  bodyRadiusCells,
  groundProtectionRadiusCells,
  kindsInHabitat,
  profileOf,
} from '../server/kinds.ts';
import { advanceLurking, advanceMonster, isStranded } from '../server/lurk.ts';
import { loadMonsters, saveMonsters } from '../server/persistence.ts';
import { setMonsterRandomSource } from '../server/rng.ts';
import {
  LAIR_SURVEY_INTERVAL_SECONDS,
  type Monster,
  advanceSummoning,
  cooldownRemainingSecondsFor,
  enforceHabitat,
  livingCountOfKind,
  livingMonsterOfKind,
  livingMonstersIn,
  livingMonsterCount,
  livingMonsters,
  restoreSummoning,
} from '../server/summoning.ts';
import { seededRandom, worldWithTerrain } from './support/world.ts';

/** 128² cells = 8×8 chunks — room for a basin far larger than the minimum lair. */
// 128 WORLD UNITS. The lair thresholds, snow-line distances and summon
// scatter this suite asserts on are all ground-sized, so the world has to be
// too: 128 CELLS after the 2026-08-21 re-sample is 32 world units, smaller
// than the minimum lair a kraken will take.
const WORLD_SIZE = cellsAcross(128);
const WORLD_CENTER = WORLD_SIZE / 2;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

/**
 * Wall-clock budget for the long seeded simulation runs, in milliseconds.
 *
 * APPLIES TO EVERY TEST IN THIS FILE THAT SIMULATES MINUTES OF WORLD TIME, and
 * that is the whole point of it being a named constant rather than a number
 * typed at one call site. Vitest's default is 5 s; these runs deliberately
 * simulate tens of minutes of world time — one full habitat survey per five
 * simulated seconds PER HABITAT, which is where the time goes — so they are
 * seconds of wall clock even on a fast machine, and the default is not a
 * budget any of them were ever going to fit.
 *
 * Raised rather than trimmed because the length of the run is what makes the
 * assertion meaningful: the mean-wait trial's bound comes from its trial
 * count, and the single-arrival trial's "exactly once" comes from running far
 * past the mean wait. Shortening either would loosen what it checks.
 *
 * 2026-08-21: the single-arrival trial was omitting this and running on the
 * 5 s default. It measured ~7 s on this machine under ordinary load, so it
 * failed whenever the machine was busy and passed when it was not — a flake
 * that looked like whichever commit happened to be in the tree at the time.
 *
 * RE-MEASURED THE SAME DAY, AFTER THE RE-SAMPLE, which is why the value is
 * 480 s and not the 30 s those measurements justified: the mean-wait trial
 * goes from ~5 s to ~81 s. The growth is the survey's and nothing else's — a
 * survey walks every cell of the world, WORLD_SIZE is a fixed 128 world units
 * (the shipped minimum), and a quarter-cell world samples that same ground
 * with sixteen times the cells. Neither the trial count nor the simulated
 * duration moved, so nothing either trial checks is weaker; the same work
 * simply costs sixteen times as much. 480 s keeps the 6× margin the pre-
 * re-sample value was chosen with.
 */
const SEEDED_TRIAL_TIMEOUT_MS = 480_000;

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
// A SLOPE — height units per WORLD UNIT of run, which is why it is divided
// into cells here. Left at 8 per CELL through the 2026-08-21 re-sample every
// bowl in this file would have been four times as steep, and every deep disc
// four times as wide as the radius it is named for.
const BOWL_SLOPE_PER_CELL = 8 / WORLD_UNIT_CELLS;

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
const MASSIF_CENTER = cellsAcross(24);

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
 * yeti's 170-cell demand (owner decision, 2026-08-19) and under a fifth of the
 * map.
 */
const ALPINE_PEAK_HEIGHT = (SNOW_LINE_BANDS_ABOVE_SEA + 2) * BAND_HEIGHT;
const ALPINE_PLATEAU_RADIUS = cellsAcross(14);

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
const GREAT_BASIN_RADIUS = cellsAcross(50);
/**
 * A KRAKEN TRENCH. Deep disc radius 46 → ~6 600 cells (over the kraken's 2 304)
 * and 560 height units at the floor — 8.75 bands, past its 8-band demand.
 *
 * The GREAT_BASIN above deliberately fails BOTH kraken tests (2 120 cells, 6.25
 * bands), which is what keeps every Cthulhu test in this file summoning a
 * Cthulhu even though the kraken is considered first.
 */
const TRENCH_RADIUS = cellsAcross(70);
/** Deep disc radius 16 → ~800 cells: real deep water, but not a lair. */
const SMALL_POOL_RADIUS = cellsAcross(40);
/** No cell anywhere reaches the deep threshold. */
const NO_DEEP_WATER_RADIUS = cellsAcross(20);

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
  // Fog of war (issue #18): grant PLAYER's own token every chunk this
  // world's union mask already has unlocked, or every broadcast below would
  // filter down to nothing — this suite's PLAYER stands in for "one player
  // who can see the whole (unlocked) world", same as it always has.
  grantTokenEveryUnlockedChunk(world, PLAYER.token);
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
  if (alive.length > MAX_LIVING_MONSTERS_PER_KIND) {
    throw new Error(`expected at most one monster, found ${alive.length}`);
  }
  return alive[0] ?? null;
}

/** The monster in the water / on the snow, or null. */
const seaMonster = (): Monster | null => livingMonstersIn(WATER_HABITAT)[0] ?? null;
const snowMonster = (): Monster | null => livingMonstersIn(LAND_HABITAT)[0] ?? null;

beforeEach(() => {
  resetMonstersState();
  setMonsterRandomSource(null);
});

describe('deep water', () => {
  it('is three bands below sea level, restating wildlife\'s threshold', () => {
    // A DEPTH, not a band count (2026-08-20). "Three bands" was the old
    // spelling of 192 units; pinned as bands it would have followed the render
    // quantum down to 48 and moved the coastline of every world.
    expect(DEEP_WATER_DEPTH_BELOW_SEA).toBe(192);
    expect(DEEP_WATER_MAX_HEIGHT).toBe(SEA_LEVEL - DEEP_WATER_DEPTH_BELOW_SEA);
    expect(DEEP_WATER_BANDS_BELOW_SEA).toBe(DEEP_WATER_DEPTH_BELOW_SEA / BAND_HEIGHT);
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
    // MIN_HEIGHT..MAX_HEIGHT, not the -1024..1024 this swept until the
    // 2026-08-19 correctness pass: Deep Strata took MIN_HEIGHT to -1536, and
    // the bands it added (basalt, obsidian, lava) are exactly the range the
    // old literal stopped covering — a range the water habitat DOES admit, so
    // a disagreement down there would have shipped untested.
    for (let h = MIN_HEIGHT; h <= MAX_HEIGHT; h++) {
      if (isDeepWaterHeight(h)) expect(isWater(h)).toBe(true);
    }
    // The deepest cell a world can hold is habitat, not an off-by-one hole:
    // a monster standing on the lava floor is deep water by this definition.
    expect(isDeepWaterHeight(MIN_HEIGHT)).toBe(true);
    expect(isWater(MIN_HEIGHT)).toBe(true);
  });
});

describe('the snow line', () => {
  it('is nine bands above sea level — the palette\'s snow stop', () => {
    // The client draws band 9 and above as snow (client/src/terrain/
    // bandColors.ts). Restated here rather than imported, so this is the test
    // that says the two are meant to agree.
    // A HEIGHT, not a band count (2026-08-20): "band 9" was the old spelling
    // of 576 units, and keeping the band would have dropped the server's snow
    // line to 144 while the palette kept the mountains white above 576.
    expect(SNOW_LINE_HEIGHT_ABOVE_SEA).toBe(576);
    expect(SNOW_LINE_MIN_HEIGHT).toBe(SEA_LEVEL + SNOW_LINE_HEIGHT_ABOVE_SEA);
    expect(SNOW_LINE_BANDS_ABOVE_SEA).toBe(SNOW_LINE_HEIGHT_ABOVE_SEA / BAND_HEIGHT);
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

  it('is at least thirty-six world units from any shoreline, by the gradient limit', () => {
    // Terrain climbs at most a full band per WORLD UNIT, and the snow line is
    // thirty-six world units of slope at the steepest legal grade. That is what
    // makes the threshold mean "the high country" rather than "a colour someone
    // picked" — three times the twelve units the deep-water line buys, the same
    // ratio it always had.
    //
    // BOTH DISTANCES DOUBLED on 2026-08-20 (18 -> 36, 6 -> 12) and neither
    // threshold moved: MAX_STEP went from half a band to a whole one, so the
    // world's maximum slope halved and the same depths now sit twice as far
    // out. That is the re-terrace working as intended — the coast got gentler,
    // not the mountains lower. The 2026-08-21 re-sample moved neither again:
    // MAX_STEP is a slope per world unit now, so this ratio is stated against
    // the world unit and reads exactly as it did.
    expect(MAX_STEP).toBe(BAND_HEIGHT / WORLD_UNIT_CELLS);
    expect(SNOW_LINE_MIN_HEIGHT / (MAX_STEP * WORLD_UNIT_CELLS)).toBe(36);
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

  it('derives the world cap from the per-kind one (per-kind slots, 2026-08-19)', () => {
    expect(MAX_LIVING_MONSTERS_PER_KIND).toBe(1);
    expect(MAX_LIVING_MONSTERS).toBe(MAX_LIVING_MONSTERS_PER_KIND * MONSTER_KINDS.length);
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

    const inside = surveyLairs(WATER_HABITAT, view, [{ x: WORLD_CENTER, y: WORLD_CENTER }]);
    expect(inside.occupiedRegionCells).toEqual([largestRegion(inside)!.cells]);

    // A cell on dry land belongs to no region at all — and the answers stay
    // index-aligned with the queried occupants (per-kind slots, 2026-08-19).
    const outside = surveyLairs(WATER_HABITAT, view, [{ x: 0, y: 0 }, { x: WORLD_CENTER, y: WORLD_CENTER }]);
    expect(outside.occupiedRegionCells[0]).toBe(0);
    expect(outside.occupiedRegionCells[1]).toBe(largestRegion(outside)!.cells);
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
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS_PER_KIND);
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
    // Same budget as its sibling below, for the same reason: 24,000 ticks is
    // 40 simulated minutes, which is seconds of wall clock. See the constant.
  }, SEEDED_TRIAL_TIMEOUT_MS);

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

/**
 * Wraps a stubbed feature's dials so that writing one ANNOUNCES the terrain
 * change, the way the real server does.
 *
 * These fixtures are the only terrain in the project that moves without an
 * applied `CellDiff`: a test assigns `basin.radius = 0` and every cell of the
 * world silently means something new. The survey reads maintained per-cell
 * bitmaps (server/habitat-index.ts) whose only repair paths are that diff
 * (`onTerrainChanged`) and a wholesale replacement (`onWorldCreate`, which a
 * rollback replays) — so a fixture write that told neither would be surveyed
 * against the world as it was BEFORE the write, forever: the world size is
 * unchanged, so nothing else would ever notice.
 *
 * HERE AND NOT AT THE SEVENTEEN ASSIGNMENT SITES. A rule every future test has
 * to remember is a rule a future test will forget, and the failure it buys is a
 * survey quietly reporting stale regions — which reads as a sim bug, not a
 * fixture bug. Wrapping the three builders below is the same rule, stated once.
 */
function announcedTerrain<T extends object>(state: T): T {
  return new Proxy(state, {
    set(target, key, value, receiver) {
      releaseHabitatIndex();
      return Reflect.set(target, key, value, receiver);
    },
  });
}

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
 * A snowfield the yeti qualifies for: radius 14 → ~613 cells, past his
 * 170-cell demand (owner decision, 2026-08-19), and its summit two bands over
 * the line. The radius is also what keeps it clear of every basin here — see
 * MASSIF_CENTER.
 */
function yetiMassif(): MassifState {
  return announcedTerrain({
    radius: cellsAcross(14),
    peakHeight: SNOW_LINE_MIN_HEIGHT + 2 * BAND_HEIGHT,
  });
}

/** A basin Cthulhu qualifies for and the kraken does not: big, but not a trench. */
function cthulhuBasin(): BasinState {
  return announcedTerrain({ radius: cellsAcross(30), floorHeight: DEEP_WATER_MAX_HEIGHT - 30 });
}

/**
 * Extra depth this fixture's trench carries BELOW the kraken's demand, so its
 * qualifying floor is a pocket with area rather than a single cell.
 *
 * A DEPTH, not "one more band" (2026-08-20). The basin ramps linearly from its
 * floor to the deep-water line at the rim, so the margin is what decides how
 * WIDE the qualifying pocket is; expressed as a band it shrank to a quarter
 * when the world was re-terraced and the pocket collapsed to about five cells,
 * which is not enough distinct cells for the summon-spread test below to mean
 * anything. 64 units is what "one band" bought when it was written.
 */
const KRAKEN_TRENCH_DEPTH_MARGIN = 64;

/** A trench the kraken qualifies for: past its depth demand and its area. */
function krakenTrench(): BasinState {
  return announcedTerrain({
    radius: cellsAcross(40),
    floorHeight:
      SEA_LEVEL - (KRAKEN_LAIR_MIN_DEPTH_BANDS * BAND_HEIGHT + KRAKEN_TRENCH_DEPTH_MARGIN),
  });
}

/**
 * The radius of the disc a kraken can actually surface in, inside a given basin.
 *
 * WHY A TEST NEEDS THIS AT ALL. Since the 2026-08-19 spread decision the summon
 * cell is uniform among the region's QUALIFYING cells (summoning.ts's
 * `summonCellIn`) — NOT the basin's deepest cell — so "the kraken is somewhere in
 * the pocket" is all a fixture may assume. Any test that then reshapes the world
 * around the monster has to reshape it around the whole pocket, or it is a test
 * of one hash draw. (It was exactly that until 2026-08-21: a literal puddle
 * radius happened to cover the cell the draw picked, and the re-sample moved the
 * draw.)
 *
 * DERIVED FROM THE BASIN'S OWN RAMP, not measured off the monster: the basin
 * runs linearly from `floorHeight` at the centre to the deep-water line at the
 * rim, so the qualifying cells are the disc where that ramp is still at or below
 * the kraken's admission depth. Scale-free by construction — every term is a
 * height except the radius it multiplies.
 */
function krakenPocketRadiusCells(state: BasinState): number {
  const admissionHeight = SEA_LEVEL - KRAKEN_LAIR_MIN_DEPTH_BANDS * BAND_HEIGHT;
  const ramp = (admissionHeight - state.floorHeight) / (DEEP_WATER_MAX_HEIGHT - state.floorHeight);
  return Math.ceil(ramp * state.radius);
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
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
  });

  it('stays when his basin collapses to a puddle around him', () => {
    const basin = cthulhuBasin();
    const world = basinWorld(basin);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    expect(livingMonster()).not.toBeNull();

    // Park him at the basin's deepest point first: since the 2026-08-19 summon
    // spread he arrives anywhere in the qualifying water, and a rim arrival
    // would dry out under him, which is the stranding case the NEXT test is
    // about. This one is about the region shrinking around him.
    livingMonster()!.x = WORLD_CENTER + 0.5;
    livingMonster()!.y = WORLD_CENTER + 0.5;

    // A pool far below the basin that admitted him, with his own cell still
    // deep — the exact scenario that used to banish him.
    basin.radius = cellsAcross(4);
    expect(Math.PI * basin.radius * basin.radius).toBeLessThan(MIN_LAIR_DEEP_CELLS);
    expect(isLairCell(WATER_HABITAT, world, livingMonster()!.x, livingMonster()!.y)).toBe(true);

    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonster()).not.toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
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
    basin.radius = cellsAcross(30);
    for (let n = 0; n < 100; n++) advanceMonster(world, monster, TICK_DT);

    expect(Math.hypot(monster.x - stranded.x, monster.y - stranded.y)).toBeGreaterThan(0);
    expect(isLairCell(WATER_HABITAT, world, monster.x, monster.y)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WHERE A MONSTER RISES (owner decision, 2026-08-19: spread the arrivals)
//
// The summon cell used to be the region's single deepest cell, which made every
// future arrival of every sea kind land on one cell — and after Deep Strata gave
// players 24 bands to dig through, that cell is typically a one-cell shaft
// somebody sank. It is now hash-picked among the region's QUALIFYING cells.
//
// These pin the three properties that decision has to have: it spreads, it is
// per kind, and it is exactly repeatable. The last one is why the pick is a hash
// of a counter rather than a call to the random source — see rng.hashToIndex.
// ────────────────────────────────────────────────────────────────────────────

describe('summon cells are spread, not pinned to the deepest cell', () => {
  /**
   * Summons one kraken into `world` with the id counter at `nextId`, and
   * reports the cell it took.
   *
   * Driving the counter directly is what makes a distribution testable at all:
   * the seed IS the id (summoning.ts), and a fresh world would otherwise always
   * hand out id 1 and therefore always the same cell. restoreSummoning is the
   * supported way to set it — the same seam persistence uses.
   */
  function summonAt(world: LairWorld, nextId: number): { x: number; y: number } {
    restoreSummoning([], nextId, {});
    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();
    return { x: kraken!.x, y: kraken!.y };
  }

  /** A spread of ids wide enough that one repeated cell cannot hide in it. */
  const PROBE_IDS = Array.from({ length: 32 }, (_, i) => i + 1);

  it('lands on many different cells across successive summons', () => {
    const world = basinWorld(krakenTrench());
    const seen = new Set(PROBE_IDS.map((id) => {
      const cell = summonAt(world, id);
      return `${cell.x},${cell.y}`;
    }));

    // THE DEFECT THIS REPLACES would score exactly 1 here — one cell, forever,
    // for every id. Half the probes landing somewhere new is far below what the
    // hash actually achieves and far above anything the old rule could reach,
    // so it fails loudly on a regression without pinning an exact spread.
    expect(seen.size).toBeGreaterThan(PROBE_IDS.length / 2);
  });

  it('picks a QUALIFYING cell every time, never merely a habitat one', () => {
    // The spread must not become a licence to surface in the shallows: every
    // cell it can pick has to clear the kraken's own trench bar, which is the
    // bar that admitted the region in the first place.
    const trench = krakenTrench();
    const world = basinWorld(trench);
    for (const id of PROBE_IDS) {
      const cell = summonAt(world, id);
      const height = world.heightAt(Math.floor(cell.x), Math.floor(cell.y));
      expect(reachesIntoHabitat(WATER_HABITAT, height, KRAKEN_LAIR_MIN_DEPTH_BANDS)).toBe(true);
    }
  });

  it('is exactly repeatable — same world, same counter, same cell', () => {
    // DETERMINISM, and it is the property that makes the other two testable at
    // all. Two independently constructed worlds of the same shape, driven to the
    // same counter, must agree cell for cell; if this ever fails the pick has
    // picked up a float or the random source.
    const first = PROBE_IDS.map((id) => summonAt(basinWorld(krakenTrench()), id));
    const second = PROBE_IDS.map((id) => summonAt(basinWorld(krakenTrench()), id));
    expect(second).toEqual(first);
  });

  it('does not force the two sea kinds onto one cell any more', () => {
    // The owner's ruling that co-location is ALLOWED stands — this pins only
    // that it is no longer STRUCTURAL. Both kinds qualify the same trench and
    // arrive on the same tick; before the spread they shared the region's
    // extreme cell every single time, by construction.
    let apart = 0;
    for (const id of PROBE_IDS) {
      const world = basinWorld(krakenTrench());
      restoreSummoning([], id, {});
      setMonsterRandomSource(ALWAYS);
      advanceSummoning(world, TICK_DT);
      const kraken = livingMonsterOfKind('kraken')!;
      const cthulhu = livingMonsterOfKind('cthulhu')!;
      if (kraken.x !== cthulhu.x || kraken.y !== cthulhu.y) apart++;
    }
    expect(apart).toBe(PROBE_IDS.length);
  });

  it('scatters the yeti over his snowfield too — the rule is habitat-agnostic', () => {
    // Nothing in the lifecycle knows which habitat it is reading (habitat.ts),
    // and the summon pick is deliberately no exception: a sea-only spread would
    // have been the first rule in this plugin that named a regime, and the
    // summit of a player-built massif is exactly as much a single owned cell as
    // the bottom of a player-dug shaft.
    const world = massifWorld(yetiMassif());
    const seen = new Set(
      PROBE_IDS.map((id) => {
        restoreSummoning([], id, {});
        setMonsterRandomSource(ALWAYS);
        advanceSummoning(world, TICK_DT);
        const yeti = snowMonster()!;
        return `${yeti.x},${yeti.y}`;
      }),
    );
    expect(seen.size).toBeGreaterThan(PROBE_IDS.length / 2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE KRAKEN'S DEPARTURE RULE (owner ruling, 2026-08-19: "For now, no eviction.
// Later, if we do boats, they can attack the kraken.")
//
// The three tests below are the whole contract, and they are written as the
// three things a player might TRY, because the previous rule's defect was that
// it advertised one of them and implemented none. Terrain no longer drives the
// kraken off by taking its habitat away, however that habitat is taken; the
// only departure left is the ground under its own feet, which is physics rather
// than policy. See kinds.ts and summoning.ts for the amendment.
// ────────────────────────────────────────────────────────────────────────────

describe('the kraken is not evicted by terrain (owner ruling, 2026-08-19)', () => {
  it('stays when its region shrinks to a puddle around it', () => {
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    // A trench qualifies Cthulhu too (per-kind slots, 2026-08-19); this test
    // follows the KRAKEN and ignores his roommate.
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();

    // The old collapse threshold was 2 chunks. This pool is an order of
    // magnitude under the kraken's own arrival bar, with the monster's own cell
    // still deep water — which is precisely the state that used to banish it and
    // now must not.
    //
    // THE PUDDLE IS THE SUMMON POCKET, not a literal radius: the kraken may have
    // surfaced anywhere in it (see krakenPocketRadiusCells), so this is the
    // smallest pool that is guaranteed to still be under whichever cell the draw
    // chose. The assertion below is what keeps it a puddle — it is a real pool
    // an order of magnitude short of the arrival bar, not a pool sized to pass.
    trench.radius = krakenPocketRadiusCells(trench) + 1;
    expect(Math.PI * trench.radius * trench.radius).toBeLessThan(KRAKEN_MIN_LAIR_DEEP_CELLS / 10);
    expect(isLairCell(WATER_HABITAT, world, kraken!.x, kraken!.y)).toBe(true);

    // Well past the survey cadence: if a region test were still running, this
    // is where it would fire.
    for (let n = 0; n < (LAIR_SURVEY_INTERVAL_SECONDS * 3) / TICK_DT; n++) {
      advanceSummoning(world, TICK_DT);
      enforceHabitat(world);
    }
    expect(livingMonsterOfKind('kraken')).not.toBeNull();
    expect(livingMonsterOfKind('kraken')!.id).toBe(kraken!.id);
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
  });

  it('stays when its trench is refilled to shallower than the depth that summoned it', () => {
    // THE MECHANIC THE OLD COMMENT SOLD, now correct BY DESIGN rather than by
    // accident. It never worked — collapse counted 3-band deep-water cells, so
    // filling a 7-band trench back to 4 bands changed nothing it measured — and
    // the ruling makes that the intended answer instead of a latent bug.
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();

    // Refill: still deep water everywhere, but nowhere near a trench any more.
    trench.floorHeight = SEA_LEVEL - (DEEP_WATER_BANDS_BELOW_SEA + 1) * BAND_HEIGHT;
    expect(
      reachesIntoHabitat(WATER_HABITAT, trench.floorHeight, KRAKEN_LAIR_MIN_DEPTH_BANDS),
    ).toBe(false);
    expect(isDeepWaterHeight(trench.floorHeight)).toBe(true);

    for (let n = 0; n < (LAIR_SURVEY_INTERVAL_SECONDS * 3) / TICK_DT; n++) {
      advanceSummoning(world, TICK_DT);
      enforceHabitat(world);
    }
    expect(livingMonsterOfKind('kraken')!.id).toBe(kraken!.id);
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
  });

  it('submerges the moment its OWN cell stops being deep water — physics, not policy', () => {
    // The one departure a player can still cause, and the reason the kraken
    // keeps a BanishmentRule and a cooldown at all: a kraken standing on dry
    // land is a rendering bug, not a gameplay outcome.
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();

    // The sea is GONE, its own cell included.
    trench.radius = 0;
    expect(isLairCell(WATER_HABITAT, world, kraken!.x, kraken!.y)).toBe(false);

    // No survey needed — the habitat check runs every tick, and here directly.
    expect(enforceHabitat(world)).toBe(true);
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
    // The unbanishable roommate is left standing in the dry basin.
    expect(livingMonsterOfKind('cthulhu')).not.toBeNull();
  });

  it('submerges when the ground is raised out from under it', () => {
    const harness = boot(bowl(TRENCH_RADIUS));
    setMonsterRandomSource(ALWAYS);
    tick(harness, 1);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();
    // Stop the roll: this test is about the departure, and an always-firing roll
    // would re-summon it the moment the cooldown is examined.
    setMonsterRandomSource(NEVER);

    // Cthulhu co-arrives on the same survey cell (per-kind slots, 2026-08-19)
    // and his ground protection would veto these raises — real behaviour, but
    // the veto has its own tests. Walk him clear so the drying goes through.
    const cthulhu = livingMonsterOfKind('cthulhu')!;
    cthulhu.x = 1.5;
    cthulhu.y = 1.5;

    const cellX = Math.floor(kraken!.x);
    const cellY = Math.floor(kraken!.y);

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
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
  });

  it('refuses to summon again until the cooldown is served, then summons exactly one', () => {
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const firstId = livingMonsterOfKind('kraken')!.id;

    // Dry the basin out from under it — the only departure terrain can still
    // cause (owner ruling, 2026-08-19), and the one that starts the cooldown.
    trench.radius = 0;
    expect(enforceHabitat(world)).toBe(true);
    expect(livingMonsterOfKind('kraken')).toBeNull();

    // The trench is back, and a roll that fires on every single tick, for one
    // second short of the cooldown. The gate is the only thing holding it back.
    trench.radius = cellsAcross(40);
    for (let n = 0; n < (KRAKEN_RESPAWN_COOLDOWN_SECONDS - 2) / TICK_DT; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBeGreaterThan(0);

    for (let n = 0; n < 3 / TICK_DT; n++) advanceSummoning(world, TICK_DT);
    // Exactly one KRAKEN again (his unbanishable roommate never left).
    expect(livingCountOfKind('kraken')).toBe(1);
    // A NEW monster, not the old one restored: ids are never reused.
    expect(livingMonsterOfKind('kraken')!.id).toBeGreaterThan(firstId);
  });
});

describe('per-kind slots (2026-08-19 — was: the kinds contest one slot)', () => {
  it('a trench world comes to hold BOTH sea kinds at once — Cthulhu no longer blocks the kraken', () => {
    // THE OWNER'S BUG, pinned: a trench qualifies both kinds (any deep basin
    // admits Cthulhu; the trench additionally admits the kraken), and under
    // the old per-habitat slot whichever summoned first held the sea forever.
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    tick(harness, 1);

    expect(livingMonsterCount()).toBe(2);
    const kraken = livingMonsterOfKind('kraken');
    const cthulhu = livingMonsterOfKind('cthulhu');
    expect(kraken).not.toBeNull();
    expect(cthulhu).not.toBeNull();
    expect(isLairCell(WATER_HABITAT, lairView(harness.world), kraken!.x, kraken!.y)).toBe(true);
    expect(isLairCell(WATER_HABITAT, lairView(harness.world), cthulhu!.x, cthulhu!.y)).toBe(true);
  });

  it('never holds two of the same kind, however many rolls fire', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot(bowl(TRENCH_RADIUS));
    // Five simulated minutes of a roll that fires on every tick: the per-kind
    // slot is the only thing holding duplicates back, so this is its test.
    for (let n = 0; n < 3000; n++) {
      tick(harness, 1);
      const kinds = livingMonsters().map((monster) => monster.kind);
      if (new Set(kinds).size !== kinds.length) {
        throw new Error(`duplicate kind alive: ${kinds.join(', ')}`);
      }
    }
    expect(livingMonsterCount()).toBe(2); // both sea kinds, no yeti (no snow)
  });

  it('cooldowns are per kind: banishing the kraken neither removes Cthulhu nor delays him', () => {
    setMonsterRandomSource(ALWAYS);
    const trench = krakenTrench();
    const world = basinWorld(trench);
    for (let n = 0; n < 2; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonsterCount()).toBe(2);

    // Dry the basin out from under BOTH of them: the kraken leaves on the
    // physics rule and serves its cooldown, Cthulhu (unbanishable) stays put
    // exactly where he was. Shrinking the region no longer moves either one
    // (owner ruling, 2026-08-19), so the departure has to come from the cell.
    trench.radius = 0;
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
      enforceHabitat(world);
    }
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBeGreaterThan(0);
    expect(livingMonsterOfKind('cthulhu')).not.toBeNull();
    expect(cooldownRemainingSecondsFor('cthulhu')).toBe(0);
    expect(cooldownRemainingSecondsFor('yeti')).toBe(0);
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
    const tinyRadius = cellsAcross(10);
    const world = basinWorld({
      radius: tinyRadius,
      floorHeight: SEA_LEVEL - (KRAKEN_LAIR_MIN_DEPTH_BANDS + 1) * BAND_HEIGHT,
    });
    expect(Math.PI * tinyRadius * tinyRadius).toBeLessThan(MIN_LAIR_DEEP_CELLS);

    setMonsterRandomSource(ALWAYS);
    for (let n = 0; n < 600; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonster()).toBeNull();
  });
});

describe('kraken bar at the natural ocean floor (owner-decided 2026-08-19)', () => {
  it('admits the deepest floor worldgen naturally shows — no manual dig', () => {
    // Genesis ocean floors bottom out at band −8 (−512) and the first
    // relaxation that reaches their rim shaves up to MAX_STEP/2 = 16 off the
    // extreme cell, so the deepest floor a live world actually shows is −496.
    // That exact height must clear the kraken's admission test: the decision
    // removes the last mandatory dig, so this pin is the decision.
    // 504 since the 2026-08-20 re-terrace, from 496. The reference floor is
    // unchanged at 512 units; only the relaxation margin moved, because
    // MAX_STEP is now BAND_HEIGHT rather than half of it. The DEPTH the owner
    // ruled on did not move — the relaxation simply shaves less off it.
    //
    // 510 since the 2026-08-21 re-sample, and for the third time the REFERENCE
    // FLOOR IS STILL 512: MAX_STEP is the most the world may fall between two
    // ADJACENT CELLS, cells are now a quarter of a world unit apart, so the one
    // relaxation that reaches the extreme cell shaves a quarter of what it did.
    // The slope is identical (one band per world unit either side of the
    // re-sample) — a finer grid simply measures the shave more finely. The first
    // assertion is the contract and the literal is documentation of it; if only
    // the literal ever fails, the margin moved and the depth did not.
    expect(NATURAL_OCEAN_FLOOR_MIN_DEPTH).toBe(
      GENESIS_DEEP_OCEAN_REFERENCE_DEPTH - MAX_STEP / 2,
    );
    expect(NATURAL_OCEAN_FLOOR_MIN_DEPTH).toBe(510);
    expect(
      reachesIntoHabitat(
        WATER_HABITAT,
        SEA_LEVEL - NATURAL_OCEAN_FLOOR_MIN_DEPTH,
        KRAKEN_LAIR_MIN_DEPTH_BANDS,
      ),
    ).toBe(true);
  });

  it('summons a kraken into a natural-floor trench', () => {
    // The behavioural half of the pin above: a basin no deeper than the
    // natural floor, big enough for the kraken's area demand, produces a
    // kraken with no sculpting at all.
    const world = basinWorld({
      radius: cellsAcross(40),
      floorHeight: SEA_LEVEL - NATURAL_OCEAN_FLOOR_MIN_DEPTH,
    });
    setMonsterRandomSource(ALWAYS);
    for (let n = 0; n < 600; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonstersIn(WATER_HABITAT).some((m) => m.kind === 'kraken')).toBe(
      true,
    );
  });

  // ── The derivation, checked against the REAL generator ────────────────────
  //
  // The bar's comment in kinds.ts used to assert three facts about worldgen
  // that a correctness pass (2026-08-19) found wrong. These pin the corrected
  // ones against server/src/world/world.ts itself — the same
  // assert-the-core-relation-from-the-plugin-side arrangement wildlife uses
  // for FRESH_SEABED_BANDS_BELOW_SEA, and for the same reason: core cannot
  // import a plugin's constants, so the plugin owns the agreement.

  /** A fixed seed list: genesis is a pure function of it, so this is stable. */
  const GENESIS_PROBE_SEEDS = Array.from({ length: 48 }, (_, i) => (i * 2654435761) >>> 0);
  const GENESIS_PROBE_SIZE = cellsAcross(128);

  /** Deepest genesis cell of one world, whole-world and inside the unlock box. */
  function genesisFloors(seed: number): { world: number; unlocked: number } {
    const terrain = buildFreshGenesisTerrain(GENESIS_PROBE_SIZE, seed);
    const { startChunk, spanChunks } = initialUnlockFootprint(GENESIS_PROBE_SIZE);
    const lo = startChunk * CHUNK_SIZE;
    const hi = lo + spanChunks * CHUNK_SIZE - 1;

    let world = Number.POSITIVE_INFINITY;
    let unlocked = Number.POSITIVE_INFINITY;
    for (let y = 0; y < GENESIS_PROBE_SIZE; y++) {
      for (let x = 0; x < GENESIS_PROBE_SIZE; x++) {
        const height = freshGenesisHeightAt(terrain, x, y);
        if (height < world) world = height;
        if (x >= lo && x <= hi && y >= lo && y <= hi && height < unlocked) unlocked = height;
      }
    }
    return { world, unlocked };
  }

  it('reads a genesis floor as an exact band multiple — nothing smooths it', () => {
    // The FIRST corrected claim. World.createFresh writes
    // outerTerrainBandAt(...) * BAND_HEIGHT and never relaxes, so -496 is not
    // a height genesis can produce: it is a genesis floor a later EDIT shaved.
    // If this ever fails, the -MAX_STEP/2 margin has stopped being a margin
    // and started being part of a height the generator actually writes.
    for (const seed of GENESIS_PROBE_SEEDS) {
      const { world } = genesisFloors(seed);
      expect(world % BAND_HEIGHT === 0).toBe(true);
    }
  });

  // ── The guarantee, superseding the mixture this block used to pin ─────────
  //
  // WHAT THIS REPLACED, and why the replacement is not a weakening. Until
  // 2026-08-19 this block held a test called "does not promise every world a
  // dig-free kraken — only a deep-floored one". It asserted a MIXTURE over
  // these same 48 seeds — some qualify, some do not — and it deliberately
  // failed if ALL of them qualified, on the reading that a worldgen change
  // handing every world a kraken would be a silently different game. That
  // reading was correct AS A GUARD: it was written to force the question to an
  // owner rather than let it drift. The owner has now answered it. Every fresh
  // world gets a qualifying basin, by construction, from the trench pass in
  // `server/src/world/world.ts` (see its "The trench" section).
  //
  // So the mixture assertion is gone and the guarantee is pinned in its place.
  // The guard it provided is NOT gone: the second test below keeps measuring
  // the mixture the NOISE ALONE produces, so if worldgen ever flattens — or
  // the trench pass turns into a stamp that would have fired anyway — the
  // guarantee stops being attributable to the pass and this block goes red
  // rather than vacuously green.
  //
  // THE UNLOCK CAVEAT, restated rather than dropped. The guarantee is about
  // TERRAIN. `isLairCell` still requires an unlocked cell, so a world whose
  // trench lies outside the starter square hands its kraken over when the
  // player's territory reaches it — that is progression, it is unchanged, and
  // it is why these tests survey with unlock answered "yes" everywhere.

  /**
   * Both sizes the 2026-08-19 review measured: smallest shipped, and default.
   *
   * IN CELLS, CONVERTED FROM WORLD UNITS (2026-08-21). The two numbers are the
   * spans DEFAULT_WORLD_SPAN documents — 128 world units, "the Populous-proven
   * playable minimum", and the 512 default — and they are facts about how much
   * LAND the guarantee is checked over, so the re-sample had to convert them.
   * Left as literal cells they became a 32-world-unit map and a 128-world-unit
   * one, and the smaller of those has fewer cells IN TOTAL (16 384) than the
   * kraken's own area bar (KRAKEN_MIN_LAIR_DEEP_CELLS = 36 864) demands, so all
   * 48 seeds failed a guarantee that no world of that size could ever meet.
   */
  const GENESIS_PROBE_SIZES = [GENESIS_PROBE_SIZE, cellsAcross(DEFAULT_WORLD_SPAN)];

  /**
   * A full-size-per-seed sweep, twice over, is a real amount of work: two full
   * world generations and two full habitat surveys per seed.
   *
     * RE-MEASURED AFTER THE 2026-08-21 RE-SAMPLE at ~76 s per test, from ~4 s: the
   * default world is 2048² cells rather than 512², and both halves of the sweep
   * walk every one of them. Held at the same 5x margin.
   *
   * The first number recorded here was 15 s and it was WRONG — taken from a
   * standalone script that called the same functions, not from the test, which
   * pays for vitest's module graph and the Int16Array allocation per world on
   * top. It set a budget the test then sat 1% under, so it passed alone and
   * failed under full-suite load. Measure a timeout by timing the TEST.
   */
  const GENESIS_SWEEP_TIMEOUT_MS = 450_000;

  /**
   * Does this heightmap contain a basin the kraken would take? Asked through
   * the REAL survey and the REAL admission predicate — no reimplementation of
   * either — so what it answers is precisely what summoning.ts would answer.
   *
   * `isCellUnlocked` says yes everywhere ON PURPOSE: see the unlock caveat
   * above. This measures what the generator BUILT, not what day one reveals.
   */
  function hasQualifyingBasin(heights: Int16Array, size: number): boolean {
    const view: LairWorld = {
      worldSize: size,
      heightAt: (x, y) => heights[y * size + x]!,
      isCellUnlocked: () => true,
    };
    return surveyLairs(WATER_HABITAT, view).regions.some(
      (region) =>
        region.cells >= KRAKEN_MIN_LAIR_DEEP_CELLS &&
        reachesIntoHabitat(WATER_HABITAT, region.extremeHeight, KRAKEN_LAIR_MIN_DEPTH_BANDS),
    );
  }

  /** A fresh world exactly as the server ships it, trench pass included. */
  function freshWorldHeights(size: number, seed: number): Int16Array {
    return World.createFresh(size, undefined, undefined, seed).map.cells;
  }

  /**
   * The same world as the seeded NOISE alone drew it — the trench pass nulled
   * out, which is by construction the field genesis produced before the pass
   * existed (the trench is the only term added to `freshGenesisHeightAt`).
   */
  function untrenchedWorldHeights(size: number, seed: number): Int16Array {
    const terrain = { ...buildFreshGenesisTerrain(size, seed), trenches: [] };
    const heights = new Int16Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) heights[y * size + x] = freshGenesisHeightAt(terrain, x, y);
    }
    return heights;
  }

  it(
    'promises EVERY fresh world a kraken-qualifying basin (owner-ratified 2026-08-19)',
    () => {
      // THE GUARANTEE, at both shipped sizes, over the same 48 seeds the
      // mixture test used. Not "most", not "the deep-floored ones": all of
      // them, or the owner's decision has regressed.
      for (const size of GENESIS_PROBE_SIZES) {
        const missing = GENESIS_PROBE_SEEDS.filter(
          (seed) => !hasQualifyingBasin(freshWorldHeights(size, seed), size),
        );
        expect({ size, missing }).toEqual({ size, missing: [] });
      }
    },
    GENESIS_SWEEP_TIMEOUT_MS,
  );

  it(
    'gets that promise from the trench pass — the noise alone still varies',
    () => {
      // THE ANTI-VACUOUS COMPANION, and the surviving half of the mixture test
      // this block replaced. If worldgen is ever flattened, or the noise range
      // widened until every seed digs its own trench, the guarantee above would
      // still pass while meaning nothing. This fails in that case: the noise on
      // its own must go on producing BOTH kinds of world.
      for (const size of GENESIS_PROBE_SIZES) {
        const qualifies = GENESIS_PROBE_SEEDS.map((seed) =>
          hasQualifyingBasin(untrenchedWorldHeights(size, seed), size),
        );
        expect(qualifies.some((ok) => ok)).toBe(true);
        expect(qualifies.some((ok) => !ok)).toBe(true);
      }
    },
    GENESIS_SWEEP_TIMEOUT_MS,
  );

  it('leaves the day-one UNLOCKED floor a mixture — progression is untouched', () => {
    // The half of the old mixture test that is still true, kept because it is
    // still the honest answer to "does every new world hand out a kraken on
    // day one". It does not: only UNLOCKED cells are habitat, the starter
    // square is day one's whole world, and the trench lands wherever the
    // world's deepest ocean already was. Some worlds get it immediately;
    // the rest get it as their territory grows.
    const qualifies = GENESIS_PROBE_SEEDS.map((seed) =>
      reachesIntoHabitat(
        WATER_HABITAT,
        genesisFloors(seed).unlocked,
        KRAKEN_LAIR_MIN_DEPTH_BANDS,
      ),
    );
    expect(qualifies.some((ok) => ok)).toBe(true);
    expect(qualifies.some((ok) => !ok)).toBe(true);
  });

  it('is not the deepest band genesis can reach — the reference is not a bound', () => {
    // Band -8 was written into the comment as "the deepest an ordinary ocean
    // settles at". The lattice range is [-10, +4], so worlds go deeper; this
    // pins that the reference band is a REFERENCE and the bar admits what lies
    // below it, rather than the bar being the floor of the world.
    const deepest = Math.min(...GENESIS_PROBE_SEEDS.map((seed) => genesisFloors(seed).world));
    expect(deepest).toBeLessThan(SEA_LEVEL - NATURAL_OCEAN_FLOOR_MIN_DEPTH);
    expect(
      reachesIntoHabitat(WATER_HABITAT, deepest, KRAKEN_LAIR_MIN_DEPTH_BANDS),
    ).toBe(true);
  });

  it('is 31 whole bands, and Deep Strata must not drag it', () => {
    // Deep Strata deepened MIN_HEIGHT from −1024 to −1536 the same day this
    // bar was decided. The bar derives from the natural ocean floor, NOT from
    // the world's height range: if this pin fails after a MIN_HEIGHT retune,
    // the derivation has regressed to a range-anchored one and the bar moved
    // without an owner decision.
    // 31 bands since the 2026-08-20 re-terrace, and that is the POINT of the
    // conversion rather than a regression: the bar is 504 height units either
    // way, and only the number of terraces that fit in it changed.
    expect(KRAKEN_LAIR_MIN_DEPTH_BANDS).toBe(31);
    expect(KRAKEN_LAIR_MIN_DEPTH_BANDS).toBe(
      Math.floor(NATURAL_OCEAN_FLOOR_MIN_DEPTH / BAND_HEIGHT),
    );
  });

  it('is the same bar the generator plans its trench against', () => {
    // THE RESTATEMENT PIN. server/src/world/world.ts cannot import this
    // plugin's constants (core must not depend on a plugin), so the trench
    // pass restates three of them — the lair area, the reference ocean floor,
    // and the bar derived from it. This is the plugin side of that agreement,
    // the same arrangement wildlife owns for FRESH_SEABED_BANDS_BELOW_SEA: if
    // either side is retuned alone, THIS fails, rather than every fresh world
    // silently losing (or being handed) a kraken.
    expect(GENESIS_TRENCH_MIN_BASIN_CELLS).toBe(KRAKEN_MIN_LAIR_DEEP_CELLS);
    expect(GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA).toBe(GENESIS_DEEP_OCEAN_REFERENCE_BAND);
    expect(GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA).toBe(KRAKEN_LAIR_MIN_DEPTH_BANDS);

    // And the margin the bar's own derivation names: the generator cuts to the
    // reference floor, which is strictly deeper than the bar it must clear.
    expect(GENESIS_TRENCH_FLOOR_BANDS_BELOW_SEA).toBeGreaterThan(
      GENESIS_TRENCH_QUALIFYING_BANDS_BELOW_SEA,
    );
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
    // survives a reboot, and Cthulhu is no longer one. Cthulhu co-arrives on
    // any trench (per-kind slots, 2026-08-19) and rides along in the slice.
    //
    // The eviction is the PHYSICS one — the water taken away from under it —
    // because since the 2026-08-19 owner ruling that is the only departure
    // terrain can cause. (It used to shrink the trench and let the region test
    // fire; that test no longer exists for the kraken.) This is a stub world,
    // so Cthulhu's ground protection is not in the loop and his presence costs
    // this test nothing.
    setMonsterRandomSource(ALWAYS);
    const trench = krakenTrench();
    const world = basinWorld(trench);
    advanceSummoning(world, TICK_DT);
    expect(livingMonsterOfKind('kraken')).not.toBeNull();

    trench.radius = 0;
    expect(enforceHabitat(world)).toBe(true);
    expect(livingMonsterOfKind('kraken')).toBeNull();

    const snapshot = saveMonsters();
    // Cthulhu (unbanishable) is still out there and rides along in the slice.
    expect(snapshot.monsters.map((entry) => entry.kind)).toEqual(['cthulhu']);
    expect(snapshot.cooldownSeconds.kraken).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
    // No other kind had anything to do with this and none is written at all.
    expect(snapshot.cooldownSeconds.yeti).toBeUndefined();
    expect(snapshot.cooldownSeconds.cthulhu).toBeUndefined();

    // Reboot onto the restored (full-size) trench. Without the persisted
    // cooldown, the very next tick would roll a fresh kraken — a restart
    // would be a way to skip the banishment.
    trench.radius = cellsAcross(40);
    resetMonstersState();
    loadMonsters(JSON.parse(JSON.stringify(snapshot)) as unknown);
    for (let n = 0; n < 100; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBeGreaterThan(0);
    expect(livingMonsterOfKind('cthulhu')).not.toBeNull();
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

    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS_PER_KIND);
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
      for (const kind of MONSTER_KINDS) {
        expect(cooldownRemainingSecondsFor(kind)).toBe(0);
      }
    }
  });

  it('clamps a nonsense cooldown instead of trusting it', () => {
    for (const cooldownSeconds of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      resetMonstersState();
      loadMonsters({ version: 2, monsters: [], nextId: 3, cooldownSeconds: { water: cooldownSeconds, land: cooldownSeconds } });
      for (const kind of MONSTER_KINDS) {
        expect(cooldownRemainingSecondsFor(kind)).toBe(0);
      }

      // ...and in the version-1 shape, where the cooldown was one scalar.
      resetMonstersState();
      loadMonsters({ version: 1, monster: null, nextId: 3, cooldownSeconds });
      expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
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
    expect(cooldownRemainingSecondsFor('kraken')).toBeGreaterThan(0);

    // (Cthulhu also arrives on this trench under the always-firing roll —
    // per-kind slots — which only sharpens the assertion: EVERY id handed out
    // after the restore, his included, is past the restored high-water mark.)
    tick(harness, KRAKEN_RESPAWN_COOLDOWN_SECONDS / TICK_DT + 2);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();
    expect(kraken!.id).toBeGreaterThan(9);
    for (const monster of livingMonsters()) expect(monster.id).toBeGreaterThan(9);
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
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
  });

  it('migrates a version-1 slice, and its cooldown is the KRAKEN\'s', () => {
    // Version 1 predates the land habitat entirely — every kind it could name
    // lives in the sea — and of those only the kraken is banishable, so its one
    // world-wide cooldown is a kraken cooldown by construction rather than by
    // guess, and every other kind starts free.
    resetMonstersState();
    loadMonsters({
      version: 1,
      nextId: 12,
      cooldownSeconds: 42,
      monster: { id: 11, kind: 'kraken', x: 3.5, y: 4.5, heading: 1 },
    });

    expect(seaMonster()).toMatchObject({ id: 11, kind: 'kraken', x: 3.5, y: 4.5 });
    expect(snowMonster()).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBe(42);
    expect(cooldownRemainingSecondsFor('yeti')).toBe(0);
  });

  it('round-trips one monster per KIND, and drops a smuggled same-kind duplicate', () => {
    // Since the 2026-08-19 per-kind slots, a v2 snapshot holding BOTH sea kinds
    // restores both — that is the point of the change — and the duplicate the
    // slot gates out is a second monster of the SAME kind.
    resetMonstersState();
    loadMonsters({
      version: 2,
      nextId: 30,
      cooldownSeconds: { land: 7 },
      monsters: [
        { id: 21, kind: 'cthulhu', x: 1.5, y: 2.5, heading: 0 },
        { id: 22, kind: 'yeti', x: 3.5, y: 4.5, heading: 1 },
        { id: 23, kind: 'kraken', x: 5.5, y: 6.5, heading: 2 },
        // A hand-edited SECOND cthulhu. The per-kind slot is the gate.
        { id: 24, kind: 'cthulhu', x: 7.5, y: 8.5, heading: 3 },
      ],
    });

    expect(livingMonsterCount()).toBe(3);
    expect(livingMonsterOfKind('cthulhu')!.id).toBe(21);
    expect(livingMonsterOfKind('kraken')!.id).toBe(23);
    expect(snowMonster()!.id).toBe(22);
    // The v2 per-habitat land cooldown migrated to the yeti, its only owner.
    expect(cooldownRemainingSecondsFor('yeti')).toBe(7);

    // ...and the save side agrees, per kind, in the fixed MONSTER_KINDS order,
    // at the current (per-kind) slice version.
    const saved = saveMonsters();
    expect(saved.version).toBe(3);
    expect(saved.monsters.map((entry) => entry.kind)).toEqual(['kraken', 'cthulhu', 'yeti']);
    expect(saved.cooldownSeconds).toEqual({ yeti: 7 });

    // And the v3 slice round-trips whole: two living SEA monsters — the shape
    // the per-kind slots exist to hold — survive a save/load cycle intact.
    resetMonstersState();
    loadMonsters(JSON.parse(JSON.stringify(saved)) as unknown);
    expect(livingMonsterOfKind('cthulhu')!.id).toBe(21);
    expect(livingMonsterOfKind('kraken')!.id).toBe(23);
    expect(snowMonster()!.id).toBe(22);
    expect(cooldownRemainingSecondsFor('yeti')).toBe(7);
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

  it('bounds the brush by intent.radius — shared\'s own footprint, every radius', () => {
    // THE CONTRACT, not the callsite. reachesProtectedGround models the brush
    // as the open disc of `intent.radius` about its centre cell's centre. That
    // was written when applyBrush's membership test WAS `dx² + dy² < radius²`;
    // shared tightened it to `dx² + dy² < radius·(radius − 1)` (issue: the
    // rounder Populous brush, 2026-08-19) and the model became a BOUND rather
    // than an equality.
    //
    // A bound is fine — erring wide refuses a raise that could not have
    // touched the monster — but only while it holds. Asked of shared's own
    // forEachFootprintOffset so the day the footprint widens past the disc,
    // this fails instead of the aura silently going fail-open and letting a
    // raise land on Cthulhu.
    for (let radius = MIN_BRUSH_RADIUS; radius <= MAX_BRUSH_RADIUS; radius++) {
      forEachFootprintOffset(radius, (dx, dy) => {
        expect(dx * dx + dy * dy).toBeLessThan(radius * radius);
      });
    }
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
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();
    setMonsterRandomSource(NEVER);

    // Cthulhu co-arrives on any trench (per-kind slots, 2026-08-19) at the
    // same survey cell, and HIS aura would veto this raise — which is itself
    // real behaviour now, but not what this test pins. Walk him far away
    // (positions are live-mutable; the lurk step does the same) so the raise
    // is answered by the kraken's flag alone.
    const cthulhu = livingMonsterOfKind('cthulhu')!;
    cthulhu.x = 1.5;
    cthulhu.y = 1.5;

    const cell = { x: Math.floor(kraken!.x), y: Math.floor(kraken!.y) };
    expect(profileOf('kraken').protectsGround).toBe(false);
    expect(sculpt(harness, cell.x, cell.y, 1).applied).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ISSUE #19 — THE EXACT SCENARIO THE ISSUE WAS FILED FOR: a raise refused
// because Cthulhu occupies the ground must cost the player nothing. Loads the
// REAL mana plugin alongside monsters, in the real discovery order (mana
// sorts before monsters alphabetically — plugins/mana, plugins/monsters), so
// the fix is proven against the two plugins that exposed the bug, not a
// stand-in for either.
// ────────────────────────────────────────────────────────────────────────────

describe('issue #19 — Cthulhu’s veto costs zero mana', () => {
  /** Boots mana + monsters together, mana first — the real load order. */
  function bootWithMana(): Harness {
    resetMonstersState();
    resetManaState();

    const world = worldWithTerrain(WORLD_SIZE, bowl(GREAT_BASIN_RADIUS));
    const sink = new RecordingSink();
    world.setSink(sink);

    const host = new PluginHost(world, [manaPlugin, monstersPlugin].map(asLoadedPlugin));
    host.worldCreate();
    world.addPlayer(PLAYER);
    host.playerJoined(PLAYER);

    return { world, host, sink };
  }

  function sculptWithMana(
    harness: Harness,
    x: number,
    y: number,
    dir: 1 | -1,
    radius = MAX_BRUSH_RADIUS,
    // 'hard' is this block's default because the veto tests are about a raise
    // reaching Cthulhu, and a hard stamp moves the whole footprint. The price
    // test below overrides it: MANA_COST_PER_MIN_RADIUS_SCULPT is the SOFT point
    // brush, and the two profiles stopped agreeing when the point brush stopped
    // being one cell (2026-08-21) — a falloff needs more than one cell to fall
    // off over.
    profile: SculptProfile = 'hard',
  ): ReturnType<typeof handleSculptIntent> {
    return handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x, y, radius, dir, tool: 'stamp', profile },
    );
  }

  it('refuses a raise aimed at Cthulhu and charges the player nothing', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = bootWithMana();
    tick(harness, 1);
    expect(livingMonster()!.kind).toBe('cthulhu');
    setMonsterRandomSource(NEVER);
    harness.sink.clear();

    const before = manaBalanceOf(PLAYER.id);
    expect(before).toBe(MANA_CAPACITY);

    const monster = livingMonster()!;
    const cell = { x: Math.floor(monster.x), y: Math.floor(monster.y) };
    const outcome = sculptWithMana(harness, cell.x, cell.y, 1);

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) expect(outcome.reason).toBe('plugin-denied');
    // The load-bearing assertion (issue #19): mana's own onIntent had already
    // allowed by the time monsters denied — the pool must still be untouched.
    expect(manaBalanceOf(PLAYER.id)).toBe(before);
  });

  it('still charges the standard price for a raise Cthulhu does not contest', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = bootWithMana();
    tick(harness, 1);
    expect(livingMonster()!.kind).toBe('cthulhu');
    setMonsterRandomSource(NEVER);
    harness.sink.clear();

    const before = manaBalanceOf(PLAYER.id);

    // Well clear of his protected disc: the same clearance the "draws the
    // line" test above uses, plus a margin, on the opposite axis so the brush's
    // own footprint cannot reach him either.
    //
    // THE BRUSH IS THE POINT BRUSH, not MIN_BRUSH_RADIUS (2026-08-21). The price
    // this test names, mana's MANA_COST_PER_MIN_RADIUS_SCULPT, is derived from
    // POINT_BRUSH_RADIUS_CELLS — one world unit of ground — and since the
    // re-sample that is no longer the same brush as the protocol's one-cell
    // floor. Sculpting at the floor and charging the point-brush price is a
    // sixteenth of the footprint against the full fee.
    const monster = livingMonster()!;
    const reach = POINT_BRUSH_RADIUS_CELLS + groundProtectionRadiusCells(profileOf('cthulhu'));
    const clearX = Math.floor(monster.x + reach + 5);
    const clearY = Math.floor(monster.y);

    const outcome = sculptWithMana(
      harness,
      clearX,
      clearY,
      1,
      POINT_BRUSH_RADIUS_CELLS,
      'soft',
    );

    expect(outcome.applied).toBe(true);
    expect(manaBalanceOf(PLAYER.id)).toBe((before ?? 0) - MANA_COST_PER_MIN_RADIUS_SCULPT);
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
    // In WORLD UNITS per second, converted — every speed in the game is stated
    // that way since the 2026-08-21 re-sample.
    const WILDLIFE_WHALE_CRUISE_CELLS_PER_SECOND = cellsAcross(0.8);
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

  it('arrives on a snowfield, on a cell that qualifies', () => {
    setMonsterRandomSource(ALWAYS);
    const world = massifWorld(yetiMassif());
    advanceSummoning(world, TICK_DT);

    const yeti = snowMonster();
    expect(yeti).not.toBeNull();
    expect(yeti!.kind).toBe('yeti');
    expect(isLairCell(LAND_HABITAT, world, yeti!.x, yeti!.y)).toBe(true);
    // WAS "at its summit" until the 2026-08-19 spread (owner decision): the
    // summon cell is now hash-picked among the region's qualifying cells, so
    // the summit is one candidate rather than the answer. What survives is the
    // half that was ever load-bearing — he stands on ground that meets his own
    // bar — plus the cell-centre offset, which is why the halves are .5.
    expect(
      reachesIntoHabitat(
        LAND_HABITAT,
        world.heightAt(Math.floor(yeti!.x), Math.floor(yeti!.y)),
        profileOf('yeti').minLairReachBands,
      ),
    ).toBe(true);
    expect(yeti!.x % 1).toBe(0.5);
    expect(yeti!.y % 1).toBe(0.5);
    expect(seaMonster()).toBeNull();
  });

  it('never arrives on a snowfield too small to be a lair', () => {
    setMonsterRandomSource(ALWAYS);
    // Deep enough into the snow, far too little of it: height alone is not a
    // lair, which is the half of the rule the area threshold carries. A radius
    // of 1 world unit is ~50 cells, under the demand of 56.
    //
    // IT WAS A RADIUS OF 6 until the 2026-08-22 rescale: the yeti is a quarter
    // of the size he was and his minimum lair, derived from his body-width,
    // fell by the square. It was 1.5 world units until the 2026-08-23 cut
    // lowered the demand from 168 cells to 56 (kinds.ts). The fixture shrinks
    // with the threshold each time, and the thing it pins — a snowfield deep in
    // the snow line and still too small — is unchanged. The assertion below is
    // what keeps that honest: it fails rather than silently passing if the
    // fixture ever stops being under the bar.
    const tinyRadius = cellsAcross(0.6);
    const world = massifWorld({
      radius: tinyRadius,
      peakHeight: SNOW_LINE_MIN_HEIGHT + 4 * BAND_HEIGHT,
    });
    expect(Math.PI * tinyRadius * tinyRadius).toBeLessThan(YETI_MIN_LAIR_SNOW_CELLS);

    for (let n = 0; n < 600; n++) advanceSummoning(world, TICK_DT);
    expect(livingMonsters()).toEqual([]);
  });

  it('arrives on a snowfield too small for the pre-amendment bar', () => {
    // Owner decision, 2026-08-19: the bar dropped to a third of what it was.
    // A radius-8 snowfield is past the CURRENT demand and short of the OLD one,
    // so this world pins the actual behaviour change: it summons a yeti now and
    // would have summoned nothing before the amendment.
    //
    // BOTH SIDES IN WORLD UNITS, converted (2026-08-21). The amendment was about
    // how much GROUND a yeti needs, so the pre-amendment bar is 512 square world
    // units and the fixture is a radius of 8 world units — the same snowfield
    // this test always described, now sampled by sixteen times the cells.
    const snowfieldRadius = cellsAcross(8);
    const preAmendmentBarCells = cellsOverArea(512);
    const snowfieldCells = Math.PI * snowfieldRadius * snowfieldRadius;
    expect(snowfieldCells).toBeGreaterThan(YETI_MIN_LAIR_SNOW_CELLS);
    expect(snowfieldCells).toBeLessThan(preAmendmentBarCells);

    setMonsterRandomSource(ALWAYS);
    const world = massifWorld({
      radius: snowfieldRadius,
      peakHeight: SNOW_LINE_MIN_HEIGHT + 4 * BAND_HEIGHT,
    });
    advanceSummoning(world, TICK_DT);
    expect(snowMonster()!.kind).toBe('yeti');
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
    // Two, not MAX_LIVING_MONSTERS (3): this world's basin is no trench, so
    // the kraken's slot — per KIND since 2026-08-19 — rightly stays empty.
    expect(livingMonsterCount()).toBe(2);

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

    // Park him at the summit before shrinking. Since the 2026-08-19 summon
    // spread he arrives anywhere on the massif, and a rim arrival would leave
    // his own cell bare rock — which is the PHYSICS departure, not the region
    // test this test is about. Positions are live-mutable; the lurk step writes
    // them the same way.
    snowMonster()!.x = MASSIF_CENTER + 0.5;
    snowMonster()!.y = MASSIF_CENTER + 0.5;

    // Shrink it below the collapse threshold while his own cell stays snow, so
    // the ONLY thing that can drive him off is the region test. THREE UNTIL
    // 2026-08-23, when the arrival threshold fell 168 → 56 and the collapse
    // threshold with it, 42 → 14 (kinds.ts); TWO until 2026-08-24, when cutting
    // the animal to two peep-heights took the thresholds down again with him
    // (29 and 7) and a radius-2 disc, ~13 cells, stopped being a collapse.
    // The fixture follows the animal every time, which is what the assertion
    // below is for.
    snow.radius = 1;
    expect(Math.PI * snow.radius * snow.radius).toBeLessThan(YETI_LAIR_COLLAPSE_SNOW_CELLS);
    expect(isLairCell(LAND_HABITAT, world, snowMonster()!.x, snowMonster()!.y)).toBe(true);

    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(snowMonster()).toBeNull();
    expect(cooldownRemainingSecondsFor('yeti')).toBe(YETI_RESPAWN_COOLDOWN_SECONDS);
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
    expect(cooldownRemainingSecondsFor('yeti')).toBe(YETI_RESPAWN_COOLDOWN_SECONDS);
    // ...and the sea is untouched by any of it.
    expect(seaMonster()).not.toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
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
    // The trench admits Cthulhu too (per-kind slots) — this test follows the
    // KRAKEN and the YETI, the two banishable kinds, by name.
    expect(livingMonsterOfKind('kraken')).not.toBeNull();
    expect(snowMonster()!.kind).toBe('yeti');
    const krakenId = livingMonsterOfKind('kraken')!.id;

    // Park the yeti on the summit first — see the collapse test above: since the
    // summon spread he can arrive on the rim, and this test wants the REGION
    // rule to be what removes him, not the ground under his feet.
    snowMonster()!.x = MASSIF_CENTER + 0.5;
    snowMonster()!.y = MASSIF_CENTER + 0.5;

    // One, not two — see the collapse test above on the 2026-08-24 rescale.
    snow.radius = 1;
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(snowMonster()).toBeNull();
    expect(cooldownRemainingSecondsFor('yeti')).toBeGreaterThan(0);

    // The kraken is exactly where it was, on no cooldown at all.
    expect(livingMonsterOfKind('kraken')!.id).toBe(krakenId);
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);

    // Now drain the sea instead. The mountain is back and still cooling: each
    // habitat serves its own absence and neither reads the other's.
    snow.radius = yetiMassif().radius;
    // Drained to nothing, not merely shrunk: since the 2026-08-19 owner ruling
    // the kraken has no region-collapse rule, so the water has to leave its own
    // cell for it to go.
    sea.radius = 0;
    // The habitat check is per TICK, not per survey, so this fires at once —
    // which is why the cooldown is asserted here rather than after the loop
    // below has had five simulated seconds to decay it.
    expect(enforceHabitat(world)).toBe(true);
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);

    // Now run past a survey interval: the mountain is back and still cooling,
    // and neither habitat's absence is allowed to end the other's.
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
      enforceHabitat(world);
    }
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBeGreaterThan(0);
    expect(cooldownRemainingSecondsFor('yeti')).toBeLessThan(YETI_RESPAWN_COOLDOWN_SECONDS);
    expect(cooldownRemainingSecondsFor('yeti')).toBeGreaterThan(0);
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

  it('ambles a body-width every eleven seconds, and far under a grazer', () => {
    // The wildlife plugin's grazer cruises at 1.6 cells/s on the same hillsides
    // (plugins/wildlife/server/species.ts). Cross-referenced, not imported —
    // plugins must not depend on each other for a number. A monster that moved
    // like livestock would undo every silhouette decision in the model, and
    // that comparison is against the GROUND they share, so it survives any
    // rescale of either animal.
    const WILDLIFE_GRAZER_CRUISE_CELLS_PER_SECOND = cellsAcross(1.6);
    expect(YETI_AMBLE_SPEED_CELLS_PER_SECOND).toBeLessThan(
      WILDLIFE_GRAZER_CRUISE_CELLS_PER_SECOND / 3,
    );

    // THE SPEED IS PINNED TO HIS OWN BODY, which is what "an amble" actually
    // means and the only form of it that a rescale cannot quietly break: an
    // absolute figure here would have passed unchanged through the 2026-08-22
    // rescale while the animal it described started scurrying.
    //
    // FIFTEEN SECONDS, NOT ELEVEN, SINCE 2026-08-26, and he did not slow down:
    // the RULER got wider. The footprint is the broadest of four bodies now, and
    // the broadest is a knuckle-walking silverback a third wider than the single
    // upright it replaced, while the speed — which is stated against his HEIGHT,
    // and every variant is the same two peeps tall — did not move. The
    // assertion is kept rather than dropped because what it catches is a SPEED
    // retuned on its own, which is still exactly as wrong as it was.
    const AMBLE_SECONDS_PER_BODY_WIDTH = 15;
    expect(YETI_FOOTPRINT_CELLS / YETI_AMBLE_SPEED_CELLS_PER_SECOND).toBeCloseTo(
      AMBLE_SECONDS_PER_BODY_WIDTH,
      0,
    );

    // Comparing his ABSOLUTE speed to the two sea kinds' (Cthulhu's 0.25 brood,
    // the kraken's 0.6 hunt) stopped meaning anything on 2026-08-22: they are
    // four to nine times his size, so the fast one is the one whose legs are
    // longer. Only the kraken bound still holds, and only trivially.
    expect(YETI_AMBLE_SPEED_CELLS_PER_SECOND).toBeLessThan(KRAKEN_LURK_SPEED_CELLS_PER_SECOND);
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

// ─────────────────────────────────────────────────────────────────────────────
// World events — the emission half of the chronicle contract (2026-08-19).
// ─────────────────────────────────────────────────────────────────────────────

describe('world events (monsters:arrived / monsters:departed)', () => {
  it('an arrival and a terrain-forced departure each leave as one event, in the causing call', () => {
    resetMonstersState();
    const world = worldWithTerrain(WORLD_SIZE, bowl(TRENCH_RADIUS));
    world.setSink(new RecordingSink());
    const events: Array<{ event: string; payload: unknown }> = [];
    const recorder = {
      name: 'recorder',
      onWorldEvent(_world: unknown, event: string, payload: unknown): void {
        events.push({ event, payload });
      },
    };
    const host = new PluginHost(world, [monstersPlugin, recorder].map(asLoadedPlugin));
    host.worldCreate();
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    host.playerJoined(PLAYER);

    setMonsterRandomSource(ALWAYS);
    for (let n = 0; n < 10; n++) host.tick(TICK_DT);

    const arrivals = events.filter((heard) => heard.event === 'monsters:arrived');
    expect(arrivals.length).toBeGreaterThan(0);
    for (const arrival of arrivals) {
      const payload = arrival.payload as { kind: string; x: number; y: number };
      expect(typeof payload.kind).toBe('string');
      expect(Number.isInteger(payload.x)).toBe(true);
      expect(Number.isInteger(payload.y)).toBe(true);
    }
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();
    setMonsterRandomSource(NEVER);

    // Walk Cthulhu clear so his ground protection cannot veto the raises
    // (same arrangement as "submerges when the ground is raised" above).
    const cthulhu = livingMonsterOfKind('cthulhu');
    if (cthulhu !== null) {
      cthulhu.x = 1.5;
      cthulhu.y = 1.5;
    }

    const cellX = Math.floor(kraken!.x);
    const cellY = Math.floor(kraken!.y);
    for (let n = 0; n < 40 && isDeepWaterHeight(world.heightAt(cellX, cellY)); n++) {
      handleSculptIntent(
        { world, interceptors: host },
        PLAYER,
        { type: 'sculpt', x: cellX, y: cellY, radius: MAX_BRUSH_RADIUS, dir: 1, tool: 'stamp', profile: 'hard' },
      );
    }

    const departures = events.filter((heard) => heard.event === 'monsters:departed');
    expect(departures).toHaveLength(1);
    expect((departures[0].payload as { kind: string }).kind).toBe('kraken');
  });

  it('a snapshot restore re-seats monsters without announcing arrivals', () => {
    resetMonstersState();
    const world = worldWithTerrain(WORLD_SIZE, bowl(TRENCH_RADIUS));
    world.setSink(new RecordingSink());
    setMonsterRandomSource(ALWAYS);
    const first = new PluginHost(world, [monstersPlugin].map(asLoadedPlugin));
    first.worldCreate();
    for (let n = 0; n < 10; n++) first.tick(TICK_DT);
    expect(livingMonsterOfKind('kraken')).not.toBeNull();
    const slices = first.collectPersistence();

    resetMonstersState();
    setMonsterRandomSource(NEVER);
    const events: Array<{ event: string; payload: unknown }> = [];
    const recorder = {
      name: 'recorder',
      onWorldEvent(_world: unknown, event: string, payload: unknown): void {
        events.push({ event, payload });
      },
    };
    const world2 = worldWithTerrain(WORLD_SIZE, bowl(TRENCH_RADIUS));
    world2.setSink(new RecordingSink());
    const second = new PluginHost(world2, [monstersPlugin, recorder].map(asLoadedPlugin));
    second.restorePersistence(slices);
    second.worldCreate();
    for (let n = 0; n < 10; n++) second.tick(TICK_DT);

    expect(livingMonsterOfKind('kraken')).not.toBeNull();
    expect(events.filter((heard) => heard.event === 'monsters:arrived')).toHaveLength(0);
  });
});

/**
 * THE BODY IS NOT A POINT (issue #45's "arm-crowns unprobed laterally", fixed
 * 2026-08-20).
 *
 * These are CONTRACT tests on `isLairPose` and on the invariant it buys, not
 * callsite wiring tests: the bug was never that one probe forgot to check its
 * flanks, it was that the only predicate on offer answered for a CELL while
 * every steering caller owned a BODY several cells wide. So what is pinned
 * here is the predicate's own behaviour and the movement invariant that falls
 * out of it — a third caller added tomorrow gets both for free.
 */
describe('body-aware habitat poses', () => {
  /**
   * A straight east-west CHANNEL of deep water, `halfWidth` cells either side
   * of the world's centre row, with neutral dry ground above and below it.
   *
   * A channel rather than the round basin the rest of this file uses because
   * the defect is about LATERAL clearance specifically: a channel has two
   * shores at a known, exact distance from the centre line, so "the body fits"
   * and "the body does not" are arithmetic rather than geometry.
   */
  function channelWorld(halfWidth: number): LairWorld {
    return {
      worldSize: WORLD_SIZE,
      heightAt: (_x, y) =>
        Math.abs(y - WORLD_CENTER) <= halfWidth
          ? DEEP_WATER_MAX_HEIGHT
          : NEUTRAL_GROUND_HEIGHT,
      isCellUnlocked: () => true,
    };
  }

  function krakenAt(x: number, y: number, heading: number): Monster {
    return { id: 1, kind: 'kraken', x, y, heading, idle: false };
  }

  it('degenerates to the cell test at radius zero', () => {
    const world = channelWorld(1);
    for (const y of [WORLD_CENTER, WORLD_CENTER + 5]) {
      expect(isLairPose(WATER_HABITAT, world, WORLD_CENTER, y, 0)).toBe(
        isLairCell(WATER_HABITAT, world, WORLD_CENTER, y),
      );
    }
  });

  it('rejects a pose whose centre is habitat but whose rim is not', () => {
    // Half-width 2 → a 5-cell channel. A 7-cell body cannot fit in it, but its
    // CENTRE cell is deep water, which is exactly the pose the old centre-point
    // predicate accepted.
    const world = channelWorld(2);
    const radius = bodyRadiusCells(profileOf('kraken'));

    expect(isLairCell(WATER_HABITAT, world, WORLD_CENTER, WORLD_CENTER)).toBe(true);
    expect(isLairPose(WATER_HABITAT, world, WORLD_CENTER, WORLD_CENTER, radius)).toBe(false);
  });

  it('accepts the same pose once the channel is wider than the body', () => {
    const radius = bodyRadiusCells(profileOf('kraken'));
    const world = channelWorld(Math.ceil(radius) + 1);
    expect(isLairPose(WATER_HABITAT, world, WORLD_CENTER, WORLD_CENTER, radius)).toBe(true);
  });

  it('is yaw-independent — the rim is a ring, not a pair of flanks', () => {
    // The same centre, probed at every 45° of body rotation, must give the same
    // answer: the sea kinds are radial crowns animated by yaw only, so a
    // heading-relative clearance test would make legality flicker as they turn.
    const world = channelWorld(2);
    const radius = bodyRadiusCells(profileOf('kraken'));
    const answers = new Set<boolean>();
    for (let turn = 0; turn < 8; turn++) {
      const heading = (turn * Math.PI) / 4;
      answers.add(
        isLairPose(
          WATER_HABITAT,
          world,
          WORLD_CENTER + Math.cos(heading) * 1e-9,
          WORLD_CENTER + Math.sin(heading) * 1e-9,
          radius,
        ),
      );
    }
    expect(answers.size).toBe(1);
  });

  it('never lets a wide monster lay its body over the shore', () => {
    // THE REGRESSION. Before the fix the kraken wandered until its CENTRE
    // reached the channel's last deep row, putting three and a half cells of
    // arm crown on dry land; the centre-point probe was happy throughout.
    setMonsterRandomSource(seededRandom(20260820));
    const radius = bodyRadiusCells(profileOf('kraken'));
    const world = channelWorld(Math.ceil(radius) + 2);
    const monster = krakenAt(WORLD_CENTER, WORLD_CENTER, 0);

    expect(isLairPose(WATER_HABITAT, world, monster.x, monster.y, radius)).toBe(true);
    for (let tick = 0; tick < 4000; tick++) {
      advanceMonster(world, monster, TICK_DT);
      expect(isLairPose(WATER_HABITAT, world, monster.x, monster.y, radius)).toBe(true);
    }
  });

  it('lets an already-pinched body swim out instead of freezing', () => {
    // The escape hatch. A monster can be pose-invalid without ever having moved
    // there illegally — summoned into a crescent, or hemmed in by a sculpt just
    // outside its protected ground. Applying the strict test unconditionally
    // there would fail every candidate heading and spin it like a weathervane,
    // so a pinched body falls back to the centre question for that tick.
    setMonsterRandomSource(seededRandom(20260820));
    const radius = bodyRadiusCells(profileOf('kraken'));
    const world = channelWorld(2); // narrower than the body: pinched from birth
    const monster = krakenAt(WORLD_CENTER, WORLD_CENTER, 0);

    expect(isLairPose(WATER_HABITAT, world, monster.x, monster.y, radius)).toBe(false);

    const startX = monster.x;
    for (let tick = 0; tick < 200; tick++) advanceMonster(world, monster, TICK_DT);

    // It moved (did not freeze) and it stayed in its habitat while doing so.
    expect(monster.x).not.toBe(startX);
    expect(isLairCell(WATER_HABITAT, world, monster.x, monster.y)).toBe(true);
  });
});

describe('the sea holds two monsters, not one on top of the other (2026-08-21)', () => {
  /**
   * A habitat may carry MORE THAN ONE KIND since the 2026-08-19 per-kind slots:
   * the kraken and Cthulhu share the water, both on OPEN_WATER_PROFILE, both
   * free to occupy the same basin. Until now this plugin passed shared's
   * `steerAvoiding` no occupant list at all, so the two seven-cell bodies had
   * no idea the other existed and swam straight through one another.
   *
   * Nothing but open deep water, so the ONLY thing that can turn either of them
   * is the other one — no shoreline, no locked chunk, no snow line.
   */
  function openSea(): LairWorld {
    return {
      worldSize: WORLD_SIZE,
      heightAt: () => DEEP_WATER_MAX_HEIGHT,
      isCellUnlocked: () => true,
    };
  }

  /**
   * A random source that stills the sim completely: 0.5 is far above every
   * idle rate's per-tick probability, so no monster ever flips its idle beat,
   * and it re-centres to exactly zero turn noise ((0.5 × 2 − 1) = 0). Both
   * monsters therefore hold whatever heading they were given until something
   * in the world takes it off them, which is exactly the experiment.
   */
  const NO_NOISE = (): number => 0.5;

  /** Combined personal space: each body's own half-footprint. */
  const COMBINED_RADII_CELLS =
    bodyRadiusCells(profileOf('kraken')) + bodyRadiusCells(profileOf('cthulhu'));

  /**
   * How far the pair can close INSIDE that gap in one tick, and therefore the
   * slack the assertion allows: separation is chosen against start-of-tick
   * positions, so two movers closing head-on each shave their own step off it
   * (shared/src/steering.ts's `steerAvoiding` names this residual). Both steps
   * are ~0.06 cells against a 7-cell gap.
   */
  const COMBINED_STEP_CELLS =
    (profileOf('kraken').lurkSpeedCellsPerSecond + profileOf('cthulhu').lurkSpeedCellsPerSecond) *
    TICK_DT;

  /** Head-on, outside the gap, aimed straight at each other. */
  const START_SEPARATION_CELLS = COMBINED_RADII_CELLS + 1;
  const APPROACH_TICKS = 400;

  function installPair(): void {
    resetMonstersState();
    setMonsterRandomSource(NO_NOISE);
    loadMonsters({
      version: 2,
      nextId: 3,
      monsters: [
        {
          id: 1,
          kind: 'kraken',
          x: WORLD_CENTER - START_SEPARATION_CELLS / 2,
          y: WORLD_CENTER,
          heading: 0, // due east, straight at Cthulhu
        },
        {
          id: 2,
          kind: 'cthulhu',
          x: WORLD_CENTER + START_SEPARATION_CELLS / 2,
          y: WORLD_CENTER,
          heading: Math.PI, // due west, straight at the kraken
        },
      ],
    });
  }

  function gap(): number {
    const kraken = livingMonsterOfKind('kraken')!;
    const cthulhu = livingMonsterOfKind('cthulhu')!;
    return Math.hypot(kraken.x - cthulhu.x, kraken.y - cthulhu.y);
  }

  it('holds two sea kinds off each other on a collision course', () => {
    const world = openSea();
    installPair();
    expect(gap()).toBeCloseTo(START_SEPARATION_CELLS, 9);

    let closest = Infinity;
    for (let tick = 0; tick < APPROACH_TICKS; tick++) {
      advanceLurking(world, TICK_DT);
      closest = Math.min(closest, gap());
    }

    expect(closest).toBeGreaterThanOrEqual(COMBINED_RADII_CELLS - COMBINED_STEP_CELLS);
  });

  it('is the occupant list that does it: without one they swim through each other', () => {
    // THE CONTROL, and the state this plugin shipped in. Same pair, same
    // headings, same world — `advanceMonster` called directly, which is the
    // pre-2026-08-21 call with no occupants, so neither can see the other.
    const world = openSea();
    installPair();

    let closest = Infinity;
    for (let tick = 0; tick < APPROACH_TICKS; tick++) {
      for (const monster of livingMonsters()) advanceMonster(world, monster, TICK_DT);
      closest = Math.min(closest, gap());
    }

    // They met. (They cannot pass THROUGH each other and separate again: with
    // no noise both hold their heading, so they close until they are coincident
    // and then keep going — either way the gap collapses to nothing like the
    // seven cells the bodies claim.)
    expect(closest).toBeLessThan(1);
  });
});
