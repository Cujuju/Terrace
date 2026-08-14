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
  World,
} from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin } from '../../../server/test/support/harness.ts';
import { WILDLIFE_SPECIES, type WildlifeSpecies } from '../protocol.ts';
import {
  WILDLIFE_POPULATION_CAP,
  type HabitatWorld,
  isValidCellFor,
  targetsFor,
} from '../server/census.ts';
import {
  FLEE_RADIUS_CELLS,
  plugin as wildlifePlugin,
  resetWildlifeState,
} from '../server/index.ts';
import { FLEE_SPEED_MULTIPLIER, isFleeing, speedOf } from '../server/movement.ts';
import { loadPopulation } from '../server/persistence.ts';
import {
  NATURAL_LIFESPAN_SECONDS,
  SPAWN_MEAN_WAIT_SECONDS,
  despawnInvalidHabitat,
  livingEntities,
  naturalDepartureCount,
  pendingCreditCount,
  populationTargets,
} from '../server/population.ts';
import {
  DEEP_WATER_BANDS_BELOW_SEA,
  DEEP_WATER_MAX_HEIGHT,
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

const PLAYER: Player = { id: 'session-1', name: 'Tester' };

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
  return WILDLIFE_SPECIES.reduce((sum, species) => sum + targets[species], 0);
}

function countsBySpecies(): Record<WildlifeSpecies, number> {
  const counts: Record<WildlifeSpecies, number> = { fish: 0, whale: 0, deepsea: 0, grazer: 0 };
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
  it('puts the fresh seabed at or below the deep-water threshold', () => {
    // THE cross-package contract: core sets the fresh seabed depth and cannot
    // import this plugin's threshold, so the relation between the two numbers is
    // asserted here. If either moves the wrong way, whales lose their habitat on
    // day one all over again — which is the bug this pair of constants fixes.
    expect(FRESH_SEABED_BANDS_BELOW_SEA).toBeGreaterThanOrEqual(DEEP_WATER_BANDS_BELOW_SEA);
    expect(FRESH_SEABED_HEIGHT).toBeLessThanOrEqual(DEEP_WATER_MAX_HEIGHT);
    expect(habitatOf(FRESH_SEABED_HEIGHT)).toBe('deep');
  });

  it('classifies every cell of a fresh world as deep water', () => {
    const world = World.createFresh(WORLD_SIZE);
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        if (habitatOf(world.heightAt(x, y)) === 'deep') continue;
        // Report the first offender rather than 65 536 passing assertions.
        throw new Error(`cell (${x},${y}) is ${habitatOf(world.heightAt(x, y))}, not deep`);
      }
    }
    expect(world.heightAt(0, 0)).toBe(FRESH_SEABED_HEIGHT);
  });

  it('spawns whales and deep-sea creatures on a fresh world, and nothing else', () => {
    const harness = bootOn(World.createFresh(WORLD_SIZE));
    tick(harness, ticksFor(SETTLE_SECONDS));

    const counts = countsBySpecies();
    expect(counts.whale).toBeGreaterThanOrEqual(1);
    expect(counts.deepsea).toBeGreaterThanOrEqual(4);
    // No shallow shelf and no land exist yet, so these two cannot be anywhere.
    expect(counts.fish).toBe(0);
    expect(counts.grazer).toBe(0);

    // And they are where the starter unlock is — not scattered over the locked
    // remainder of the ocean.
    for (const entity of livingEntities()) {
      expect(harness.world.isCellUnlocked(Math.floor(entity.x), Math.floor(entity.y))).toBe(true);
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
    const total = WILDLIFE_SPECIES.reduce((sum, s) => sum + targets[s], 0);
    expect(total).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);
    // The documented ecosystem after the 2026-08-14 retune: 167 asked for, the
    // cap scaling that to 148, with whales still the rarest species.
    expect(total).toBeGreaterThan(WILDLIFE_POPULATION_CAP / 2);
    expect(targets.fish).toBeGreaterThan(targets.whale);
    expect(targets.whale).toBeGreaterThan(0);
  });

  it("stocks a fresh world's starter ocean with deep-water life on day one", () => {
    // Every cell of a fresh world is deep water, so the starter region's whole
    // area counts as deep habitat and nothing else exists yet.
    const starterEdgeCells = INITIAL_UNLOCK_CHUNK_SPAN * CHUNK_SIZE;
    const starterCells = starterEdgeCells * starterEdgeCells;
    const targets = targetsFor({ land: 0, shallow: 0, deep: starterCells });

    // The documented densities, restated as the outcome they were chosen for.
    expect(targets.whale).toBe(
      Math.floor(starterCells / profileOf('whale').habitatCellsPerIndividual),
    );
    expect(targets.deepsea).toBe(
      Math.floor(starterCells / profileOf('deepsea').habitatCellsPerIndividual),
    );
    // "2–3 whales and several deep-sea creatures immediately" (owner, 2026-08-14).
    expect(targets.whale).toBeGreaterThanOrEqual(2);
    expect(targets.deepsea).toBeGreaterThanOrEqual(5);
    // Fish and grazers have no habitat until someone sculpts a shelf or an
    // island — a fresh world is open ocean, and this is the honest consequence.
    expect(targets.fish).toBe(0);
    expect(targets.grazer).toBe(0);
  });

  it('scales every species down proportionally rather than truncating one', () => {
    const uncapped = targetsFor({ land: 0, shallow: 300000, deep: 300000 });
    const total = WILDLIFE_SPECIES.reduce((sum, s) => sum + uncapped[s], 0);
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
    for (const species of WILDLIFE_SPECIES) {
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
    expect(messages[0].target).toBe('broadcast');

    const payload = messages[0].payload as { entities: Array<Record<string, unknown>> };
    expect(payload.entities).toHaveLength(livingEntities().length);

    for (const entity of payload.entities) {
      expect(Object.keys(entity).sort()).toEqual(['heading', 'id', 'species', 'x', 'y']);
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
      entities: Array<{ x: number; y: number }>;
    };
    for (const entity of payload.entities) {
      expect(harness.world.isCellUnlocked(Math.floor(entity.x), Math.floor(entity.y))).toBe(true);
    }
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
