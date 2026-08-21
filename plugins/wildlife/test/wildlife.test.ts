// The wildlife sim, driven through the REAL plugin host and the REAL intent
// pipeline — no stub for either. If the plugin API cannot carry a live entity
// simulation (a world-scale onTick, a reaction to onTerrainChanged, and a
// persistence slice big enough to hold a population), this is what fails.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  SEA_LEVEL,
  isWater,
  type CellDiff,
} from '@terrace/shared';
import { handleSculptIntent } from '../../../server/src/intent/pipeline.ts';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import { INITIAL_UNLOCK_CHUNK_SPAN } from '../../../server/src/world/initial-unlock.ts';
import {
  FRESH_SEABED_BANDS_BELOW_SEA,
  FRESH_SEABED_HEIGHT,
  FRESH_SHELF_BANDS_BELOW_SEA,
  FRESH_SHELF_HEIGHT,
  FRESH_SLOPE_BANDS_BELOW_SEA,
  FRESH_SLOPE_HEIGHT,
  World,
  freshGenesisProfile,
} from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
} from '../../../server/test/support/harness.ts';
import {
  DEFAULT_SIZE_CLASS,
  WILDLIFE_HABITAT_SPECIES,
  WILDLIFE_SIZE_CLASSES,
  WILDLIFE_SPECIES,
  type WildlifeHabitatSpecies,
  type WildlifeSizeClass,
  type WildlifeSpecies,
  isWildlifeHabitatSpecies,
  sizeClassIndex,
} from '../protocol.ts';
import {
  WILDLIFE_POPULATION_CAP,
  type HabitatWorld,
  isValidCellFor,
  takeCensus,
  targetsFor,
} from '../server/census.ts';
import {
  BROADCAST_ENTITY_CEILING,
  FLEE_RADIUS_CELLS,
  plugin as wildlifePlugin,
  resetWildlifeState,
} from '../server/index.ts';
import {
  BIRDS_PER_FLOCK_MAX,
  BIRDS_PER_FLOCK_MIN,
  BIRD_CRUISE_SPEED_CELLS_PER_SECOND,
  BIRD_FLOCK_LOOSENESS,
  BIRD_TURN_NOISE_RADIANS_PER_SECOND,
  FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND,
  FLOCK_MEAN_SPAWN_INTERVAL_SECONDS,
  FLOCK_SPAWN_SCATTER_CELLS,
  MAX_BIRDS_ALOFT,
  MAX_CONCURRENT_FLOCKS,
  type Flock,
  type FlockWorld,
  advanceFlocks,
  birdStates,
  crossingRadiusCells,
  despawnRadiusCells,
  flockCentroid,
  flockLifetimeLimitSeconds,
  livingBirds,
  livingFlocks,
  spawnFlock,
} from '../server/flocks.ts';
import {
  FLEE_SPEED_MULTIPLIER,
  SCHOOL_ALIGNMENT_RADIANS_PER_SECOND,
  SCHOOL_COMFORT_RADIUS_CELLS,
  SCHOOL_FULL_PULL_RADIUS_CELLS,
  SCHOOL_MAX_PULL_RADIANS_PER_SECOND,
  FLEE_DURATION_SECONDS,
  advanceEntity,
  advanceMovement,
  bodyLengthCellsOf,
  cohesionPullRadiansPerSecond,
  personalSpaceCellsOf,
  isFleeing,
  normalizeAngle,
  speedOf,
  startleNear,
  steerWithSchool,
  summarizeSchools,
} from '../server/movement.ts';
import { loadPopulation } from '../server/persistence.ts';
import {
  HABITAT_LOSS_RESPAWN_DELAY_SECONDS,
  NATURAL_LIFESPAN_SECONDS,
  SPAWN_MEAN_WAIT_SECONDS,
  advancePopulation,
  applyNaturalTurnover,
  despawnInvalidHabitat,
  despawnWithCredit,
  livingEntities,
  naturalDepartureCount,
  pendingCreditCount,
  pendingCreditsSnapshot,
  populationTargets,
  type WildlifeEntity,
} from '../server/population.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  DEEP_WATER_MAX_HEIGHT,
  FISH_SCHOOLS_ON_FRESH_SHELF,
  FISH_SIZE_WEIGHTS,
  SCHOOLING_PROBABILITY_BY_SIZE,
  SCHOOL_LOOSENESS_BY_SIZE,
  habitatOf,
  profileOf,
} from '../server/species.ts';
import { worldWithTerrain } from './support/world.ts';

/** 256² cells = 16×16 chunks — big enough that all four habitats are populated. */
const WORLD_SIZE = 256;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

const TICKS_PER_SIMULATED_SECOND = 1 / TICK_DT;

/** Ticks for `seconds` of simulated time, as a whole number of ticks. */
function ticksFor(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SIMULATED_SECOND);
}

/**
 * Simulated seconds after which a population is treated as "settled".
 *
 * The deficit decays with time constant SPAWN_MEAN_WAIT_SECONDS, so six time
 * constants leaves e⁻⁶ ≈ 0.2% of the initial deficit unfilled — far inside the
 * ordinary birth/death jitter the bounds below allow for.
 */
const SETTLE_TIME_CONSTANTS = 6;
const SETTLE_SECONDS = SPAWN_MEAN_WAIT_SECONDS * SETTLE_TIME_CONSTANTS;

/**
 * Lower bound, as a fraction of target, that a settled population must hold.
 *
 * Theory puts the equilibrium at 1/(1 + W/L) ≈ 0.94 of target (see the header
 * of server/population.ts). 0.6 is generous enough that the small-integer
 * habitats in this test world (5 fish, 8 whales) cannot trip it on ordinary
 * Poisson jitter, and tight enough to fail if spawning stops working.
 */
const SETTLED_POPULATION_FLOOR_FRACTION = 0.6;

/**
 * Upper bound, as a fraction of target, on how full a population may be after a
 * SHORT burst of ticks — the assertion that arrivals are spread out rather than
 * instant. In BURST_SECONDS the deficit only decays by
 * 1 − e^(−BURST/W) ≈ 14%, so 0.5 leaves enormous margin while still failing
 * loudly if the old fill-on-sight behaviour ever comes back.
 */
const BURST_SECONDS = 3;
const BURST_POPULATION_CEILING_FRACTION = 0.5;

/**
 * A north-to-south ramp: abyss at y=0, shoreline at y=200, hills below that.
 *
 * Slope is 8 height units per cell — a quarter of MAX_STEP — so the world
 * already satisfies the gradient limit and a sculpt anywhere in it produces a
 * small local diff instead of a map-wide relaxation cascade.
 */
const RAMP_SLOPE_PER_CELL = 8;
const SHORELINE_ROW = 200;
function rampHeight(_x: number, y: number): number {
  return (y - SHORELINE_ROW) * RAMP_SLOPE_PER_CELL;
}

/** The locked wall: chunk column 0, i.e. cells x < 16. */
const LOCKED_CHUNK_COLUMN = 0;
function isChunkLocked(cx: number, _cy: number): boolean {
  return cx === LOCKED_CHUNK_COLUMN;
}

const PLAYER: Player = { id: 'session-1', token: 'token-1', name: 'Tester' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/** Boots the plugin, through the real host, onto an already-built world. */
function bootOn(world: World): Harness {
  resetWildlifeState();

  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [wildlifePlugin].map(asLoadedPlugin));
  host.worldCreate();
  world.addPlayer(PLAYER);
  // Fog of war (issue #18): this suite's PLAYER is the one player every test
  // reasons about seeing "the whole (unlocked) world" — grant their own
  // per-token mask the same chunks worldWithTerrain already unlocked, or
  // every broadcast in "wildlife sync" below would filter down to nothing.
  grantTokenEveryUnlockedChunk(world, PLAYER.token);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

function boot(): Harness {
  return bootOn(worldWithTerrain(WORLD_SIZE, rampHeight, isChunkLocked));
}

/**
 * The World as the plugin sees it. Core's World exposes `size`; the WorldApi the
 * host hands plugins renames it `worldSize`, so a test that wants to call the
 * plugin's own predicates has to bridge that one field.
 */
function habitatView(world: World): HabitatWorld {
  return {
    worldSize: world.size,
    chunksPerEdge: world.chunksPerEdge,
    heightAt: (x, y) => world.heightAt(x, y),
    isChunkUnlocked: (cx, cy) => world.isChunkUnlocked(cx, cy),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

function tick(harness: Harness, times: number): void {
  for (let n = 0; n < times; n++) harness.host.tick(TICK_DT);
}

/** Ticks long enough for the stochastic fill to settle near its targets. */
function fillPopulation(harness: Harness): void {
  tick(harness, ticksFor(SETTLE_SECONDS));
}

/** Sum of the current per-species targets. */
function totalTarget(): number {
  const targets = populationTargets();
  return WILDLIFE_HABITAT_SPECIES.reduce((sum, species) => sum + targets[species], 0);
}

function countsBySpecies(): Record<WildlifeHabitatSpecies, number> {
  const counts: Record<WildlifeHabitatSpecies, number> = {
    fish: 0,
    whale: 0,
    deepsea: 0,
    grazer: 0,
  };
  for (const entity of livingEntities()) counts[entity.species]++;
  return counts;
}

describe('habitat classification', () => {
  it('splits land, shallow and deep at sea level and the deep-water threshold', () => {
    expect(habitatOf(SEA_LEVEL + 1)).toBe('land');
    expect(habitatOf(BAND_HEIGHT)).toBe('land');
    expect(habitatOf(SEA_LEVEL)).toBe('shallow');
    expect(habitatOf(DEEP_WATER_MAX_HEIGHT + 1)).toBe('shallow');
    expect(habitatOf(DEEP_WATER_MAX_HEIGHT)).toBe('deep');
    expect(habitatOf(DEEP_WATER_MAX_HEIGHT - 1)).toBe('deep');
  });

  it('expresses the deep-water threshold in whole bands', () => {
    // `% ` yields -0 for an exact negative multiple, so compare with ===.
    expect(DEEP_WATER_MAX_HEIGHT % BAND_HEIGHT === 0).toBe(true);
    expect(DEEP_WATER_MAX_HEIGHT).toBeLessThan(SEA_LEVEL);
  });

  it('agrees with shared about what counts as water, across the whole range', () => {
    // Exhaustive and disjoint by construction (habitatOf returns one label); the
    // thing worth pinning is that the water/land split is SHARED's split, not a
    // second opinion about sea level living in this plugin.
    for (let h = -1024; h <= 1024; h++) {
      const habitat = habitatOf(h);
      expect(['land', 'shallow', 'deep']).toContain(habitat);
      expect(habitat !== 'land').toBe(isWater(h));
    }
  });
});

describe('a fresh world as habitat', () => {
  it('puts the fresh open-sea floor at or below the deep-water threshold', () => {
    // THE cross-package contract: core sets the genesis band depths and cannot
    // import this plugin's threshold, so the relation between the numbers is
    // asserted here. If either moves the wrong way, whales lose their habitat on
    // day one all over again — which is the bug these constants fix.
    expect(FRESH_SEABED_BANDS_BELOW_SEA).toBeGreaterThanOrEqual(DEEP_WATER_BANDS_BELOW_SEA);
    expect(FRESH_SEABED_HEIGHT).toBeLessThanOrEqual(DEEP_WATER_MAX_HEIGHT);
    expect(habitatOf(FRESH_SEABED_HEIGHT)).toBe('deep');
  });

  it('keeps the shelf and the slope ring on the SHALLOW side of that threshold', () => {
    // The other half of the same contract, and the reason a fresh world has
    // coastal life: both inshore terraces must classify as shallow, or the
    // shelf is just more abyss and fish have nowhere to be.
    expect(FRESH_SHELF_BANDS_BELOW_SEA).toBeLessThan(DEEP_WATER_BANDS_BELOW_SEA);
    expect(FRESH_SLOPE_BANDS_BELOW_SEA).toBeLessThan(DEEP_WATER_BANDS_BELOW_SEA);
    expect(habitatOf(FRESH_SHELF_HEIGHT)).toBe('shallow');
    expect(habitatOf(FRESH_SLOPE_HEIGHT)).toBe('shallow');
  });

  it('offers both shallow and deep habitat inside the starter region, and no land', () => {
    const world = World.createFresh(WORLD_SIZE);
    const census = takeCensus(habitatView(world));

    expect(census.cellsByHabitat.shallow).toBeGreaterThan(0);
    expect(census.cellsByHabitat.deep).toBeGreaterThan(0);
    // No land until somebody raises an island — the honest consequence of a
    // world that starts as an ocean.
    expect(census.cellsByHabitat.land).toBe(0);

    // The day-one split, derived from the genesis geometry rather than restated
    // as two magic totals: shallow is the shelf box grown by the ring width on
    // every side, and it sits wholly inside the starter square, so everything
    // else the census can see is open sea.
    const { shelfMinCell, shelfMaxCell, slopeWidthCells } = freshGenesisProfile(WORLD_SIZE);
    const shallowEdgeCells = shelfMaxCell - shelfMinCell + 1 + 2 * slopeWidthCells;
    const starterCells = (INITIAL_UNLOCK_CHUNK_SPAN * CHUNK_SIZE) ** 2;

    expect(census.cellsByHabitat.shallow).toBe(shallowEdgeCells * shallowEdgeCells);
    expect(census.cellsByHabitat.deep).toBe(starterCells - census.cellsByHabitat.shallow);
    // Sanity on the numbers those formulas produce today (5-chunk starter
    // square since 2026-08-19): 2 304 / 4 096.
    expect(census.cellsByHabitat.shallow).toBe(2304);
    expect(census.cellsByHabitat.deep).toBe(4096);
  });

  it('spawns fish and deep-sea creatures on a fresh world — no whales or grazers', () => {
    const harness = bootOn(World.createFresh(WORLD_SIZE));
    tick(harness, ticksFor(SETTLE_SECONDS));

    const counts = countsBySpecies();
    expect(counts.fish).toBeGreaterThanOrEqual(1);
    expect(counts.deepsea).toBeGreaterThanOrEqual(1);
    // The shrunk 5-chunk starter square (2026-08-19) holds 4 096 deep cells —
    // below a whale's 5 000-cell need. Whales arrive with territory creep.
    expect(counts.whale).toBe(0);
    // No land exists yet, so this one cannot be anywhere.
    expect(counts.grazer).toBe(0);

    // Every creature is in its own habitat and inside the starter unlock — not
    // scattered over the locked remainder of the ocean.
    for (const entity of livingEntities()) {
      const x = Math.floor(entity.x);
      const y = Math.floor(entity.y);
      expect(harness.world.isCellUnlocked(x, y)).toBe(true);
      expect(habitatOf(harness.world.heightAt(x, y))).toBe(profileOf(entity.species).habitat);
    }
  });
});

describe('population targets', () => {
  it('scales each species with the area of ITS habitat', () => {
    const targets = targetsFor({ land: 8000, shallow: 3000, deep: 12000 });
    expect(targets.grazer).toBe(Math.floor(8000 / profileOf('grazer').habitatCellsPerIndividual));
    expect(targets.fish).toBe(Math.floor(3000 / profileOf('fish').habitatCellsPerIndividual));
    expect(targets.deepsea).toBe(Math.floor(12000 / profileOf('deepsea').habitatCellsPerIndividual));
    expect(targets.whale).toBe(Math.floor(12000 / profileOf('whale').habitatCellsPerIndividual));
  });

  it('asks for no creatures at all when a habitat is absent', () => {
    const targets = targetsFor({ land: 0, shallow: 0, deep: 40000 });
    expect(targets.grazer).toBe(0);
    expect(targets.fish).toBe(0);
    expect(targets.deepsea).toBeGreaterThan(0);
  });

  it('holds a full 512² world near, and never above, the cap', () => {
    // Nominal half-land / half-water 512², water split 40/60 shallow/deep.
    const targets = targetsFor({ land: 131072, shallow: 52429, deep: 78643 });
    const total = WILDLIFE_HABITAT_SPECIES.reduce((sum, s) => sum + targets[s], 0);
    expect(total).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);
    // The documented ecosystem after the 2026-08-14 retunes: 246 asked for
    // (131 fish / 52 deepsea / 48 grazer / 15 whale), the cap scaling that by
    // 150/246 and flooring to 148. Asserted exactly, because this table is the
    // arithmetic the species.ts header claims and a silent drift in it is how
    // that header becomes a lie.
    expect(targets).toEqual({ fish: 79, deepsea: 31, grazer: 29, whale: 9 });
    expect(total).toBe(148);
    expect(total).toBeGreaterThan(WILDLIFE_POPULATION_CAP / 2);
    expect(targets.fish).toBeGreaterThan(targets.whale);
    expect(targets.whale).toBeGreaterThan(0);
  });

  it("stocks a fresh world's starter region with coastal AND open-sea life on day one", () => {
    // The habitat areas a fresh world actually presents, taken from the world
    // itself rather than from numbers typed in here — this is the assertion that
    // the density table is tuned against reality and not against a memory of it.
    const census = takeCensus(habitatView(World.createFresh(WORLD_SIZE)));
    const targets = targetsFor(census.cellsByHabitat);

    // The documented densities, restated as the outcome they were chosen for.
    for (const species of WILDLIFE_HABITAT_SPECIES) {
      const profile = profileOf(species);
      expect(targets[species]).toBe(
        Math.floor(census.cellsByHabitat[profile.habitat] / profile.habitatCellsPerIndividual),
      );
    }

    // Day one after the 2026-08-14 school retune: 10 fish, 8 deep-sea creatures,
    // 2 whales, 0 grazers.
    //
    // The fish figure is the VISIBLE-DENSITY contract, and it is asserted as the
    // relation it was chosen for rather than as the number 10: a fresh shelf must
    // hold FISH_SCHOOLS_ON_FRESH_SHELF complete schools, because one blob of fish
    // is not recognisable as a school and the old density could not even hold
    // one whole group.
    expect(targets.fish).toBe(FISH_SCHOOLS_ON_FRESH_SHELF * profileOf('fish').groupSize);
    expect(targets.fish).toBe(5);
    expect(targets.deepsea).toBeGreaterThanOrEqual(2);
    // The 2026-08-14 "2–3 whales immediately" goal was superseded 2026-08-19
    // by the smaller starter square: 4 096 deep cells cannot host a 5 000-cell
    // whale, so day one has none — they appear as the territory creeps.
    expect(targets.whale).toBe(0);
    // Grazers have no habitat until someone raises an island. Honest
    // consequence of a world that starts as an ocean.
    expect(targets.grazer).toBe(0);
  });

  it('scales every species down proportionally rather than truncating one', () => {
    const uncapped = targetsFor({ land: 0, shallow: 300000, deep: 300000 });
    const total = WILDLIFE_HABITAT_SPECIES.reduce((sum, s) => sum + uncapped[s], 0);
    expect(total).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);
    // Whales are rare but not erased by the fish quota.
    expect(uncapped.whale).toBeGreaterThan(0);
    expect(uncapped.deepsea).toBeGreaterThan(uncapped.whale);
  });
});

describe('wildlife plugin', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('registers under its own namespace', () => {
    expect(harness.host.pluginNames).toEqual(['wildlife']);
  });

  it('starts empty and trends toward the habitat targets without ever exceeding them', () => {
    expect(livingEntities()).toHaveLength(0);

    fillPopulation(harness);
    const targets = populationTargets();
    const counts = countsBySpecies();

    // Never ABOVE target: credits are only ever issued for a deficit, so this is
    // an invariant of the credit path and can be asserted exactly.
    for (const species of WILDLIFE_HABITAT_SPECIES) {
      expect(counts[species]).toBeLessThanOrEqual(targets[species]);
    }

    const settled = livingEntities().length;
    expect(settled).toBeGreaterThanOrEqual(
      Math.floor(totalTarget() * SETTLED_POPULATION_FLOOR_FRACTION),
    );
    expect(settled).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);
  });

  it('arrives gradually rather than filling on sight', () => {
    // One census has run by the first tick, so the whole deficit is already
    // booked as ripe credits: anything still missing here is missing because the
    // spawn hazard has not fired yet, not because nothing has been asked for.
    tick(harness, ticksFor(BURST_SECONDS));

    expect(pendingCreditCount()).toBeGreaterThan(0);
    expect(livingEntities().length).toBeLessThan(
      totalTarget() * BURST_POPULATION_CEILING_FRACTION,
    );
  });

  it('keeps turning over at equilibrium: creatures leave and others take their place', () => {
    fillPopulation(harness);
    const settled = livingEntities().length;
    const idsBefore = new Set(livingEntities().map((entity) => entity.id));
    const departuresBefore = naturalDepartureCount();

    // Two mean lifetimes: the expected number of departures is ~2 × the living
    // population, so "nothing left" would be a broken turnover rate, not luck.
    tick(harness, ticksFor(NATURAL_LIFESPAN_SECONDS * 2));

    expect(naturalDepartureCount()).toBeGreaterThan(departuresBefore);

    // Replaced, not merely lost: the population is still near target and some of
    // the creatures alive now did not exist before.
    const after = livingEntities();
    expect(after.length).toBeGreaterThanOrEqual(
      Math.floor(totalTarget() * SETTLED_POPULATION_FLOOR_FRACTION),
    );
    expect(after.length).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);
    expect(after.some((entity) => !idsBefore.has(entity.id))).toBe(true);
    expect(settled).toBeGreaterThan(0);
  });

  it('spawns nothing outside its habitat or outside unlocked territory', () => {
    fillPopulation(harness);
    expect(livingEntities().length).toBeGreaterThan(0);

    for (const entity of livingEntities()) {
      const x = Math.floor(entity.x);
      const y = Math.floor(entity.y);
      expect(harness.world.isCellUnlocked(x, y)).toBe(true);
      expect(habitatOf(harness.world.heightAt(x, y))).toBe(profileOf(entity.species).habitat);
    }
  });

  it('keeps every creature in habitat and inside the unlocked area while wandering', () => {
    fillPopulation(harness);
    const before = livingEntities().length;
    const view = habitatView(harness.world);

    // 60 s of simulated wandering — long enough for the fastest species to cross
    // the whole habitat band several times and meet every boundary.
    for (let n = 0; n < ticksFor(60); n++) {
      harness.host.tick(TICK_DT);
      for (const entity of livingEntities()) {
        expect(isValidCellFor(view, entity.species, entity.x, entity.y)).toBe(true);
      }
    }

    // Nothing was quietly culled to keep the invariant true. Population size is
    // no longer the way to assert that — natural turnover moves it every tick —
    // so ask the sweep directly: it finds nothing to remove, which means every
    // creature that left over those 60 s left of old age, not because the
    // steering let it stray somewhere illegal and the sweep tidied up after it.
    expect(despawnInvalidHabitat(view)).toBe(0);
    expect(livingEntities().length).toBeGreaterThanOrEqual(
      Math.floor(before * SETTLED_POPULATION_FLOOR_FRACTION),
    );
  });

  it('treats locked chunks as walls', () => {
    fillPopulation(harness);
    tick(harness, 600);

    for (const entity of livingEntities()) {
      const chunkX = Math.floor(entity.x / CHUNK_SIZE);
      expect(isChunkLocked(chunkX, 0)).toBe(false);
      expect(harness.world.isCellUnlocked(Math.floor(entity.x), Math.floor(entity.y))).toBe(true);
    }
  });

  it('startles creatures within the flee radius of a terrain change, and no others', () => {
    fillPopulation(harness);
    const subject = livingEntities()[0];
    expect(subject).toBeDefined();

    const cruise = profileOf(subject.species).cruiseSpeedCellsPerSecond;
    expect(speedOf(subject)).toBe(cruise);

    // A synthetic diff centred exactly on the subject, delivered through the
    // host's real fan-out.
    const diff: CellDiff[] = [
      { x: Math.floor(subject.x), y: Math.floor(subject.y), h: harness.world.heightAt(Math.floor(subject.x), Math.floor(subject.y)) },
    ];
    harness.host.notifyTerrainChanged(diff);

    expect(isFleeing(subject)).toBe(true);
    expect(speedOf(subject)).toBe(cruise * FLEE_SPEED_MULTIPLIER);

    // Anything comfortably beyond the radius is untouched.
    for (const entity of livingEntities()) {
      const dx = entity.x - subject.x;
      const dy = entity.y - subject.y;
      if (Math.hypot(dx, dy) <= FLEE_RADIUS_CELLS * 2) continue;
      expect(isFleeing(entity)).toBe(false);
    }
  });

  it('points a startled creature away from the disturbance', () => {
    fillPopulation(harness);
    const subject = livingEntities()[0];

    // Disturbance one cell to the creature's west; it should end up heading east.
    const centerX = subject.x - 1;
    const centerY = subject.y;
    harness.host.notifyTerrainChanged([
      { x: Math.floor(centerX), y: Math.floor(centerY), h: 0 },
    ]);

    expect(Math.cos(subject.heading)).toBeGreaterThan(0);
  });

  it('calms down again after the flee duration', () => {
    fillPopulation(harness);
    const subject = livingEntities()[0];
    harness.host.notifyTerrainChanged([{ x: Math.floor(subject.x), y: Math.floor(subject.y), h: 0 }]);
    expect(isFleeing(subject)).toBe(true);

    tick(harness, 40); // 4 s > FLEE_DURATION_SECONDS
    expect(isFleeing(subject)).toBe(false);
  });

  it('reacts to a real sculpt driven through the intent pipeline', () => {
    fillPopulation(harness);
    const subject = livingEntities().find(
      (entity) => entity.species === 'deepsea' || entity.species === 'whale',
    );
    expect(subject).toBeDefined();

    // Lower the seabed under a swimmer: deep stays deep, so the ONLY observable
    // effect is the reaction itself.
    const outcome = handleSculptIntent(
      { world: harness.world, interceptors: harness.host },
      PLAYER,
      { type: 'sculpt', x: Math.floor(subject!.x), y: Math.floor(subject!.y), radius: MAX_BRUSH_RADIUS, dir: -1 },
    );

    expect(outcome.applied).toBe(true);
    expect(isFleeing(subject!)).toBe(true);
  });

  it('despawns a creature whose habitat is destroyed, and credits a respawn', () => {
    fillPopulation(harness);
    const fish = livingEntities().find((entity) => entity.species === 'fish');
    expect(fish).toBeDefined();

    const cellX = Math.floor(fish!.x);
    const cellY = Math.floor(fish!.y);
    const creditsBefore = pendingCreditCount();

    // Raise the fish's cell out of the water. No ticks in between, so the fish
    // cannot swim away — this is specifically the "the world changed under it"
    // case, not the "it wandered somewhere bad" case.
    for (let n = 0; n < 40 && harness.world.heightAt(cellX, cellY) <= SEA_LEVEL; n++) {
      handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        { type: 'sculpt', x: cellX, y: cellY, radius: MAX_BRUSH_RADIUS, dir: 1 },
      );
    }
    expect(harness.world.heightAt(cellX, cellY)).toBeGreaterThan(SEA_LEVEL);

    // The reactive path removes it immediately; the tick sweep would too.
    expect(livingEntities()).not.toContain(fish);
    expect(pendingCreditCount()).toBeGreaterThan(creditsBefore);
  });

  it('recovers the population elsewhere after a habitat-loss despawn', () => {
    fillPopulation(harness);
    const targets = populationTargets();
    const fish = livingEntities().find((entity) => entity.species === 'fish');
    expect(fish).toBeDefined();

    const cellX = Math.floor(fish!.x);
    const cellY = Math.floor(fish!.y);
    for (let n = 0; n < 40 && harness.world.heightAt(cellX, cellY) <= SEA_LEVEL; n++) {
      handleSculptIntent(
        { world: harness.world, interceptors: harness.host },
        PLAYER,
        { type: 'sculpt', x: cellX, y: cellY, radius: MAX_BRUSH_RADIUS, dir: 1 },
      );
    }
    expect(countsBySpecies().fish).toBeLessThan(targets.fish);

    // "Recovered" is now a statement about a NEW fish existing, not about the
    // count hitting the target on a given tick: with turnover the count is a
    // fluctuating quantity, but an id that did not exist before can only have
    // come from a spawn. Ids are never reused (see the persistence suite).
    const highestIdBefore = Math.max(...livingEntities().map((entity) => entity.id));
    const newFishSeen = new Set<number>();

    // Watch the whole window rather than only its last frame: a fish that
    // spawned and later died of old age still proves the recovery happened.
    for (let n = 0; n < ticksFor(SETTLE_SECONDS * 2); n++) {
      harness.host.tick(TICK_DT);
      for (const entity of livingEntities()) {
        if (entity.species !== 'fish' || entity.id <= highestIdBefore) continue;
        newFishSeen.add(entity.id);
        expect(harness.world.isCellUnlocked(Math.floor(entity.x), Math.floor(entity.y))).toBe(true);
      }
    }
    expect(newFishSeen.size).toBeGreaterThan(0);
  });
});

describe('credit removal after a spawn honours ripeness, not recency', () => {
  beforeEach(() => {
    resetWildlifeState();
  });

  // Regression test for the bug consumeCredits' removal loop used to have: it
  // sized `wanted` off every credit for a species (ripe or not) but then
  // debited the removal purely by species and array position (scanning from
  // the end), with no readyAt check. A habitat-loss credit is always PUSHED
  // last, so it always sat at the end of the array — meaning the removal loop
  // would delete it first, before it had ever ripened, while the ripe credit
  // that actually earned the spawn stayed pending to fire again later.
  //
  // This drives population.ts directly (no PluginHost, no movement) so the dt
  // handed to each event can be chosen exactly: with every ripe credit's
  // readyAt at 0, `ripe * dt / SPAWN_MEAN_WAIT_SECONDS` is EXACT, not
  // statistical, so dt = SPAWN_MEAN_WAIT_SECONDS / ripe drives the clamped
  // probability to exactly 1 and the spawn roll is certain — no seeded RNG
  // needed, and none used.
  it('never removes a not-yet-ripe habitat-loss credit to pay for a ripe one’s spawn', () => {
    // Uniform shallow water, fully unlocked: only fish have habitat here, so
    // every credit in play is unambiguously fish and nothing else competes for
    // WILDLIFE_POPULATION_CAP.
    const world = habitatView(worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL));
    let simSeconds = 0;

    // First census: the whole deficit becomes ripe credits in one shot (this
    // plugin's "how a brand new world fills up").
    advancePopulation(world, 0);
    const target = populationTargets().fish;
    expect(target).toBeGreaterThan(0);
    expect(pendingCreditCount()).toBe(target);

    // Event 1: certain to fire (ratio pinned to exactly 1), spawns one group
    // from the ripe deficit credits. How many actually land is irrelevant here
    // — read it back rather than assuming spawnGroup's scatter always
    // succeeds.
    const firstDt = SPAWN_MEAN_WAIT_SECONDS / target;
    advancePopulation(world, firstDt);
    simSeconds += firstDt;
    const spawnedInFirstEvent = livingEntities().length;
    expect(spawnedInFirstEvent).toBeGreaterThan(0);

    // Manufacture the race: a habitat-loss despawn on one of those fish pushes
    // a credit that must not hatch for HABITAT_LOSS_RESPAWN_DELAY_SECONDS —
    // onto the SAME species' queue that still holds ripe, census-deficit
    // credits from event 1. despawnWithCredit always PUSHES, so this credit is
    // now the last element of the array — exactly the position the old bug's
    // end-scanning removal always hit first.
    despawnWithCredit(0);
    const delayedReadyAt = simSeconds + HABITAT_LOSS_RESPAWN_DELAY_SECONDS;
    const fishCreditsBeforeEvent2 = pendingCreditsSnapshot().filter((c) => c.species === 'fish');
    expect(fishCreditsBeforeEvent2.some((c) => c.readyAt === delayedReadyAt)).toBe(true);

    const ripeBeforeEvent2 = fishCreditsBeforeEvent2.filter((c) => c.readyAt <= simSeconds).length;
    // The race only exists if there is at least one OTHER ripe credit for the
    // roll to fire on; with target comfortably above the fish group size, the
    // deficit left over from event 1 guarantees this.
    expect(ripeBeforeEvent2).toBeGreaterThan(0);

    // Event 2: again pinned to certain, sized off the ripe credits only — and
    // small enough that simSeconds cannot reach delayedReadyAt, so the
    // habitat-loss credit is definitely still unripe when this event's
    // removal runs.
    const secondDt = SPAWN_MEAN_WAIT_SECONDS / ripeBeforeEvent2;
    expect(simSeconds + secondDt).toBeLessThan(delayedReadyAt);
    advancePopulation(world, secondDt);
    simSeconds += secondDt;
    expect(livingEntities().length).toBeGreaterThan(spawnedInFirstEvent - 1);

    // THE ASSERTION: the still-unripe habitat-loss credit survived the
    // removal untouched. Under the bug this fails deterministically — the
    // credit sat last in the array, and the old removal always consumed from
    // the end.
    const fishCreditsAfterEvent2 = pendingCreditsSnapshot().filter((c) => c.species === 'fish');
    expect(fishCreditsAfterEvent2.some((c) => c.readyAt === delayedReadyAt)).toBe(true);
  });
});

describe('wildlife sync', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('broadcasts the full entity list on every other tick', () => {
    tick(harness, 20);
    expect(harness.sink.ofType('wildlife:entities')).toHaveLength(10);

    harness.sink.clear();
    tick(harness, 7);
    expect(harness.sink.ofType('wildlife:entities')).toHaveLength(3);
  });

  it('sends id, species, cell position and heading, rounded to two decimals', () => {
    fillPopulation(harness);
    harness.sink.clear();
    tick(harness, 2);

    const messages = harness.sink.ofType('wildlife:entities');
    expect(messages).toHaveLength(1);
    // Fog of war (issue #18): the fan-out is per connected player now, never
    // a single shared broadcast — with exactly one player in this harness
    // that is still exactly one message, addressed to them.
    expect(messages[0].target).toBe(PLAYER.id);

    const payload = messages[0].payload as { entities: Array<Record<string, unknown>> };
    // ONE message carries both subsystems: the habitat population and whatever
    // birds happen to be crossing (server/flocks.ts). The sky is usually empty
    // over a short run, so this is written as the sum rather than as the
    // population alone — it must not start passing by accident.
    expect(payload.entities).toHaveLength(livingEntities().length + livingBirds().length);

    for (const entity of payload.entities) {
      // `size` is on the wire (the client scales the model by it); `schoolId`
      // deliberately is not — schooling is a server-side steering concept.
      expect(Object.keys(entity).sort()).toEqual([
        'heading',
        'id',
        'size',
        'species',
        'x',
        'y',
      ]);
      expect(WILDLIFE_SIZE_CLASSES[entity.size as number]).toBeDefined();
      expect(WILDLIFE_SPECIES).toContain(entity.species);
      for (const key of ['x', 'y', 'heading'] as const) {
        const value = entity[key] as number;
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.round(value * 100) / 100).toBe(value);
      }
    }
  });

  it('never broadcasts a creature outside unlocked territory', () => {
    fillPopulation(harness);
    harness.sink.clear();
    tick(harness, 2);

    const payload = harness.sink.ofType('wildlife:entities')[0].payload as {
      entities: Array<{ x: number; y: number; species: string }>;
    };
    for (const entity of payload.entities) {
      // HABITAT species only: their positions derive from terrain, so one in
      // locked territory would leak it. Birds are exempt by design — a flock's
      // course is terrain-independent (flocks.ts reads neither heights nor the
      // mask), it legitimately starts and ends OFF-MAP on the spawn ring, and
      // an off-map coordinate would make isCellUnlocked itself throw.
      if (!isWildlifeHabitatSpecies(entity.species)) continue;
      expect(harness.world.isCellUnlocked(Math.floor(entity.x), Math.floor(entity.y))).toBe(true);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FOG OF WAR (issue #18): the migrated-plugin proof. `harness`'s PLAYER has
  // the whole unlocked world granted to their own token (see bootOn); a
  // second player who has earned nothing of their own must be sent none of
  // the habitat population, through the REAL plugin path (WorldApi.
  // broadcastVisible), not a stub.
  // ──────────────────────────────────────────────────────────────────────────
  it('sends each connected player only the habitat population inside their own unlocked view', () => {
    fillPopulation(harness);
    expect(livingEntities().length).toBeGreaterThan(0);

    // A second connection whose token has never unlocked anything of its own
    // — the honest "just joined, has not crept anywhere yet" state.
    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider);

    harness.sink.clear();
    tick(harness, 2);

    const messages = harness.sink.ofType('wildlife:entities');
    const forPlayer = messages.find((m) => m.target === PLAYER.id);
    const forOutsider = messages.find((m) => m.target === outsider.id);
    // Full-state semantics (skipEmpty defaults false): BOTH connected players
    // are sent a message every cycle, even the one whose subset is empty —
    // that empty send is how a client would learn something it used to see
    // has left its view (see WorldApi.broadcastVisible's doc comment).
    expect(forPlayer).toBeDefined();
    expect(forOutsider).toBeDefined();

    const habitatOnly = (payload: unknown) =>
      (payload as { entities: Array<{ species: string }> }).entities.filter((entity) =>
        isWildlifeHabitatSpecies(entity.species),
      );

    // PLAYER's token was granted the whole unlocked world (bootOn), so their
    // view matches the real population exactly.
    expect(habitatOnly(forPlayer!.payload).length).toBe(livingEntities().length);
    // The outsider's token has unlocked nothing, so their subset of the SAME
    // population — computed by the SAME broadcast call — is empty.
    expect(habitatOnly(forOutsider!.payload).length).toBe(0);
  });
});

describe('wildlife persistence', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('round-trips the population through a snapshot', () => {
    fillPopulation(harness);
    const before = livingEntities().map((entity) => ({ ...entity }));
    expect(before.length).toBeGreaterThan(0);

    const slices = harness.host.collectPersistence();
    expect(Object.keys(slices)).toEqual(['wildlife']);

    // A fresh boot that restores the slice.
    const restored = boot();
    expect(livingEntities()).toHaveLength(0);
    restored.host.restorePersistence(slices);

    expect(livingEntities().map((entity) => ({ ...entity }))).toEqual(before);
  });

  it('does not reuse ids after a restore', () => {
    fillPopulation(harness);
    const maxId = Math.max(...livingEntities().map((entity) => entity.id));

    const slices = harness.host.collectPersistence();
    const restored = boot();
    restored.host.restorePersistence(slices);
    tick(restored, 400);

    const ids = livingEntities().map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Anything spawned after the restore continues past the persisted high-water
    // mark rather than colliding with it.
    expect(Math.max(...ids)).toBeGreaterThanOrEqual(maxId);
  });

  it('degrades to an empty population rather than throwing on a corrupt slice', () => {
    const corrupt: unknown[] = [
      null,
      undefined,
      42,
      'nonsense',
      {},
      { version: 999, entities: [] },
      { version: 1, entities: 'not-an-array' },
      { version: 1, entities: [null, 7, { id: 0 }, { id: 1, species: 'dragon' }] },
      { version: 1, entities: [{ id: 1, species: 'fish', x: NaN, y: 0, heading: 0 }] },
      { version: 1, nextId: 'x', entities: [{ id: 1, species: 'fish', x: 1, y: 2, heading: 0 }] },
    ];

    for (const data of corrupt) {
      expect(() => loadPopulation(data)).not.toThrow();
    }
    // The last case is the one valid entity in the list.
    expect(livingEntities()).toHaveLength(1);
  });

  it('drops duplicate ids from a hand-edited slice', () => {
    loadPopulation({
      version: 1,
      nextId: 3,
      entities: [
        { id: 1, species: 'fish', x: 1, y: 1, heading: 0 },
        { id: 1, species: 'whale', x: 2, y: 2, heading: 0 },
      ],
    });
    expect(livingEntities()).toHaveLength(1);
    expect(livingEntities()[0].species).toBe('fish');
  });

  it('sweeps restored creatures that no longer sit in their habitat', () => {
    // A whale persisted onto a hilltop: the first tick's habitat sweep removes it.
    loadPopulation({
      version: 1,
      nextId: 2,
      entities: [{ id: 1, species: 'whale', x: 128, y: 255, heading: 0 }],
    });
    expect(livingEntities()).toHaveLength(1);
    expect(habitatOf(harness.world.heightAt(128, 255))).toBe('land');

    harness.host.tick(TICK_DT);
    expect(livingEntities().find((entity) => entity.id === 1)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOLS
//
// Owner, 2026-08-14: "I see individual fish but I haven't seen any schools of
// fish." These suites pin the four claims the fix rests on: a school holds
// together for minutes, a sculpt scatters it and it re-forms, the terrain still
// beats it, and turnover moves it as one body without changing the rate at
// which fish come and go.
//
// Every bound below is a NAMED constant carrying the measurement it came from,
// and every behavioural bound has at least 2× headroom over the worst of twenty
// measured trials — these run against the real, unseeded Math.random, so a bound
// that merely "usually" holds is a flake waiting for CI.
// ─────────────────────────────────────────────────────────────────────────────

/** A world that is shallow water everywhere: fish habitat with no boundaries. */
const OPEN_SHALLOW_HEIGHT = SEA_LEVEL - BAND_HEIGHT;

/** Where hand-built schools are placed — the middle of the test world. */
const SCHOOL_ORIGIN_CELL = WORLD_SIZE / 2;

/** Members in a hand-built school: one full spawn group. */
const SCHOOL_UNDER_TEST_MEMBERS = profileOf('fish').groupSize;

/**
 * Half-width of the jitter a hand-built school is created with, in cells —
 * GROUP_SCATTER_BODY_LENGTHS (2) × a fish's 0.7-cell body, i.e. exactly the
 * scatter population.ts gives a real spawn group.
 */
const SCHOOL_BIRTH_SCATTER_CELLS = 1.4;

/** Simulated seconds a school is watched for. Five minutes — "over minutes". */
const SCHOOL_OBSERVATION_SECONDS = 300;

/**
 * Ceiling on a school's TIME-AVERAGED radius (the mean, over every tick, of the
 * greatest distance from a member to the school's centroid).
 *
 * Measured over 60 × 300 s trials of a small school: median 1.49 cells, worst
 * 2.64. 5 cells is nearly double the worst measurement, and still a tenth of
 * what the same five fish reach in ONE minute without cohesion, so it cannot
 * pass by accident.
 */
const SCHOOL_MEAN_RADIUS_CEILING_CELLS = 5;

/**
 * Ceiling on the school's radius at ANY instant. Measured worst case over the
 * same trials: 6.46 cells for the small class (11.18 for the loosest, which is
 * not what this suite watches). 12 is the "cohesion is not silently broken"
 * rail rather than a statement about how a school looks; the mean above is the
 * one that describes the picture.
 */
const SCHOOL_PEAK_RADIUS_CEILING_CELLS = 12;

/**
 * Radius past which a group of fish is no longer any kind of group. Five fish
 * given SEPARATE school ids reach a radius of 48–195 cells within a minute
 * (measured, 200 trials); 15 is far above anything a real school does and far
 * below anything unschooled fish do, so it separates the two cleanly.
 */
const DISPERSED_RADIUS_CELLS = 15;

/**
 * How far a startled school must have spread by the end of its panic, and how
 * tight it must be again a minute later.
 *
 * Measured over 200 trials: the scatter is 11.9–36 cells (median 24.7) and the
 * re-formed radius 0.8–4.0. The scatter floor is deliberately set well under
 * the smallest measurement rather than near the median — a school fleeing into
 * its own turning circle is a real, if rare, outcome, and this suite exists to
 * prove that panic OVERRIDES cohesion, not to police how far five fish get in
 * 2.5 seconds.
 */
const FLEE_SCATTER_FLOOR_CELLS = 8;
const REFORM_SECONDS = 60;
const REFORMED_RADIUS_CEILING_CELLS = 8;

/**
 * Cells a school must have travelled in REFORM_SECONDS to count as drifting
 * rather than milling. Measured over 200 trials: 112–178 cells, because
 * alignment makes a school hold a heading. 10 is an order of magnitude below
 * that — this is the "it went somewhere" floor, not a speed measurement.
 */
const SCHOOL_DRIFT_FLOOR_CELLS = 10;

/**
 * Cells of PATH a lone fish must cover in REFORM_SECONDS to count as still
 * swimming.
 *
 * Derived from the species table, not measured: a fish cruises at its own
 * profile speed and only ever holds position on a tick where every candidate heading is
 * vetoed — which cannot happen in the open-water fixture these tests use. So
 * the path over the window is the full cruise distance, and half of it is a
 * floor no amount of wandering can undercut while the fish is moving at all,
 * yet one a frozen or stuttering fish fails outright. Unlike a displacement
 * floor it has no random tail: which way the fish turns changes where it ends
 * up, never how far it swam.
 */
const LONE_SWIMMER_PATH_FLOOR_CELLS =
  (profileOf('fish').cruiseSpeedCellsPerSecond * REFORM_SECONDS) / 2;

/** A world of nothing but shallow water, entirely unlocked. */
function openShallowWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => OPEN_SHALLOW_HEIGHT);
}

/**
 * Installs a hand-built population through the persistence path — the one seam
 * that creates creatures without the spawn machinery, which is what lets these
 * tests state an exact school and then watch only the steering.
 */
function installFish(
  entities: ReadonlyArray<{
    id: number;
    schoolId: number;
    size: WildlifeSizeClass;
    x: number;
    y: number;
  }>,
): void {
  loadPopulation({
    version: 1,
    nextId: entities.length + 1,
    nextSchoolId: Math.max(...entities.map((entity) => entity.schoolId)) + 1,
    entities: entities.map((entity) => ({
      id: entity.id,
      species: 'fish',
      schoolId: entity.schoolId,
      size: sizeClassIndex(entity.size),
      x: entity.x,
      y: entity.y,
      // One shared heading, as a real spawn group gets.
      heading: 0.5,
    })),
  });
}

/** One school of `members` fish, jittered around the world's centre. */
function installSchool(
  size: WildlifeSizeClass = 'small',
  members: number = SCHOOL_UNDER_TEST_MEMBERS,
  schoolIdOf: (index: number) => number = () => 1,
): void {
  installFish(
    Array.from({ length: members }, (_, n) => ({
      id: n + 1,
      schoolId: schoolIdOf(n),
      size,
      x: SCHOOL_ORIGIN_CELL + (Math.random() * 2 - 1) * SCHOOL_BIRTH_SCATTER_CELLS,
      y: SCHOOL_ORIGIN_CELL + (Math.random() * 2 - 1) * SCHOOL_BIRTH_SCATTER_CELLS,
    })),
  );
}

/** Centroid of a set of creatures. */
function centroidOf(members: readonly WildlifeEntity[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const member of members) {
    x += member.x;
    y += member.y;
  }
  return { x: x / members.length, y: y / members.length };
}

/** Greatest distance from any member to the group's centroid, in cells. */
function groupRadius(members: readonly WildlifeEntity[] = livingEntities()): number {
  if (members.length === 0) return 0;
  const centre = centroidOf(members);
  let radius = 0;
  for (const member of members) {
    radius = Math.max(radius, Math.hypot(member.x - centre.x, member.y - centre.y));
  }
  return radius;
}

describe('school cohesion', () => {
  let view: HabitatWorld;

  beforeEach(() => {
    resetWildlifeState();
    view = habitatView(openShallowWorld());
  });

  it('holds a spawned school together over minutes of simulated swimming', () => {
    installSchool();

    let peak = 0;
    let sum = 0;
    const ticks = ticksFor(SCHOOL_OBSERVATION_SECONDS);
    for (let n = 0; n < ticks; n++) {
      advanceMovement(view, TICK_DT);
      const radius = groupRadius();
      peak = Math.max(peak, radius);
      sum += radius;
    }

    expect(livingEntities()).toHaveLength(SCHOOL_UNDER_TEST_MEMBERS);
    expect(sum / ticks).toBeLessThan(SCHOOL_MEAN_RADIUS_CEILING_CELLS);
    expect(peak).toBeLessThan(SCHOOL_PEAK_RADIUS_CEILING_CELLS);
  });

  it('is what keeps them together: the same five fish disperse without a school', () => {
    // THE CONTROL, and the bug being fixed. Identical starting positions,
    // identical wander — the only difference is that these five are five schools
    // of one rather than one school of five.
    installSchool('small', SCHOOL_UNDER_TEST_MEMBERS, (n) => n + 1);
    for (let n = 0; n < ticksFor(REFORM_SECONDS); n++) advanceMovement(view, TICK_DT);
    expect(groupRadius()).toBeGreaterThan(DISPERSED_RADIUS_CELLS);
  });

  it('drifts as one body rather than milling on the spot', () => {
    installSchool();
    const start = centroidOf(livingEntities());
    for (let n = 0; n < ticksFor(REFORM_SECONDS); n++) advanceMovement(view, TICK_DT);
    const end = centroidOf(livingEntities());

    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeGreaterThan(
      SCHOOL_DRIFT_FLOOR_CELLS,
    );
    expect(groupRadius()).toBeLessThan(SCHOOL_PEAK_RADIUS_CEILING_CELLS);
  });

  it('scatters when startled and re-forms afterwards', () => {
    installSchool();
    for (let n = 0; n < ticksFor(REFORM_SECONDS); n++) advanceMovement(view, TICK_DT);

    const centre = centroidOf(livingEntities());
    expect(startleNear(centre.x, centre.y, FLEE_RADIUS_CELLS)).toBe(SCHOOL_UNDER_TEST_MEMBERS);

    for (let n = 0; n < ticksFor(FLEE_DURATION_SECONDS); n++) advanceMovement(view, TICK_DT);
    // Panic beat cohesion outright: the school is in pieces.
    expect(groupRadius()).toBeGreaterThan(FLEE_SCATTER_FLOOR_CELLS);

    for (let n = 0; n < ticksFor(REFORM_SECONDS); n++) advanceMovement(view, TICK_DT);
    expect(groupRadius()).toBeLessThan(REFORMED_RADIUS_CEILING_CELLS);
  });

  it('leaves a school of one wandering exactly as it always did', () => {
    // The "last fish" case: a school whose other members were lost to terrain.
    installSchool('small', 1);
    const fish = livingEntities()[0];
    let travelled = 0;
    let previousX = fish.x;
    let previousY = fish.y;

    for (let n = 0; n < ticksFor(REFORM_SECONDS); n++) {
      advanceMovement(view, TICK_DT);
      travelled += Math.hypot(fish.x - previousX, fish.y - previousY);
      previousX = fish.x;
      previousY = fish.y;
    }

    // Still alive, and still SWIMMING — measured as PATH LENGTH, not as
    // displacement, and that distinction is a fix rather than a detail
    // (2026-08-21). This case used to assert displacement against
    // SCHOOL_DRIFT_FLOOR_CELLS, a floor measured on a SCHOOL (112–178 cells,
    // because alignment makes a school hold one heading). A solitary fish has
    // no alignment term: its walk is a correlated random one whose displacement
    // over the same window measures 3.4–85.8 cells (median 50.6, 200 trials),
    // so it lands under 10 about 3% of the time and this test failed roughly
    // one run in thirty for no reason but luck. Path length has no such tail —
    // a fish that keeps swimming covers cruise speed × time whichever way it
    // wanders — and it is the property the case actually means by "still
    // moving".
    expect(livingEntities()).toHaveLength(1);
    expect(travelled).toBeGreaterThan(LONE_SWIMMER_PATH_FLOOR_CELLS);
  });
});

describe('creatures keep out of each other (the 2026-08-21 migration)', () => {
  let view: HabitatWorld;

  beforeEach(() => {
    resetWildlifeState();
    view = habitatView(openShallowWorld());
  });

  /**
   * The tightest gap any two of the school held at ANY point in `seconds`, over
   * `trials` independent runs — a worst case, not an average. `step` is the
   * per-tick advance under test.
   */
  function worstGapOverTrials(
    trials: number,
    seconds: number,
    step: (dt: number) => void,
  ): number[] {
    const worsts: number[] = [];
    for (let trial = 0; trial < trials; trial++) {
      installSchool();
      let worst = Infinity;
      for (let n = 0; n < ticksFor(seconds); n++) {
        step(TICK_DT);
        const live = livingEntities();
        for (let i = 0; i < live.length; i++) {
          for (let j = i + 1; j < live.length; j++) {
            worst = Math.min(worst, Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y));
          }
        }
      }
      worsts.push(worst);
    }
    return worsts.sort((a, b) => a - b);
  }

  /** `advanceMovement` with the occupant list withheld — the pre-migration loop. */
  function advanceWithoutSeparation(dt: number): void {
    const population = livingEntities();
    const schools = summarizeSchools(population);
    for (const entity of population) advanceEntity(view, entity, dt, schools.get(entity.schoolId));
  }

  /**
   * Trials and window for the two measurements below. 40 × 60 s is enough for
   * the medians to be stable run to run (the distributions are wide but their
   * middles are not), and the assertions are stated against the MEDIAN rather
   * than the minimum for exactly that reason: this plugin runs on unseeded RNG
   * by design (server/rng.ts), so any bound on the extreme tail of a random
   * walk is a bound on luck.
   */
  const SEPARATION_TRIALS = 40;
  const SEPARATION_SECONDS = 60;

  /**
   * The median worst-case gap separation must beat, in cells.
   *
   * 0.15 — measured. Over 100 trials of this exact scenario the median worst
   * gap is 0.033 cells WITHOUT separation and 0.290 WITH it; 0.15 sits between
   * the two with room on both sides, so this fails if separation stops working
   * and cannot pass by accident. It is deliberately NOT the 0.42-cell body gap
   * itself: a small fish steps 0.3 cells a tick against a 0.42-cell gap, so
   * that gap is not guaranteeable at all (shared/src/steering.ts's
   * `steerAvoiding` names the arithmetic) — what is claimed here is that
   * separation demonstrably shapes where they swim, which is what it is for.
   */
  const SEPARATED_MEDIAN_GAP_CELLS = 0.15;

  it('holds a school of fish off each other', () => {
    const worsts = worstGapOverTrials(SEPARATION_TRIALS, SEPARATION_SECONDS, (dt) =>
      advanceMovement(view, dt),
    );
    const median = worsts[Math.floor(worsts.length / 2)];
    expect(median).toBeGreaterThan(SEPARATED_MEDIAN_GAP_CELLS);
  });

  it('is what does it: the same five fish interpenetrate without the occupant list', () => {
    // THE CONTROL, and the bug being fixed — this plugin was the fourth copy of
    // the steering loop and the one that never gained separation, so a school
    // swam through itself. Same fish, same cohesion, same wander; the only
    // difference is whether anyone is told the others exist.
    const worsts = worstGapOverTrials(
      SEPARATION_TRIALS,
      SEPARATION_SECONDS,
      advanceWithoutSeparation,
    );
    const median = worsts[Math.floor(worsts.length / 2)];
    expect(median).toBeLessThan(SEPARATED_MEDIAN_GAP_CELLS);
  });

  it('sizes personal space from the body, not from one constant for every species', () => {
    // One constant for every species would either let whales overlap or hold
    // fish a whale's length apart. It is a HALF-EXTENT — half the body as the
    // client draws it, size class included — which is what makes it derived
    // rather than a tuning dial, and what makes a bigger creature hold a bigger
    // berth without anyone maintaining a table.
    installSchool('small', 1);
    const small = livingEntities()[0];
    expect(personalSpaceCellsOf(small) * 2).toBeCloseTo(bodyLengthCellsOf(small), 9);

    installSchool('large', 1);
    const large = livingEntities()[0];
    expect(personalSpaceCellsOf(large)).toBeGreaterThan(personalSpaceCellsOf(small));
  });
});

describe('the cohesion blend', () => {
  /** A fish with an explicit pose, for steering arithmetic. */
  function fishAt(x: number, y: number, heading: number, size: WildlifeSizeClass): WildlifeEntity {
    return { id: 1, species: 'fish', schoolId: 1, size, x, y, heading, fleeSecondsRemaining: 0 };
  }

  it('applies no pull at all inside the comfort radius', () => {
    for (const looseness of Object.values(SCHOOL_LOOSENESS_BY_SIZE)) {
      expect(cohesionPullRadiansPerSecond(0, looseness)).toBe(0);
      expect(cohesionPullRadiansPerSecond(SCHOOL_COMFORT_RADIUS_CELLS * looseness, looseness)).toBe(
        0,
      );
    }
  });

  it('ramps to the maximum at the full-pull radius and saturates beyond it', () => {
    const pullAtFull = cohesionPullRadiansPerSecond(SCHOOL_FULL_PULL_RADIUS_CELLS, 1);
    expect(pullAtFull).toBeCloseTo(SCHOOL_MAX_PULL_RADIANS_PER_SECOND, 10);
    expect(cohesionPullRadiansPerSecond(SCHOOL_FULL_PULL_RADIUS_CELLS * 10, 1)).toBe(pullAtFull);

    // Monotonic across the ramp — no step, no plateau in the middle.
    let previous = 0;
    for (let d = SCHOOL_COMFORT_RADIUS_CELLS; d <= SCHOOL_FULL_PULL_RADIUS_CELLS; d += 0.1) {
      const pull = cohesionPullRadiansPerSecond(d, 1);
      expect(pull).toBeGreaterThanOrEqual(previous);
      previous = pull;
    }
  });

  it('makes bigger fish school more loosely, on both halves of the dial', () => {
    // Ordering of the tuning itself: the "smaller fish school more" request
    // expressed as the numbers that implement it.
    const [small, medium, large] = WILDLIFE_SIZE_CLASSES;
    expect(SCHOOL_LOOSENESS_BY_SIZE[small]).toBeLessThan(SCHOOL_LOOSENESS_BY_SIZE[medium]);
    expect(SCHOOL_LOOSENESS_BY_SIZE[medium]).toBeLessThan(SCHOOL_LOOSENESS_BY_SIZE[large]);

    // A large fish tolerates a gap that already has a small one turning hard.
    const gap = SCHOOL_COMFORT_RADIUS_CELLS * 1.5;
    expect(cohesionPullRadiansPerSecond(gap, SCHOOL_LOOSENESS_BY_SIZE[small])).toBeGreaterThan(
      cohesionPullRadiansPerSecond(gap, SCHOOL_LOOSENESS_BY_SIZE[large]),
    );
  });

  it('turns toward the rest of the school, never further than the rate allows', () => {
    // Three members due east of the subject, well outside the comfort radius, so
    // the pull is saturated and the turn is exactly the per-tick rate limit.
    const subject = fishAt(0, 0, Math.PI, 'small');
    const away = SCHOOL_FULL_PULL_RADIUS_CELLS * 2;
    const school = summarizeSchools([
      subject,
      fishAt(away, 0, 0, 'small'),
      fishAt(away, 1, 0, 'small'),
      fishAt(away, -1, 0, 'small'),
    ]).get(1)!;

    const steered = steerWithSchool(
      subject,
      school,
      SCHOOL_LOOSENESS_BY_SIZE[subject.size],
      subject.heading,
      TICK_DT,
    );
    expect(Math.abs(normalizeAngle(steered - subject.heading))).toBeLessThanOrEqual(
      (SCHOOL_MAX_PULL_RADIANS_PER_SECOND + SCHOOL_ALIGNMENT_RADIANS_PER_SECOND) * TICK_DT + 1e-9,
    );
    // …and it is a turn TOWARD them: heading π (due west) moves toward 0.
    expect(Math.abs(steered)).toBeLessThan(Math.abs(subject.heading));
  });

  it('leaves a lone member unsteered', () => {
    const subject = fishAt(0, 0, 1.2, 'small');
    const school = summarizeSchools([subject]).get(1)!;
    expect(steerWithSchool(subject, school, SCHOOL_LOOSENESS_BY_SIZE.small, 1.2, TICK_DT)).toBe(
      1.2,
    );
  });

  it('excludes the member itself from its own school centroid', () => {
    // Two members, one at the origin and one 10 cells east. Including self would
    // put the centroid 5 cells away and halve the pull; excluding it puts the
    // target where the other fish actually is.
    const subject = fishAt(0, 0, 0, 'small');
    const school = summarizeSchools([subject, fishAt(10, 0, 0, 'small')]).get(1)!;
    // Facing north, with the other fish due east: it turns clockwise, toward 0.
    expect(
      steerWithSchool(subject, school, SCHOOL_LOOSENESS_BY_SIZE.small, Math.PI / 2, TICK_DT),
    ).toBeLessThan(Math.PI / 2);
  });

  it('ignores the mean heading of a school that has just scattered', () => {
    // Members whose headings cancel exactly: their circular mean has no
    // direction, and alignment must not invent one out of the rounding error.
    const subject = fishAt(0, 0, 0, 'small');
    const school = summarizeSchools([
      subject,
      fishAt(0, 0, 0, 'small'),
      fishAt(0, 0, Math.PI / 2, 'small'),
      fishAt(0, 0, Math.PI, 'small'),
      fishAt(0, 0, -Math.PI / 2, 'small'),
    ]).get(1)!;
    // Everyone is at the same point, so cohesion is zero too: the heading comes
    // back untouched, which is the whole assertion.
    expect(
      steerWithSchool(subject, school, SCHOOL_LOOSENESS_BY_SIZE.small, 0.75, TICK_DT),
    ).toBe(0.75);
  });
});

describe('habitat beats cohesion', () => {
  /**
   * An island: a square of land in the middle of shallow water, wider than a
   * school's full-pull radius so members cannot simply cross it.
   */
  const ISLAND_HALF_WIDTH_CELLS = 12;
  const ISLAND_HEIGHT = SEA_LEVEL + BAND_HEIGHT;

  function islandWorld(): World {
    return worldWithTerrain(WORLD_SIZE, (x, y) =>
      Math.abs(x - SCHOOL_ORIGIN_CELL) <= ISLAND_HALF_WIDTH_CELLS &&
      Math.abs(y - SCHOOL_ORIGIN_CELL) <= ISLAND_HALF_WIDTH_CELLS
        ? ISLAND_HEIGHT
        : OPEN_SHALLOW_HEIGHT,
    );
  }

  it('never pulls a member of a straddling school onto land', () => {
    resetWildlifeState();
    const world = islandWorld();
    const view = habitatView(world);

    // A school split by the island: two members west of it, three east, with the
    // centroid squarely on dry land. Cohesion is asking every one of them to
    // swim straight into the beach.
    const offset = ISLAND_HALF_WIDTH_CELLS + 2;
    installFish([
      { id: 1, schoolId: 1, size: 'small', x: SCHOOL_ORIGIN_CELL - offset, y: SCHOOL_ORIGIN_CELL },
      {
        id: 2,
        schoolId: 1,
        size: 'small',
        x: SCHOOL_ORIGIN_CELL - offset,
        y: SCHOOL_ORIGIN_CELL + 1,
      },
      { id: 3, schoolId: 1, size: 'small', x: SCHOOL_ORIGIN_CELL + offset, y: SCHOOL_ORIGIN_CELL },
      {
        id: 4,
        schoolId: 1,
        size: 'small',
        x: SCHOOL_ORIGIN_CELL + offset,
        y: SCHOOL_ORIGIN_CELL + 1,
      },
      {
        id: 5,
        schoolId: 1,
        size: 'small',
        x: SCHOOL_ORIGIN_CELL + offset,
        y: SCHOOL_ORIGIN_CELL - 1,
      },
    ]);
    const centre = centroidOf(livingEntities());
    expect(habitatOf(world.heightAt(Math.round(centre.x), Math.round(centre.y)))).toBe('land');

    for (let n = 0; n < ticksFor(SCHOOL_OBSERVATION_SECONDS); n++) {
      advanceMovement(view, TICK_DT);
      for (const fish of livingEntities()) {
        expect(isValidCellFor(view, 'fish', fish.x, fish.y)).toBe(true);
      }
    }

    // Nothing had to be culled to keep that true — the steering veto did it, not
    // the habitat sweep tidying up afterwards.
    expect(despawnInvalidHabitat(view)).toBe(0);
    expect(livingEntities()).toHaveLength(SCHOOL_UNDER_TEST_MEMBERS);
  });
});

/**
 * Schools of fish used in the turnover suites. 30 × the 5-member group size is
 * exactly WILDLIFE_POPULATION_CAP, which is the largest sample a hand-built
 * population can have (loadPopulation stops at the cap) and therefore the
 * tightest statistics available.
 */
const TURNOVER_SCHOOLS = WILDLIFE_POPULATION_CAP / SCHOOL_UNDER_TEST_MEMBERS;

/**
 * Independent trials the turnover rate is measured over.
 *
 * One trial of 30 schools has a standard deviation of ~2.6 departed schools
 * (√(30 × 0.632 × 0.368)) against a mean of 19 — 14% relative. Eight trials
 * bring that to 5%, so the ±25% tolerance below is five standard deviations,
 * which is what makes an unseeded statistical test safe to run in CI.
 */
const TURNOVER_TRIALS = 8;

/**
 * Fraction of the expected departure count the measurement may differ by. See
 * TURNOVER_TRIALS for why 0.25 is ~5σ and not a guess.
 */
const TURNOVER_RATE_TOLERANCE = 0.25;

/**
 * Fraction of a population that has departed after one mean lifetime:
 * 1 − e⁻¹ for an exponential lifetime, which is what both the per-individual
 * and the per-school roll produce (see the arithmetic in population.ts).
 */
const DEPARTED_FRACTION_AFTER_ONE_LIFETIME = 1 - Math.exp(-1);

/** Installs `schools` schools of `members` fish each, all in open water. */
function installSchools(schools: number, members: number): void {
  const entities: Array<{
    id: number;
    schoolId: number;
    size: WildlifeSizeClass;
    x: number;
    y: number;
  }> = [];
  for (let school = 0; school < schools; school++) {
    for (let member = 0; member < members; member++) {
      entities.push({
        id: entities.length + 1,
        schoolId: school + 1,
        size: 'small',
        // Spread the schools out so they are independent bodies of fish; the
        // turnover roll does not read position, but a test that looked like a
        // single 150-fish pile would be misleading about what it models.
        x: SCHOOL_ORIGIN_CELL + school,
        y: SCHOOL_ORIGIN_CELL,
      });
    }
  }
  installFish(entities);
}

/** Living members of each school id, keyed by school. */
function membersBySchool(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const entity of livingEntities()) {
    counts.set(entity.schoolId, (counts.get(entity.schoolId) ?? 0) + 1);
  }
  return counts;
}

/** Departures observed over `seconds` of turnover on a freshly built population. */
function departuresOver(schools: number, members: number, seconds: number): number {
  installSchools(schools, members);
  const before = naturalDepartureCount();
  for (let n = 0; n < ticksFor(seconds); n++) applyNaturalTurnover(TICK_DT);
  return naturalDepartureCount() - before;
}

describe('school-level natural turnover', () => {
  beforeEach(() => {
    resetWildlifeState();
  });

  it('takes a whole school at a time, never part of one', () => {
    // THE point of the change: a school that is losing members one by one is a
    // school being visibly eroded, and the strays it leaves behind can never
    // rejoin anything. Departures are all-or-nothing, and that is exact — no
    // bound, no statistics.
    installSchools(TURNOVER_SCHOOLS, SCHOOL_UNDER_TEST_MEMBERS);

    // A coarse dt so departures happen quickly; the roll is dt/L either way.
    const COARSE_TURNOVER_DT_SECONDS = 30;
    for (let n = 0; n < 40 && livingEntities().length > 0; n++) {
      applyNaturalTurnover(COARSE_TURNOVER_DT_SECONDS);
      for (const [, members] of membersBySchool()) {
        expect(members).toBe(SCHOOL_UNDER_TEST_MEMBERS);
      }
    }

    // And the population really did turn over, rather than the assertion above
    // holding because nothing ever happened.
    expect(livingEntities().length).toBeLessThan(WILDLIFE_POPULATION_CAP);
    expect(naturalDepartureCount() % SCHOOL_UNDER_TEST_MEMBERS).toBe(0);
  });

  it('preserves the rate at which individual fish leave', () => {
    // The arithmetic in population.ts, measured: rolling once per school of k
    // and removing k loses the same fish per second as rolling k times and
    // removing one. If a "correspondingly longer mean" had been applied, this
    // would come out five times too low.
    let departed = 0;
    for (let trial = 0; trial < TURNOVER_TRIALS; trial++) {
      departed += departuresOver(
        TURNOVER_SCHOOLS,
        SCHOOL_UNDER_TEST_MEMBERS,
        NATURAL_LIFESPAN_SECONDS,
      );
    }

    const expected =
      TURNOVER_TRIALS * WILDLIFE_POPULATION_CAP * DEPARTED_FRACTION_AFTER_ONE_LIFETIME;
    expect(departed).toBeGreaterThan(expected * (1 - TURNOVER_RATE_TOLERANCE));
    expect(departed).toBeLessThan(expected * (1 + TURNOVER_RATE_TOLERANCE));
  });

  it('leaves solitary creatures on exactly the per-individual roll they had', () => {
    // The control: schools of one — which is what every non-schooling species
    // is, and what a lone-remainder fish is. Same population, same window, same
    // expected count as the schools above.
    let departed = 0;
    for (let trial = 0; trial < TURNOVER_TRIALS; trial++) {
      departed += departuresOver(WILDLIFE_POPULATION_CAP, 1, NATURAL_LIFESPAN_SECONDS);
    }

    const expected =
      TURNOVER_TRIALS * WILDLIFE_POPULATION_CAP * DEPARTED_FRACTION_AFTER_ONE_LIFETIME;
    expect(departed).toBeGreaterThan(expected * (1 - TURNOVER_RATE_TOLERANCE));
    expect(departed).toBeLessThan(expected * (1 + TURNOVER_RATE_TOLERANCE));
  });

  it('never strands a school that has shrunk to its last member', () => {
    // A school reduced to one by habitat loss must keep rolling like anything
    // else: neither immortal (a bug where only multi-member schools are rolled)
    // nor culled on sight.
    installSchools(TURNOVER_SCHOOLS, SCHOOL_UNDER_TEST_MEMBERS);

    // Strip every school down to one member, the way a drained bay would.
    for (let i = livingEntities().length - 1; i >= 0; i--) {
      const entity = livingEntities()[i];
      const rank = livingEntities()
        .filter((other) => other.schoolId === entity.schoolId)
        .indexOf(entity);
      if (rank > 0) despawnWithCredit(i);
    }
    expect(livingEntities()).toHaveLength(TURNOVER_SCHOOLS);
    for (const [, members] of membersBySchool()) expect(members).toBe(1);

    const before = naturalDepartureCount();
    for (let n = 0; n < ticksFor(NATURAL_LIFESPAN_SECONDS); n++) applyNaturalTurnover(TICK_DT);

    // Some left, some did not: an exponential lifetime, not a cliff.
    expect(naturalDepartureCount() - before).toBeGreaterThan(0);
    expect(livingEntities().length).toBeGreaterThan(0);
  });
});

// ── Size classes, end to end through the spawn path ──────────────────────────

/**
 * Simulated seconds a fish-only world is watched for while sampling spawned
 * groups. Long enough that turnover replaces the population several times, so
 * the sample is ~125 groups rather than the ~40 alive at any instant — measured,
 * and comfortably more than the ratios below need.
 *
 * It is also the longest-running test in this file, so it is deliberately not
 * longer: the whole workspace suite runs several vitest instances in parallel,
 * and a test that sits at half the default timeout on an idle machine is a
 * timeout flake on a busy one.
 */
const SIZE_SAMPLE_SECONDS = 450;

/**
 * Wall-clock budget for the size-class sample, in milliseconds.
 *
 * SIZE_SAMPLE_SECONDS above is 450 simulated seconds at TICK_DT = 0.1, i.e.
 * 4,500 host ticks, each one stepping every living fish and re-counting every
 * school — measured at ~5 s here, right on Vitest's default and therefore over
 * it whenever the machine is busy.
 *
 * Raised rather than shortening the sample: the assertions are about which
 * size classes appear and in what proportion, and those are only meaningful
 * over enough turnover to cycle the population several times.
 *
 * 2026-08-21: added after this failed on a loaded machine and passed on an
 * idle one. See the note in the commit — four tests across four packages had
 * the same shape.
 */
const SIZE_SAMPLE_TIMEOUT_MS = 30_000;

/**
 * How many times more common small fish must be than large ones in the sample.
 *
 * FISH_SIZE_WEIGHTS asks for 6 : 1, and over a sample this size the measured
 * ratio sits between 4.4 and 9.2 (200 trials' worth of sampling). Asserting
 * only 2 leaves room for ordinary multinomial jitter while still failing loudly
 * if the weights stop being read.
 */
const SMALL_TO_LARGE_ABUNDANCE_FLOOR = 2;

/**
 * How many times larger a small fish's typical school must be than a large
 * fish's, measured as fish-per-school.
 *
 * The probabilities predict 5/(0.9 + 5×0.1) = 3.6 members per small school
 * against 5/(0.1 + 5×0.9) = 1.1 for large — a ratio above 3, and the measured
 * range is 2.7–3.4. Asserting 1.5 is half the predicted effect, which no
 * plausible jitter reaches but a broken SCHOOLING_PROBABILITY_BY_SIZE lookup
 * would fail instantly.
 */
const SMALL_TO_LARGE_SCHOOL_SIZE_FLOOR = 1.5;

describe('fish size classes drive schooling', () => {
  it('orders the tuning tables smallest-schools-most', () => {
    const [small, medium, large] = WILDLIFE_SIZE_CLASSES;
    expect(SCHOOLING_PROBABILITY_BY_SIZE[small]).toBeGreaterThan(
      SCHOOLING_PROBABILITY_BY_SIZE[medium],
    );
    expect(SCHOOLING_PROBABILITY_BY_SIZE[medium]).toBeGreaterThan(
      SCHOOLING_PROBABILITY_BY_SIZE[large],
    );
    expect(FISH_SIZE_WEIGHTS[small]).toBeGreaterThan(FISH_SIZE_WEIGHTS[medium]);
    expect(FISH_SIZE_WEIGHTS[medium]).toBeGreaterThan(FISH_SIZE_WEIGHTS[large]);
    // Every non-fish species has exactly one size, so nothing else in the plugin
    // needs a "does this species vary" flag.
    for (const species of WILDLIFE_HABITAT_SPECIES) {
      if (species === 'fish') continue;
      const weights = profileOf(species).sizeWeights;
      expect(WILDLIFE_SIZE_CLASSES.filter((size) => weights[size] > 0)).toEqual([
        DEFAULT_SIZE_CLASS,
      ]);
    }
  });

  it('spawns all three sizes, small most often, and schools them accordingly', () => {
    // A world that is nothing but fish habitat, run long enough for turnover to
    // cycle the population several times over. Every school id ever seen is
    // recorded with the size it was born at and the most members it ever had.
    const harness = bootOn(openShallowWorld());
    const seen = new Map<number, { size: WildlifeSizeClass; members: number }>();

    for (let n = 0; n < ticksFor(SIZE_SAMPLE_SECONDS); n++) {
      harness.host.tick(TICK_DT);
      const counts = membersBySchool();
      for (const entity of livingEntities()) {
        const previous = seen.get(entity.schoolId);
        const members = counts.get(entity.schoolId) ?? 1;
        if (previous === undefined) seen.set(entity.schoolId, { size: entity.size, members });
        else if (members > previous.members) previous.members = members;
      }
    }

    const bySize = (size: WildlifeSizeClass) =>
      [...seen.values()].filter((school) => school.size === size);
    const [small, , large] = WILDLIFE_SIZE_CLASSES;

    // Every class actually occurs.
    for (const size of WILDLIFE_SIZE_CLASSES) expect(bySize(size).length).toBeGreaterThan(0);

    // Small fish are the many. Counted in FISH, not in schools: a solitary large
    // fish makes one school per fish, so counting schools would flatter it.
    const fishOf = (size: WildlifeSizeClass) =>
      bySize(size).reduce((sum, school) => sum + school.members, 0);
    expect(fishOf(small)).toBeGreaterThan(fishOf(large) * SMALL_TO_LARGE_ABUNDANCE_FLOOR);

    // And small fish are the ones in schools: more fish per school than large.
    const membersPerSchool = (size: WildlifeSizeClass) => fishOf(size) / bySize(size).length;
    expect(membersPerSchool(small)).toBeGreaterThan(
      membersPerSchool(large) * SMALL_TO_LARGE_SCHOOL_SIZE_FLOOR,
    );
    expect(membersPerSchool(large)).toBeLessThan(SCHOOL_UNDER_TEST_MEMBERS);
  }, SIZE_SAMPLE_TIMEOUT_MS);

  it('carries school and size through a snapshot unchanged', () => {
    // Without this the whole behaviour is undone by a restart: school membership
    // cannot be recovered from position, so a dropped schoolId would restore
    // every school as permanent singletons.
    const harness = bootOn(openShallowWorld());
    tick(harness, ticksFor(SETTLE_SECONDS));
    const before = livingEntities().map((entity) => ({ ...entity }));
    expect(before.length).toBeGreaterThan(0);
    expect(new Set(before.map((entity) => entity.schoolId)).size).toBeLessThan(before.length);

    const slices = harness.host.collectPersistence();
    const restored = bootOn(openShallowWorld());
    restored.host.restorePersistence(slices);

    expect(livingEntities().map((entity) => ({ ...entity }))).toEqual(before);
  });

  it('restores a pre-schooling snapshot as independent wanderers', () => {
    // Old slices carry no schoolId. The honest reading is "creatures whose
    // schools we no longer know" — one school each — not one giant school.
    resetWildlifeState();
    loadPopulation({
      version: 1,
      nextId: 4,
      entities: [
        { id: 1, species: 'fish', x: 10, y: 10, heading: 0 },
        { id: 2, species: 'fish', x: 11, y: 10, heading: 0 },
        { id: 3, species: 'fish', x: 12, y: 10, heading: 0 },
      ],
    });

    const schools = livingEntities().map((entity) => entity.schoolId);
    expect(new Set(schools).size).toBe(schools.length);
    for (const entity of livingEntities()) expect(entity.size).toBe(DEFAULT_SIZE_CLASS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BIRD FLOCKS
//
// The flock subsystem is deliberately independent of the habitat population
// (server/flocks.ts), so most of it is tested against a bare FlockWorld — a
// worldSize and nothing else. That the tests CAN be written that way is itself
// the contract: the day a bird needs terrain, this object stops being enough.
// ─────────────────────────────────────────────────────────────────────────────

const FLOCK_WORLD: FlockWorld = { worldSize: WORLD_SIZE };

/** The flock with this id, or undefined once it has left. */
function flockById(id: number): Flock | undefined {
  return livingFlocks().find((flock) => flock.id === id);
}

/** Distance of the furthest member from its flock's centroid, in cells. */
function flockSpreadCells(flock: Flock): number {
  const centroid = flockCentroid(flock);
  let furthest = 0;
  for (const bird of flock.birds) {
    furthest = Math.max(furthest, Math.hypot(bird.x - centroid.x, bird.y - centroid.y));
  }
  return furthest;
}

function distanceFromWorldCentre(x: number, y: number): number {
  const centre = WORLD_SIZE / 2;
  return Math.hypot(x - centre, y - centre);
}

describe('bird flocks arrive, cross and leave', () => {
  beforeEach(() => {
    resetWildlifeState();
  });

  it('is born off the map, in a cluster, on a course aimed across it', () => {
    const flock = spawnFlock(FLOCK_WORLD);

    expect(flock.birds.length).toBeGreaterThanOrEqual(BIRDS_PER_FLOCK_MIN);
    expect(flock.birds.length).toBeLessThanOrEqual(BIRDS_PER_FLOCK_MAX);

    // Off the map: the crossing ring circumscribes the square world, so every
    // bird starts beyond the furthest cell a player can be looking at, minus at
    // most the diagonal of its own spawn scatter.
    const ring = crossingRadiusCells(WORLD_SIZE);
    for (const bird of flock.birds) {
      expect(distanceFromWorldCentre(bird.x, bird.y)).toBeGreaterThan(
        ring - FLOCK_SPAWN_SCATTER_CELLS * Math.SQRT2 - 1e-9,
      );
      // One shared course at birth — a flock leaves the ring as a flock.
      expect(bird.heading).toBe(flock.courseHeading);
    }

    // …and the course points INTO the world, not along the ring: the aim point
    // is near the centre, so flying it must reduce the distance to the centre.
    const before = flockCentroid(flock);
    const step = BIRD_CRUISE_SPEED_CELLS_PER_SECOND;
    const after = {
      x: before.x + Math.cos(flock.courseHeading) * step,
      y: before.y + Math.sin(flock.courseHeading) * step,
    };
    expect(distanceFromWorldCentre(after.x, after.y)).toBeLessThan(
      distanceFromWorldCentre(before.x, before.y),
    );
  });

  it('crosses in a roughly straight line and departs at the far side', () => {
    const flock = spawnFlock(FLOCK_WORLD);
    const id = flock.id;
    const start = flockCentroid(flock);

    let elapsed = 0;
    let pathLength = 0;
    let previous = start;
    let closestApproach = distanceFromWorldCentre(start.x, start.y);
    let last = start;

    // Bounded by the lifetime guard, which is 2× the straight-line crossing: if
    // the flock were still here after that, the guard — not the crossing — would
    // have removed it, and the assertions below say which happened.
    const limit = flockLifetimeLimitSeconds(WORLD_SIZE);
    while (flockById(id) !== undefined && elapsed < limit) {
      advanceFlocks(FLOCK_WORLD, TICK_DT);
      elapsed += TICK_DT;
      const current = flockById(id);
      if (current === undefined) break;
      last = flockCentroid(current);
      pathLength += Math.hypot(last.x - previous.x, last.y - previous.y);
      previous = last;
      closestApproach = Math.min(closestApproach, distanceFromWorldCentre(last.x, last.y));
    }

    expect(flockById(id)).toBeUndefined();
    // It left by CROSSING, comfortably before the wedged-flock guard could fire.
    expect(elapsed).toBeLessThan(limit);

    // It really crossed the world rather than clipping the ring: the aim spread
    // keeps every course through the middle of the map.
    expect(closestApproach).toBeLessThan((WORLD_SIZE / 2) * Math.SQRT2);
    // …and it went out the FAR side, not back the way it came. `last` is the
    // final centroid this test could OBSERVE — the flock is removed inside the
    // same advanceFlocks call that carries it past the ring — so the bound is
    // the despawn radius less the one tick of travel that finished the job.
    expect(distanceFromWorldCentre(last.x, last.y)).toBeGreaterThan(
      despawnRadiusCells(WORLD_SIZE) - BIRD_CRUISE_SPEED_CELLS_PER_SECOND * TICK_DT,
    );

    // ROUGHLY STRAIGHT, stated as a number: net displacement over distance
    // actually flown. Perfectly straight is 1; the course-hold is 4× the wander
    // noise, so the wander costs a couple of percent at most.
    const displacement = Math.hypot(last.x - start.x, last.y - start.y);
    expect(displacement / pathLength).toBeGreaterThan(0.95);
  });

  it('holds together as a loose cluster for the whole crossing', () => {
    const flock = spawnFlock(FLOCK_WORLD);
    const id = flock.id;

    // The radius at which cohesion is already pulling as hard as it can. A flock
    // that never reaches it never had a straggler worth the name.
    const dispersed = SCHOOL_FULL_PULL_RADIUS_CELLS * BIRD_FLOCK_LOOSENESS;

    let worst = 0;
    for (let n = 0; n < ticksFor(flockLifetimeLimitSeconds(WORLD_SIZE)); n++) {
      advanceFlocks(FLOCK_WORLD, TICK_DT);
      const current = flockById(id);
      if (current === undefined) break;
      worst = Math.max(worst, flockSpreadCells(current));
    }

    // Not a point, and not a smear: a cluster.
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(dispersed);
  });

  it('never has more than MAX_CONCURRENT_FLOCKS aloft, or MAX_BIRDS_ALOFT birds', () => {
    // Long enough that the arrival hazard fires many times over.
    for (let n = 0; n < ticksFor(FLOCK_MEAN_SPAWN_INTERVAL_SECONDS * 20); n++) {
      advanceFlocks(FLOCK_WORLD, TICK_DT);
      expect(livingFlocks().length).toBeLessThanOrEqual(MAX_CONCURRENT_FLOCKS);
      expect(livingBirds().length).toBeLessThanOrEqual(MAX_BIRDS_ALOFT);
    }
  });

  it('keeps producing flocks — the sky never runs dry', () => {
    const seen = new Set<number>();
    for (let n = 0; n < ticksFor(FLOCK_MEAN_SPAWN_INTERVAL_SECONDS * 20); n++) {
      advanceFlocks(FLOCK_WORLD, TICK_DT);
      for (const flock of livingFlocks()) seen.add(flock.id);
    }
    // Twenty mean intervals against two slots: several distinct crossings, so
    // arrivals are an ongoing process and not a one-off at boot.
    expect(seen.size).toBeGreaterThan(2);
  });

  it('bounds the whole broadcast at the population cap plus the sky', () => {
    expect(MAX_BIRDS_ALOFT).toBe(MAX_CONCURRENT_FLOCKS * BIRDS_PER_FLOCK_MAX);
    expect(BROADCAST_ENTITY_CEILING).toBe(WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT);
  });
});

describe('birds are not habitat fauna', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('survives ticks that would cull a creature standing where it flies', () => {
    // Nothing about a bird's position is habitat, so the per-tick habitat sweep
    // — the thing that would delete a fifth census species instantly — must not
    // see it at all.
    const flock = spawnFlock({ worldSize: harness.world.size });
    const born = flock.birds.length;

    tick(harness, ticksFor(5));
    expect(flockById(flock.id)?.birds.length).toBe(born);
  });

  it('is unmoved by the sculpt panic that scatters a school', () => {
    const flock = spawnFlock({ worldSize: harness.world.size });
    const before = flock.birds.map((bird) => ({ ...bird }));

    // Startle everything at the flock's own position, with a radius that covers
    // the whole world. Fish there would bolt; birds have no flee state at all,
    // because panic is a habitat concept.
    const centroid = flockCentroid(flock);
    startleNear(centroid.x, centroid.y, WORLD_SIZE * 2);

    expect(flockById(flock.id)?.birds).toEqual(before);
  });

  it('shares the entity-id space with the habitat population', () => {
    fillPopulation(harness);
    spawnFlock({ worldSize: harness.world.size });
    spawnFlock({ worldSize: harness.world.size });

    const ids = [...livingEntities().map((e) => e.id), ...livingBirds().map((b) => b.id)];
    expect(ids.length).toBeGreaterThan(BIRDS_PER_FLOCK_MIN);
    // One allocator, so no bird can inherit a fish's interpolation on the client.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('appears in the same broadcast as everything else', () => {
    spawnFlock({ worldSize: harness.world.size });
    harness.sink.clear();
    tick(harness, 2);

    const payload = harness.sink.ofType('wildlife:entities')[0].payload as {
      entities: Array<Record<string, unknown>>;
    };
    const birds = payload.entities.filter((entity) => entity.species === 'bird');
    expect(birds.length).toBe(livingBirds().length);
    // The same six keys as every other creature — no altitude, no flock id, no
    // wing phase. The client derives all three.
    for (const bird of birds) {
      expect(Object.keys(bird).sort()).toEqual(['heading', 'id', 'size', 'species', 'x', 'y']);
    }
  });

  it('is not persisted, and a restore clears the sky', () => {
    spawnFlock({ worldSize: harness.world.size });
    expect(birdStates().length).toBeGreaterThan(0);

    const slices = harness.host.collectPersistence();
    const slice = slices.wildlife as { entities: Array<{ species: string }> };
    // A crossing is not world state: nothing about it survives the snapshot.
    expect(slice.entities.some((entity) => entity.species === 'bird')).toBe(false);

    harness.host.restorePersistence(slices);
    // …and a restore resets the shared id counter, so the sky has to be cleared
    // with it or an airborne bird would hold an id about to be reissued.
    expect(livingBirds()).toHaveLength(0);
  });

  it('refuses to restore a bird someone wrote into a snapshot', () => {
    resetWildlifeState();
    loadPopulation({
      version: 1,
      nextId: 3,
      entities: [
        { id: 1, species: 'fish', x: 10, y: 10, heading: 0, schoolId: 1, size: 0 },
        { id: 2, species: 'bird', x: 20, y: 20, heading: 0, schoolId: 2, size: 1 },
      ],
    });

    // A bird in a slice is a hand-edited or forward-versioned file. Restoring it
    // as a habitat creature would produce something with no habitat, which the
    // sweep would then delete anyway — dropping the row is the honest read.
    expect(livingEntities().map((entity) => entity.species)).toEqual(['fish']);
  });
});

describe('flock steering keeps its priorities in order', () => {
  beforeEach(() => {
    resetWildlifeState();
  });

  it('ranks course-hold above the wander noise and below cohesion', () => {
    // The three terms that share one heading, in the order they must beat each
    // other. The cohesion figure is the EFFECTIVE one — cohesionPullRadiansPerSecond
    // divides the maximum by the looseness — which is the number a retune of
    // either constant is most likely to get wrong.
    const effectiveCohesion = SCHOOL_MAX_PULL_RADIANS_PER_SECOND / BIRD_FLOCK_LOOSENESS;
    expect(FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND).toBeGreaterThan(
      BIRD_TURN_NOISE_RADIANS_PER_SECOND,
    );
    expect(FLOCK_COURSE_CORRECTION_RADIANS_PER_SECOND).toBeLessThan(effectiveCohesion);
  });

  it('closes the gap on a bird displaced across the course', () => {
    // The behaviour that ordering buys: a straggler wants to rejoin more than it
    // wants to hold the line. A course-hold that outranked cohesion would leave
    // the two flying perfectly straight parallel courses — which no straightness
    // measurement can see, so it is asserted here instead.
    const flock = spawnFlock(FLOCK_WORLD);
    const centre = flockCentroid(flock);
    const stray = flock.birds[0];
    const across = flock.courseHeading + Math.PI / 2;
    const displacement = SCHOOL_FULL_PULL_RADIUS_CELLS * BIRD_FLOCK_LOOSENESS * 3;
    stray.x = centre.x + Math.cos(across) * displacement;
    stray.y = centre.y + Math.sin(across) * displacement;

    const gapToRest = (): number => {
      const others = flock.birds.slice(1);
      const rest = flockCentroid({ ...flock, birds: others });
      return Math.hypot(stray.x - rest.x, stray.y - rest.y);
    };

    const before = gapToRest();
    for (let n = 0; n < ticksFor(30); n++) advanceFlocks(FLOCK_WORLD, TICK_DT);
    // Measured at ~55% closed over 30 s; asserted loosely, because the wander is
    // unseeded and this is a rate, not a target.
    expect(gapToRest()).toBeLessThan(before * 0.75);
  });
});
