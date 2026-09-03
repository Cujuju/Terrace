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
  WORLD_UNIT_CELLS,
  type SculptProfile,
  cellsAcross,
  isWater,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import { initialUnlockFootprint } from '../../../server/src/world/initial-unlock.ts';

import { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
} from '../../../server/test/support/harness.ts';
import {
  MANA_CAPACITY,
  MANA_COST_PER_MIN_RADIUS_SCULPT,
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
  DEEP_WATER_MAX_HEIGHT,
  habitatBoundaryHeight,
  HABITAT_REGIMES,
  LAND_HABITAT,
  SNOW_LINE_BANDS_ABOVE_SEA,
  SNOW_LINE_MIN_HEIGHT,
  WATER_HABITAT,
  type LairRegion,
  type LairSurvey,
  type LairWorld,
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
  plugin as monstersPlugin,
  resetMonstersState,
} from '../server/index.ts';
import {
  CTHULHU_LURK_SPEED_CELLS_PER_SECOND,
  KRAKEN_LAIR_MIN_DEPTH_BANDS,
  KRAKEN_MIN_LAIR_DEEP_CELLS,
  KRAKEN_RESPAWN_COOLDOWN_SECONDS,
  MAX_LIVING_MONSTERS,
  MAX_LIVING_MONSTERS_PER_KIND,
  MIN_LAIR_DEEP_CELLS,
  NATURAL_OCEAN_FLOOR_MIN_DEPTH,
  YETI_LAIR_COLLAPSE_SNOW_CELLS,
  YETI_MIN_LAIR_SNOW_CELLS,
  YETI_RESPAWN_COOLDOWN_SECONDS,
  bodyRadiusCells,
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

  it('classifies the boundary the same way on both sides', () => {
    expect(isDeepWaterHeight(DEEP_WATER_MAX_HEIGHT)).toBe(true);
    expect(isDeepWaterHeight(DEEP_WATER_MAX_HEIGHT - 1)).toBe(true);
    expect(isDeepWaterHeight(DEEP_WATER_MAX_HEIGHT + 1)).toBe(false);
    expect(isDeepWaterHeight(SEA_LEVEL)).toBe(false);
  });
});

describe('the snow line', () => {

  it('is never water, and deep water is never snow — the two habitats are disjoint', () => {
    for (let h = MIN_HEIGHT; h <= MAX_HEIGHT; h++) {
      if (isSnowHeight(h)) expect(isWater(h)).toBe(false);
      expect(isSnowHeight(h) && isDeepWaterHeight(h)).toBe(false);
    }
  });
});

describe('habitat regimes', () => {

  it('gives every kind a habitat, and every habitat its kinds', () => {
    expect(kindsInHabitat(WATER_HABITAT)).toEqual(['kraken', 'cthulhu']);
    expect(kindsInHabitat(LAND_HABITAT)).toEqual(['yeti']);
    // Every kind lands in exactly one habitat's list — no kind is homeless and
    // none is in two, which is what makes "one slot per habitat" a partition.
    const listed = HABITAT_REGIMES.flatMap((regime) => [...kindsInHabitat(regime)]);
    expect([...listed].sort()).toEqual([...MONSTER_KINDS].sort());
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
});

describe('the arrival gates', () => {

  it('never summons into deep water too small to be a lair, however the roll falls', () => {
    setMonsterRandomSource(ALWAYS);
    const smallPool = bowl(SMALL_POOL_RADIUS);
    expect(countDeepCells(smallPool)).toBeGreaterThan(0);
    expect(countDeepCells(smallPool)).toBeLessThan(MIN_LAIR_DEEP_CELLS);

    const harness = boot(smallPool);
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

    // One simulated minute of a roll that fires on EVERY tick. If anything in
    // the spawn path could add a second monster, six hundred chances is where it
    // shows up — 3000 until 2026-09-02, cut with the rest of the suite because
    // the duplicate this guards appears on the second firing or never.
    tick(harness, 600);
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS_PER_KIND);
    expect(livingMonster()!.id).toBe(id);
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

/** The radius of every trench fixture below, in cells. */
const KRAKEN_TRENCH_RADIUS_CELLS = cellsAcross(40);

/**
 * How wide the trench fixture's QUALIFYING pocket must be, in cells of radius.
 *
 * THREE BODY RADII (2026-09-02), and it is derived from the animal rather than
 * chosen. Since the kraken was confined to its own depth bar the pocket is not
 * merely where it may ARRIVE, it is the whole world it may move in, and the fit
 * bar it must clear is `minLairFittingCells` = one body's area. A pocket of
 * radius `p` has a fitting core of radius `p − bodyRadius`, so clearing
 * `π·bodyRadius²` needs `p ≥ bodyRadius·(1 + √π) ≈ 2.8·bodyRadius`; three is
 * that with the rounding taken outward, which leaves the fixture comfortably
 * over the bar instead of balanced on it.
 */
const KRAKEN_TRENCH_POCKET_RADIUS_CELLS = Math.ceil(
  3 * bodyRadiusCells(profileOf('kraken')),
);

/**
 * Extra depth this fixture's trench carries BELOW the kraken's demand, so its
 * qualifying floor is a pocket the animal FITS in rather than a single cell.
 *
 * SOLVED FROM THE POCKET, NOT CHOSEN (2026-09-02). The basin ramps linearly
 * from its floor to the deep-water line at the rim, so a margin `m` over a
 * radius `R` puts the kraken's admission contour at `R · m / (deepWaterDepth −
 * demandDepth + m)` cells — invert that for the pocket radius wanted above and
 * round up to a whole band, because every depth in this suite is stated in
 * bands. It was the literal 64 until this date, and 64 buys a 28-cell pocket:
 * enough distinct cells for the summon-spread test that first raised the margin
 * in 2026-08-20, and NOT enough for a 28-cell body to fit inside once
 * confinement made the pocket the animal's whole range.
 */
const KRAKEN_TRENCH_DEPTH_MARGIN = (() => {
  const demandDepth = KRAKEN_LAIR_MIN_DEPTH_BANDS * BAND_HEIGHT;
  const rimDepth = DEEP_WATER_BANDS_BELOW_SEA * BAND_HEIGHT;
  const fraction = KRAKEN_TRENCH_POCKET_RADIUS_CELLS / KRAKEN_TRENCH_RADIUS_CELLS;
  const exact = (fraction * (demandDepth - rimDepth)) / (1 - fraction);
  return Math.ceil(exact / BAND_HEIGHT) * BAND_HEIGHT;
})();

/** A trench the kraken qualifies for: past its depth demand and its area. */
function krakenTrench(): BasinState {
  return announcedTerrain({
    radius: KRAKEN_TRENCH_RADIUS_CELLS,
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

  /**
   * A spread of ids wide enough that one repeated cell cannot hide in it.
   *
   * EIGHT, from 32 (2026-09-02, the suite-runtime decision). Every probe id
   * costs one full habitat survey of a WORLD_SIZE² world — the stub world's
   * `heightAt` is evaluated per cell — so this count is a direct multiplier on
   * the four tests below, which together were 26 s of the suite.
   *
   * THREE, from 32 (2026-09-02, the pare-to-the-minimum decision). Every probe
   * id costs one full habitat survey of a WORLD_SIZE² world — the stub world's
   * `heightAt` is evaluated per cell — so this count is a direct multiplier on
   * the test below.
   *
   * Three is the fewest that is still a spread rather than a coincidence: the
   * defect it guards against is the pick that returned the region's single
   * extreme cell for every id, which scores exactly 1 distinct cell however
   * many ids are thrown at it. Three ids leave the "more than half distinct"
   * bar at two, which that defect cannot reach and a working hash clears.
   */
  const PROBE_IDS = Array.from({ length: 3 }, (_, i) => i + 1);

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

/**
 * How much of its own arrival bar the "puddle" below may be and still prove the
 * point — that a region far too small to have ADMITTED the kraken does not
 * evict it.
 *
 * A QUARTER, and it was a tenth until 2026-09-02. The puddle is not a chosen
 * size: it is the smallest pool guaranteed to still cover wherever in the summon
 * pocket the draw put the animal (`krakenPocketRadiusCells`), and that pocket is
 * now derived from the kraken's own body rather than from a 64-unit depth margin
 * — it has to be, or the confined animal does not fit in its own fixture. The
 * pool that follows from it is about 6 400 cells against a 36 864-cell bar, or
 * 17 %. A quarter is the nearest round bound above that, which still fails
 * loudly if a region-size eviction rule is ever reintroduced: such a rule would
 * fire at the collapse threshold, and every collapse threshold this table has
 * ever had is a QUARTER of an arrival bar (kinds.ts's
 * LAIR_COLLAPSE_HYSTERESIS_DIVISOR = 4), so a pool at this bound is exactly at
 * the size such a rule would evict on.
 */
const PUDDLE_MAX_SHARE_OF_ARRIVAL_BAR = 1 / 4;

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
    expect(Math.PI * trench.radius * trench.radius).toBeLessThan(
      KRAKEN_MIN_LAIR_DEEP_CELLS * PUDDLE_MAX_SHARE_OF_ARRIVAL_BAR,
    );
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
    // One simulated minute of a roll that fires on every tick: if the kraken
    // could ever take this world, six hundred chances is where it shows up.
    // 3000 until 2026-09-02 — the bar is checked per roll, so the extra rolls
    // only repeated the same comparison.
    tick(harness, 600);
    expect(livingMonster()!.kind).toBe('cthulhu');
  });
});

describe('kraken bar at the natural ocean floor (owner-decided 2026-08-19)', () => {

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
  // The bar's comment in kinds.ts used to assert facts about worldgen that a
  // correctness pass (2026-08-19) found wrong. This pins the corrected one
  // against server/src/world/world.ts itself — the same
  // assert-the-core-relation-from-the-plugin-side arrangement wildlife uses
  // for FRESH_SEABED_BANDS_BELOW_SEA, and for the same reason: core cannot
  // import a plugin's constants, so the plugin owns the agreement.

  /**
   * ONE SEED, AT THE SMALLEST SHIPPED SIZE — pared there on 2026-09-02, from a
   * 48-seed sweep run at both shipped sizes.
   *
   * WHAT THIS BLOCK USED TO BE: five probes over 48 seeds — the guarantee
   * below, an anti-vacuous companion measuring the mixture the noise alone
   * produces, a day-one-unlock mixture, a band-multiple check on the genesis
   * floor, and a "the reference band is not a bound" check. Together they were
   * 390 s of a 552 s suite, because every one of them generates a whole world
   * per seed and walks every cell of it, and the default 2048² size is sixteen
   * times the cells of the 512² one.
   *
   * WHAT IT IS NOW: the guarantee, once. The owner's decision (2026-09-02) is
   * that this suite is pared to the bare minimum — one test per contract, the
   * cheapest instance that can still fail for the bug it guards. The contract
   * here is the owner's 2026-08-19 ratification that a fresh world is BUILT
   * with a kraken-qualifying basin rather than needing one dug, and the trench
   * pass that delivers it runs on every world genesis makes. So a world that
   * comes out without one fails this on the first seed; the other four probes
   * were sweeps and derivation restatements around that single claim.
   *
   * WHAT IS NO LONGER GUARDED, stated rather than buried: if worldgen were
   * flattened so that every seed dug its own trench, this would still pass
   * while meaning nothing — that was the companion's job. Re-add it if the
   * generator's noise range is ever retuned.
   */
  const GENESIS_PROBE_SEED = 2654435761 >>> 0;
  const GENESIS_PROBE_SIZE = cellsAcross(128);

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

  it('promises a fresh world a kraken-qualifying basin (owner-ratified 2026-08-19)', () => {
    const heights = World.createFresh(
      GENESIS_PROBE_SIZE,
      undefined,
      undefined,
      GENESIS_PROBE_SEED,
    ).map.cells;
    expect(hasQualifyingBasin(heights, GENESIS_PROBE_SIZE)).toBe(true);
  });
});

describe('persistence', () => {

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
});

describe('broadcast', () => {
  function stateMessages(harness: Harness): MonsterState[][] {
    return harness.sink
      .ofType(`${MONSTERS_PLUGIN_NAME}:${MONSTERS_STATE_MESSAGE}`)
      .map((message) => (message.payload as { monsters: MonsterState[] }).monsters);
  }

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

  it('allows LOWERING the very same cell — you may dig, never build', () => {
    const harness = withCthulhu();
    const cell = monsterCell();
    const before = harness.world.heightAt(cell.x, cell.y);

    const outcome = sculpt(harness, cell.x, cell.y, -1);
    expect(outcome.applied).toBe(true);
    expect(harness.world.heightAt(cell.x, cell.y)).toBeLessThan(before);
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
});

describe('lurking', () => {

  it('moves no further than its lurk speed allows in one tick', () => {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);
    setMonsterRandomSource(seededRandom(5));

    let previous = { x: livingMonster()!.x, y: livingMonster()!.y };
    // 200 ticks, from 600 (2026-09-02): the clamp is a per-tick bound, so each
    // tick is an independent test of it and the count is a sample size.
    for (let n = 0; n < 200; n++) {
      tick(harness, 1);
      const monster = livingMonster()!;
      const step = Math.hypot(monster.x - previous.x, monster.y - previous.y);
      expect(step).toBeLessThanOrEqual(CTHULHU_LURK_SPEED_CELLS_PER_SECOND * TICK_DT + 1e-9);
      previous = { x: monster.x, y: monster.y };
    }
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
  /**
   * The channel's floor: the deepest cell of the KRAKEN'S OWN RANGE, not the
   * habitat's shallowest.
   *
   * IT WAS DEEP_WATER_MAX_HEIGHT UNTIL 2026-09-02, and the change is what makes
   * these tests still test what they say. Every case in this block steers a
   * KRAKEN, and since confinement a kraken may only be in water 28 bands down
   * (kinds.ts's `range`); a channel cut to the habitat's 12-band line is not a
   * pinched kraken, it is a STRANDED one — it holds position by design, so the
   * pinched-body escape below would have been asserting the wrong mechanism.
   * Cutting the channel to the range floor keeps every pose answer in this block
   * identical to what it was while making the animal genuinely in-range.
   */
  const CHANNEL_FLOOR_HEIGHT = habitatBoundaryHeight(
    profileOf('kraken').range,
    profileOf('kraken').range.thresholdBands,
  );

  function channelWorld(halfWidth: number): LairWorld {
    return {
      worldSize: WORLD_SIZE,
      heightAt: (_x, y) =>
        Math.abs(y - WORLD_CENTER) <= halfWidth
          ? CHANNEL_FLOOR_HEIGHT
          : NEUTRAL_GROUND_HEIGHT,
      isCellUnlocked: () => true,
    };
  }

  function krakenAt(x: number, y: number, heading: number): Monster {
    return { id: 1, kind: 'kraken', x, y, heading, idle: false };
  }

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
});
