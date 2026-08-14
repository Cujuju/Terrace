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
import type { World } from '../../../server/src/world/world.ts';
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
  livingEntities,
  pendingCreditCount,
  populationTargets,
} from '../server/population.ts';
import { DEEP_WATER_MAX_HEIGHT, habitatOf, profileOf } from '../server/species.ts';
import { worldWithTerrain } from './support/world.ts';

/** 256² cells = 16×16 chunks — big enough that all four habitats are populated. */
const WORLD_SIZE = 256;

/** Default server tick period (TICK_HZ = 10). */
const TICK_DT = 0.1;

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

function boot(): Harness {
  resetWildlifeState();

  const world = worldWithTerrain(WORLD_SIZE, rampHeight, isChunkLocked);
  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [wildlifePlugin].map(asLoadedPlugin));
  host.worldCreate();
  world.addPlayer(PLAYER);
  host.playerJoined(PLAYER);

  return { world, host, sink };
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

/** Ticks until every species has reached its target, or gives up. */
function fillPopulation(harness: Harness): void {
  tick(harness, 200);
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
    // The documented ecosystem: ~85 creatures, with fish the most numerous and
    // whales the rarest.
    expect(total).toBeGreaterThan(WILDLIFE_POPULATION_CAP / 2);
    expect(targets.fish).toBeGreaterThan(targets.whale);
    expect(targets.whale).toBeGreaterThan(0);
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

  it('starts empty and fills to the habitat targets, then holds steady', () => {
    expect(livingEntities()).toHaveLength(0);

    fillPopulation(harness);
    const targets = populationTargets();
    expect(countsBySpecies()).toEqual(targets);

    const settled = livingEntities().length;
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);

    tick(harness, 300);
    expect(livingEntities()).toHaveLength(settled);
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
    for (let n = 0; n < 600; n++) {
      harness.host.tick(TICK_DT);
      for (const entity of livingEntities()) {
        expect(isValidCellFor(view, entity.species, entity.x, entity.y)).toBe(true);
      }
    }

    // Nothing was quietly culled to keep the invariant true.
    expect(livingEntities()).toHaveLength(before);
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

    // The credit ripens after HABITAT_LOSS_RESPAWN_DELAY_SECONDS; give it that
    // plus a census interval to be re-counted.
    tick(harness, 200);
    expect(countsBySpecies().fish).toBe(populationTargets().fish);
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
