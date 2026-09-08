import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  SEA_LEVEL,
  cellsAcross,
  cellsOverArea,
  isWater,
  newStillness,
} from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import type { Player } from '../../../server/src/player.ts';
import { World } from '../../../server/src/world/world.ts';
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
  type WildlifeSizeClass,
  isWildlifeHabitatSpecies,
} from '../protocol.ts';
import {
  WILDLIFE_POPULATION_CAP,
  targetsFor,
} from '../server/census.ts';
import {
  BROADCAST_ENTITY_CEILING,
  plugin as wildlifePlugin,
  resetWildlifeState,
} from '../server/index.ts';
import {
  BIRDS_PER_FLOCK_MAX,
  BIRDS_PER_FLOCK_MIN,
  FLOCK_MEAN_SPAWN_INTERVAL_SECONDS,
  MAX_BIRDS_ALOFT,
  MAX_CONCURRENT_FLOCKS,
  type FlockWorld,
  advanceFlocks,
  birdStates,
  livingBirds,
  livingFlocks,
  spawnFlock,
} from '../server/flocks.ts';
import {
  SCHOOL_ALIGNMENT_RADIANS_PER_SECOND,
  SCHOOL_COMFORT_RADIUS_CELLS,
  SCHOOL_FULL_PULL_RADIUS_CELLS,
  SCHOOL_MAX_PULL_RADIANS_PER_SECOND,
  cohesionPullRadiansPerSecond,
  personalSpaceCellsOf,
  schoolLoosenessOf,
  normalizeAngle,
  steerWithSchool,
  summarizeSchools,
} from '../server/movement.ts';
import { loadPopulation } from '../server/persistence.ts';
import {
  SPAWN_MEAN_WAIT_SECONDS,
  livingEntities,
  type WildlifeEntity,
} from '../server/population.ts';
import {
  DEEP_WATER_MAX_HEIGHT,
  SCHOOL_LOOSENESS_BY_SIZE,
  habitatOf,
  profileOf,
} from '../server/species.ts';
import { worldWithTerrain } from './support/world.ts';

const WORLD_SIZE = cellsAcross(256);

const TICK_DT = 0.1;

const TICKS_PER_SIMULATED_SECOND = 1 / TICK_DT;

function ticksFor(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SIMULATED_SECOND);
}

const SETTLE_TIME_CONSTANTS = 6;
const SETTLE_SECONDS = SPAWN_MEAN_WAIT_SECONDS * SETTLE_TIME_CONSTANTS;

const RAMP_SLOPE_PER_CELL = LAND_WALKER_MAX_GRADIENT_PER_CELL;
const SHORELINE_ROW = 200;
function rampHeight(_x: number, y: number): number {
  return (y - SHORELINE_ROW) * RAMP_SLOPE_PER_CELL;
}

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

function bootOn(world: World): Harness {
  resetWildlifeState();

  const sink = new RecordingSink();
  world.setSink(sink);

  const host = new PluginHost(world, [wildlifePlugin].map(asLoadedPlugin));
  host.worldCreate();
  world.addPlayer(PLAYER);
  grantTokenEveryUnlockedChunk(world, PLAYER.token);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

function boot(): Harness {
  return bootOn(worldWithTerrain(WORLD_SIZE, rampHeight, isChunkLocked));
}

function tick(harness: Harness, times: number): void {
  for (let n = 0; n < times; n++) harness.host.tick(TICK_DT);
}

let settledSlices: Record<string, unknown>;

beforeAll(() => {
  const harness = boot();
  tick(harness, ticksFor(SETTLE_SECONDS));
  expect(livingEntities().length).toBeGreaterThan(0);
  settledSlices = harness.host.collectPersistence();
});

function restoreSettled(harness: Harness): void {
  harness.host.restorePersistence(settledSlices);
}

function persistedShapeOf(entity: WildlifeEntity) {
  const { id, species, schoolId, size, x, y, heading } = entity;
  return { id, species, schoolId, size, x, y, heading };
}

function expectRestoredAtRest(): void {
  for (const entity of livingEntities()) {
    expect(entity.fleeSecondsRemaining).toBe(0);
    expect(entity.idle).toBe(false);
  }
}

describe('habitat classification', () => {
  it('splits land, shallow and deep at sea level and the deep-water threshold, and agrees with shared about what counts as water', () => {
    expect(habitatOf(SEA_LEVEL + 1)).toBe('land');
    expect(habitatOf(BAND_HEIGHT)).toBe('land');
    expect(habitatOf(SEA_LEVEL)).toBe('shallow');
    expect(habitatOf(DEEP_WATER_MAX_HEIGHT + 1)).toBe('shallow');
    expect(habitatOf(DEEP_WATER_MAX_HEIGHT)).toBe('deep');
    expect(habitatOf(DEEP_WATER_MAX_HEIGHT - 1)).toBe('deep');

    for (let h = -1024; h <= 1024; h++) {
      const habitat = habitatOf(h);
      expect(['land', 'shallow', 'deep']).toContain(habitat);
      expect(habitat !== 'land').toBe(isWater(h));
    }
  });
});

describe('population targets', () => {
  it('scales each species with the area of ITS habitat', () => {
    const land = 200_000;
    const shallow = 100_000;
    const deep = 300_000;
    const targets = targetsFor({
      grazer: land, wolf: land, ibex: land, bison: land,
      fish: shallow, ray: shallow, shark: shallow, eel: shallow, angelfish: shallow,
      whale: deep, deepsea: deep,
    });
    expect(targets.grazer).toBe(Math.floor(land / profileOf('grazer').habitatCellsPerIndividual));
    expect(targets.fish).toBe(Math.floor(shallow / profileOf('fish').habitatCellsPerIndividual));
    expect(targets.deepsea).toBe(Math.floor(deep / profileOf('deepsea').habitatCellsPerIndividual));
    expect(targets.whale).toBe(Math.floor(deep / profileOf('whale').habitatCellsPerIndividual));
    expect(new Set(Object.values(targets)).size).toBe(WILDLIFE_HABITAT_SPECIES.length);
  });

  it('holds a full 512² world near, and never above, the cap', () => {
    const land = cellsOverArea(131072);
    const shallow = cellsOverArea(52429);
    const deep = cellsOverArea(78643);
    const targets = targetsFor({
      grazer: land, wolf: land, ibex: land, bison: land,
      fish: shallow, ray: shallow, shark: shallow, eel: shallow, angelfish: shallow,
      whale: deep, deepsea: deep,
    });
    const total = WILDLIFE_HABITAT_SPECIES.reduce((sum, s) => sum + targets[s], 0);
    expect(total).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);
    expect(targets).toEqual({
      fish: 51,
      whale: 15,
      deepsea: 20,
      grazer: 514,
      ibex: 73,
      bison: 85,
      ray: 16,
      shark: 7,
      eel: 13,
      angelfish: 25,
      wolf: 25,
    });
    expect(total).toBe(844);

    expect(total).toBeGreaterThan(WILDLIFE_POPULATION_CAP / 2);
    expect(targets.fish).toBeGreaterThan(targets.whale);
    expect(targets.whale).toBeGreaterThan(0);
    expect(targets.whale).toBeLessThan(targets.deepsea);
    expect(targets.whale).toBeGreaterThanOrEqual(3 * profileOf('whale').groupSize);
  });

});

describe('wildlife sync', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('broadcasts id, species, cell position and heading, rounded to two decimals, on every other tick', () => {
    restoreSettled(harness);
    harness.sink.clear();
    tick(harness, 20);
    expect(harness.sink.ofType('wildlife:entities')).toHaveLength(10);

    harness.sink.clear();
    tick(harness, 7);
    expect(harness.sink.ofType('wildlife:entities')).toHaveLength(3);

    harness.sink.clear();
    tick(harness, 2);
    const messages = harness.sink.ofType('wildlife:entities');
    expect(messages).toHaveLength(1);
    expect(messages[0].target).toBe(PLAYER.id);

    const payload = messages[0].payload as { entities: Array<Record<string, unknown>> };
    expect(payload.entities).toHaveLength(livingEntities().length + livingBirds().length);

    for (const entity of payload.entities) {
      expect(Object.keys(entity).sort()).toEqual([
        'climbHeight',
        'falling',
        'heading',
        'id',
        'size',
        'species',
        'stance',
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

  it('sends each connected player only the habitat population inside their own unlocked view', () => {
    restoreSettled(harness);
    expect(livingEntities().length).toBeGreaterThan(0);

    const outsider: Player = { id: 'session-2', token: 'token-2', name: 'Outsider' };
    harness.world.addPlayer(outsider);
    harness.host.playerJoined(outsider);

    harness.sink.clear();
    tick(harness, 2);

    const messages = harness.sink.ofType('wildlife:entities');
    const forPlayer = messages.find((m) => m.target === PLAYER.id);
    const forOutsider = messages.find((m) => m.target === outsider.id);
    expect(forPlayer).toBeDefined();
    expect(forOutsider).toBeDefined();

    const habitatOnly = (payload: unknown) =>
      (payload as { entities: Array<{ species: string }> }).entities.filter((entity) =>
        isWildlifeHabitatSpecies(entity.species),
      );

    expect(habitatOnly(forPlayer!.payload).length).toBe(livingEntities().length);
    expect(habitatOnly(forOutsider!.payload).length).toBe(0);
  });
});

describe('wildlife persistence', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('round-trips the population through a snapshot, schools included, and does not reuse ids afterwards', () => {
    restoreSettled(harness);
    const before = livingEntities().map(persistedShapeOf);
    expect(before.length).toBeGreaterThan(0);
    expect(new Set(before.map((entity) => entity.schoolId)).size).toBeLessThan(before.length);

    const slices = harness.host.collectPersistence();
    expect(Object.keys(slices)).toEqual(['wildlife']);

    const restored = boot();
    expect(livingEntities()).toHaveLength(0);
    restored.host.restorePersistence(slices);

    expect(livingEntities().map(persistedShapeOf)).toEqual(before);
    expectRestoredAtRest();

    const maxId = Math.max(...before.map((entity) => entity.id));
    tick(restored, ticksFor(SPAWN_MEAN_WAIT_SECONDS));

    const ids = livingEntities().map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBeGreaterThanOrEqual(maxId);
  });

  it('degrades to an empty population rather than throwing on a corrupt slice, and drops duplicate ids from a hand-edited one', () => {
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
    expect(livingEntities()).toHaveLength(1);

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

describe('the cohesion blend', () => {
  function fishAt(x: number, y: number, heading: number, size: WildlifeSizeClass): WildlifeEntity {
    return {
      ...newStillness(x, y),
      id: 1,
      species: 'fish',
      schoolId: 1,
      size,
      x,
      y,
      heading,
      fleeSecondsRemaining: 0,
      idle: false,
      huntTargetId: null,
      huntSecondsRemaining: 0,
      huntRestSecondsRemaining: 0,
      climb: null,
    };
  }

  it('applies no pull inside the comfort radius, ramps to the maximum at the full-pull radius, and saturates beyond it', () => {
    for (const looseness of Object.values(SCHOOL_LOOSENESS_BY_SIZE)) {
      expect(cohesionPullRadiansPerSecond(0, looseness)).toBe(0);
      expect(cohesionPullRadiansPerSecond(SCHOOL_COMFORT_RADIUS_CELLS * looseness, looseness)).toBe(
        0,
      );
    }

    const pullAtFull = cohesionPullRadiansPerSecond(SCHOOL_FULL_PULL_RADIUS_CELLS, 1);
    expect(pullAtFull).toBeCloseTo(SCHOOL_MAX_PULL_RADIANS_PER_SECOND, 10);
    expect(cohesionPullRadiansPerSecond(SCHOOL_FULL_PULL_RADIUS_CELLS * 10, 1)).toBe(pullAtFull);

    let previous = 0;
    for (let d = SCHOOL_COMFORT_RADIUS_CELLS; d <= SCHOOL_FULL_PULL_RADIUS_CELLS; d += 0.1) {
      const pull = cohesionPullRadiansPerSecond(d, 1);
      expect(pull).toBeGreaterThanOrEqual(previous);
      previous = pull;
    }
  });

  it('turns toward the rest of the school, never further than the rate allows', () => {
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
    expect(Math.abs(steered)).toBeLessThan(Math.abs(subject.heading));
  });

  it('leaves a lone member unsteered, and ignores the mean heading of a school that has just scattered', () => {
    const loner = fishAt(0, 0, 1.2, 'small');
    const lonerSchool = summarizeSchools([loner]).get(1)!;
    expect(steerWithSchool(loner, lonerSchool, SCHOOL_LOOSENESS_BY_SIZE.small, 1.2, TICK_DT)).toBe(
      1.2,
    );

    const subject = fishAt(0, 0, 0, 'small');
    const school = summarizeSchools([
      subject,
      fishAt(0, 0, 0, 'small'),
      fishAt(0, 0, Math.PI / 2, 'small'),
      fishAt(0, 0, Math.PI, 'small'),
      fishAt(0, 0, -Math.PI / 2, 'small'),
    ]).get(1)!;
    expect(
      steerWithSchool(subject, school, SCHOOL_LOOSENESS_BY_SIZE.small, 0.75, TICK_DT),
    ).toBe(0.75);
  });

  it('excludes the member itself from its own school centroid', () => {
    const subject = fishAt(0, 0, 0, 'small');
    const school = summarizeSchools([subject, fishAt(10, 0, 0, 'small')]).get(1)!;
    expect(
      steerWithSchool(subject, school, SCHOOL_LOOSENESS_BY_SIZE.small, Math.PI / 2, TICK_DT),
    ).toBeLessThan(Math.PI / 2);
  });
});

describe('fish size classes drive schooling', () => {

  it('restores a pre-schooling snapshot as independent wanderers, and refuses a bird someone wrote into it', () => {
    resetWildlifeState();
    loadPopulation({
      version: 1,
      nextId: 5,
      entities: [
        { id: 1, species: 'fish', x: 10, y: 10, heading: 0 },
        { id: 2, species: 'fish', x: 11, y: 10, heading: 0 },
        { id: 3, species: 'fish', x: 12, y: 10, heading: 0 },
        { id: 4, species: 'bird', x: 20, y: 20, heading: 0, schoolId: 2, size: 1 },
      ],
    });
    expect(livingEntities().map((entity) => entity.species)).toEqual(['fish', 'fish', 'fish']);

    const schools = livingEntities().map((entity) => entity.schoolId);
    expect(new Set(schools).size).toBe(schools.length);
    for (const entity of livingEntities()) expect(entity.size).toBe(DEFAULT_SIZE_CLASS);
  });
});

const FLOCK_WORLD: FlockWorld = { worldSize: WORLD_SIZE };

describe('bird flocks arrive, cross and leave', () => {
  beforeEach(() => {
    resetWildlifeState();
  });

  it('never has more than MAX_CONCURRENT_FLOCKS aloft, or MAX_BIRDS_ALOFT birds, which bounds the whole broadcast at the population cap plus the sky', () => {
    for (let n = 0; n < ticksFor(FLOCK_MEAN_SPAWN_INTERVAL_SECONDS * 20); n++) {
      advanceFlocks(FLOCK_WORLD, TICK_DT);
      expect(livingFlocks().length).toBeLessThanOrEqual(MAX_CONCURRENT_FLOCKS);
      expect(livingBirds().length).toBeLessThanOrEqual(MAX_BIRDS_ALOFT);
    }

    expect(MAX_BIRDS_ALOFT).toBe(MAX_CONCURRENT_FLOCKS * BIRDS_PER_FLOCK_MAX);
    expect(BROADCAST_ENTITY_CEILING).toBe(WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT);
  });
});

describe('birds are not habitat fauna', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = boot();
  });

  it('shares the entity-id space with the habitat population', () => {
    restoreSettled(harness);
    spawnFlock({ worldSize: harness.world.size });
    spawnFlock({ worldSize: harness.world.size });

    const ids = [...livingEntities().map((e) => e.id), ...livingBirds().map((b) => b.id)];
    expect(ids.length).toBeGreaterThan(BIRDS_PER_FLOCK_MIN);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is not persisted, and a restore clears the sky', () => {
    spawnFlock({ worldSize: harness.world.size });
    expect(birdStates().length).toBeGreaterThan(0);

    const slices = harness.host.collectPersistence();
    const slice = (slices.wildlife as { data: { entities: Array<{ species: string }> } }).data;
    expect(slice.entities.some((entity) => entity.species === 'bird')).toBe(false);

    harness.host.restorePersistence(slices);
    expect(livingBirds()).toHaveLength(0);
  });
});

describe('whale pods', () => {
  it('keeps school spacing clear of every schooling creature\'s own body', () => {
    for (const species of WILDLIFE_HABITAT_SPECIES) {
      if (profileOf(species).groupSize === 1) continue;
      for (const size of WILDLIFE_SIZE_CLASSES) {
        const entity = { species, size } as WildlifeEntity;
        const comfort = SCHOOL_COMFORT_RADIUS_CELLS * schoolLoosenessOf(entity);
        expect(comfort).toBeGreaterThan(personalSpaceCellsOf(entity) * 2);
      }
    }
  });

});
