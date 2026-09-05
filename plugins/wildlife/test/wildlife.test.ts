// The wildlife plugin's CONTRACTS, driven through the REAL plugin host — no
// stub: habitat classification, the population-target formula and cap, the
// broadcast cadence and wire shape, per-player fog filtering, the persistence
// slice (round-trip, corruption, compatibility), the pure cohesion-blend
// functions, and the sky's caps. Behavioural whole-world simulations were
// removed on 2026-09-02 (owner: contract-level tests only); rendering and
// behaviour are verified by eye per the design record.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  SEA_LEVEL,
  cellsAcross,
  cellsOverArea,
  isWater,
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

/**
 * 256 WORLD UNITS square, in cells — big enough that all four habitats are
 * populated.
 *
 * STATED AS LAND (2026-08-21). A bare 256 was 256 world units only while a cell
 * was one; afterwards it is 64 world units, which is SMALLER than the 80-unit
 * starter square, so the whole world unlocks at once and genesis has no room to
 * lay a shelf, a slope ring and open sea inside it. Every habitat count and
 * population target in this file is a fact about that geometry.
 */
const WORLD_SIZE = cellsAcross(256);

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
 * A north-to-south ramp: abyss at y=0, shoreline at y=200, hills below that.
 *
 * SLOPE IS THE LAND WALKER'S OWN LIMIT, taken from the constant rather than
 * typed out, so the ramp is by construction the steepest world a grazer can
 * still walk on — and a sculpt anywhere in it produces a small local diff
 * instead of a map-wide relaxation cascade.
 *
 * IT USED TO BE THE LITERAL 8, described here as "a quarter of MAX_STEP". That
 * was true when MAX_STEP was 32; the 2026-08-21 re-sample re-derived MAX_STEP
 * as BAND_HEIGHT / WORLD_UNIT_CELLS = 4, which left this fixture modelling a
 * world twice as steep as any legal terrain and four times as steep as any land
 * animal can cross. Every grazer this suite spawned was therefore frozen where
 * it stood — the exact defect the 2026-08-24 flatness rule was written to stop
 * — and no assertion could see it, because a stuck creature is still a living
 * creature. Derived from the walker's limit, the fixture cannot drift again.
 */
const RAMP_SLOPE_PER_CELL = LAND_WALKER_MAX_GRADIENT_PER_CELL;
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

function tick(harness: Harness, times: number): void {
  for (let n = 0; n < times; n++) harness.host.tick(TICK_DT);
}

/**
 * ONE SETTLED POPULATION PER FILE (2026-09-03). Filling a world takes
 * SETTLE_SECONDS of simulated time with every creature steering — about eight
 * seconds of wall clock on the ramp world, and five tests used to pay it each.
 * It is paid once here and captured as the plugin's own persistence slice;
 * every test that needs a populated world restores it through the real host
 * path instead. A restored population is calm and in motion (see
 * expectRestoredAtRest), which is exactly the state a live server boots into.
 */
let settledSlices: Record<string, unknown>;

beforeAll(() => {
  const harness = boot();
  tick(harness, ticksFor(SETTLE_SECONDS));
  expect(livingEntities().length).toBeGreaterThan(0);
  settledSlices = harness.host.collectPersistence();
});

/** Installs the settled population into a freshly booted harness. */
function restoreSettled(harness: Harness): void {
  harness.host.restorePersistence(settledSlices);
}

/**
 * The fields a snapshot actually carries (server/persistence.ts's
 * PersistedEntity). `fleeSecondsRemaining` and `idle` are deliberately NOT
 * among them — a panic and an idle bout are moments, not facts about the
 * animal, and a restored world starts calm and in motion.
 *
 * The round-trip assertions used to compare the WHOLE live entity, which
 * happened to pass only because nothing in those fixtures was ever fleeing or
 * idling at snapshot time. Both became false on 2026-09-02: the shark startles
 * its prey every tick it is near them, and three species take idle bouts. The
 * assertion that matters — every persisted field survives — is stated directly
 * now, with the transient fields asserted to come back at rest beside it.
 */
function persistedShapeOf(entity: WildlifeEntity) {
  const { id, species, schoolId, size, x, y, heading } = entity;
  return { id, species, schoolId, size, x, y, heading };
}

/** Every restored creature is calm and moving, whatever it was doing before. */
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
    // AREAS BIG ENOUGH THAT THE DENSITY IS WHAT BINDS (2026-08-23). These were
    // 8 000 / 3 000 / 12 000 cells, every one of which is less than a single
    // individual's share, so each expectation was `Math.floor(…)` of something
    // under one — i.e. this test asserted four zeroes and would have passed
    // against a density table of any shape at all. It now uses areas where each
    // species genuinely earns a different count, which is the property its name
    // claims. The founding floor has its own test below.
    const land = 200_000;
    const shallow = 100_000;
    const deep = 300_000;
    const targets = targetsFor({ land, shallow, deep });
    expect(targets.grazer).toBe(Math.floor(land / profileOf('grazer').habitatCellsPerIndividual));
    expect(targets.fish).toBe(Math.floor(shallow / profileOf('fish').habitatCellsPerIndividual));
    expect(targets.deepsea).toBe(Math.floor(deep / profileOf('deepsea').habitatCellsPerIndividual));
    expect(targets.whale).toBe(Math.floor(deep / profileOf('whale').habitatCellsPerIndividual));
    // Each is a different number, so a table that collapsed them would fail.
    expect(new Set(Object.values(targets)).size).toBe(WILDLIFE_HABITAT_SPECIES.length);
  });




  it('holds a full 512² world near, and never above, the cap', () => {
    // Nominal half-land / half-water 512², water split 40/60 shallow/deep.
    //
    // THE THREE AREAS ARE SQUARE WORLD UNITS, CONVERTED (2026-08-21). They were
    // written as cell counts of a 512-cell world, which was 512 world units of
    // land; the densities they are divided by are themselves cellsOverArea, so
    // converting both sides leaves the whole table below unchanged — which is
    // the point, because none of this ecosystem is about sampling density.
    const targets = targetsFor({
      land: cellsOverArea(131072),
      shallow: cellsOverArea(52429),
      deep: cellsOverArea(78643),
    });
    const total = WILDLIFE_HABITAT_SPECIES.reduce((sum, s) => sum + targets[s], 0);
    expect(total).toBeLessThanOrEqual(WILDLIFE_POPULATION_CAP);
    // RESTATED FOR THE FOUR SPECIES ADDED 2026-09-02, THE TWO SHELF SPECIES
    // ADDED 2026-09-03 (eel, angelfish) AND THE WOLF ADDED 2026-09-04. The
    // demand this nominal world makes went 1 532 → 2 000 → 2 099 → 2 164 —
    //
    //   fish  131   whale  39   deepsea 52   grazer 1 310   eel       34
    //   ibex  187   bison 218   ray     43   shark     20   angelfish 65
    //   wolf   65
    //
    // — and WILDLIFE_POPULATION_CAP (850, unchanged: it is a bandwidth budget)
    // scales every species by 850/2 164 ≈ 0.393 and floors, giving 844.
    //
    // THE WOLF IS THE CHEAPEST SPECIES YET ADDED, and deliberately so: at 2 000
    // square world units each (server/species/wolf.ts) it asks for 65 against
    // the grazer's 1 310, so a predator's silhouette costs the rest of the
    // ecosystem about 3%.
    //
    // WHAT IT COSTS, STATED RATHER THAN DISCOVERED. The sea thins again: fish
    // 72 → 55 → 53 → 51, deepsea 28 → 22 → 21 → 20, whale 21 → 16 → 15 → 15.
    // That is the honest price of more species under a fixed cap, it falls on
    // every species proportionally (nothing is distorted, the ecosystem is
    // smaller), and it only binds on a world of this shape — a fully revealed,
    // half-land 512² world, which no world on this machine is. Every world that
    // exists is far below the cap. Asserted exactly, because this table is the
    // arithmetic the species.ts header claims and a silent drift in it is how
    // that header becomes a lie.
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
    // Whales stay the rarest species even after their density halved — the
    // constraint that stopped the drop going further (see the whale entry in
    // species.ts). A fully revealed world must still hold several whole pods.
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

    // The shape, read from the message that reflects the population as it
    // stands now.
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


  // ──────────────────────────────────────────────────────────────────────────
  // FOG OF WAR (issue #18): the migrated-plugin proof. `harness`'s PLAYER has
  // the whole unlocked world granted to their own token (see bootOn); a
  // second player who has earned nothing of their own must be sent none of
  // the habitat population, through the REAL plugin path (WorldApi.
  // broadcastVisible), not a stub.
  // ──────────────────────────────────────────────────────────────────────────
  it('sends each connected player only the habitat population inside their own unlocked view', () => {
    restoreSettled(harness);
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

  it('round-trips the population through a snapshot, schools included, and does not reuse ids afterwards', () => {
    restoreSettled(harness);
    const before = livingEntities().map(persistedShapeOf);
    expect(before.length).toBeGreaterThan(0);
    // Schools are in the slice: membership cannot be recovered from position,
    // so a dropped schoolId would restore every school as permanent singletons
    // and undo the whole schooling behaviour on restart.
    expect(new Set(before.map((entity) => entity.schoolId)).size).toBeLessThan(before.length);

    const slices = harness.host.collectPersistence();
    expect(Object.keys(slices)).toEqual(['wildlife']);

    // A fresh boot that restores the slice.
    const restored = boot();
    expect(livingEntities()).toHaveLength(0);
    restored.host.restorePersistence(slices);

    expect(livingEntities().map(persistedShapeOf)).toEqual(before);
    expectRestoredAtRest();

    // One mean spawn wait: long enough for a post-restore birth to be expected.
    const maxId = Math.max(...before.map((entity) => entity.id));
    tick(restored, ticksFor(SPAWN_MEAN_WAIT_SECONDS));

    const ids = livingEntities().map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Anything spawned after the restore continues past the persisted high-water
    // mark rather than colliding with it.
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
    // The last case is the one valid entity in the list.
    expect(livingEntities()).toHaveLength(1);

    // A duplicated id keeps the first row only.
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

describe('the cohesion blend', () => {
  /** A fish with an explicit pose, for steering arithmetic. */
  function fishAt(x: number, y: number, heading: number, size: WildlifeSizeClass): WildlifeEntity {
    return {
      id: 1,
      species: 'fish',
      schoolId: 1,
      size,
      x,
      y,
      heading,
      fleeSecondsRemaining: 0,
      idle: false,
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

    // Monotonic across the ramp — no step, no plateau in the middle.
    let previous = 0;
    for (let d = SCHOOL_COMFORT_RADIUS_CELLS; d <= SCHOOL_FULL_PULL_RADIUS_CELLS; d += 0.1) {
      const pull = cohesionPullRadiansPerSecond(d, 1);
      expect(pull).toBeGreaterThanOrEqual(previous);
      previous = pull;
    }
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

  it('leaves a lone member unsteered, and ignores the mean heading of a school that has just scattered', () => {
    const loner = fishAt(0, 0, 1.2, 'small');
    const lonerSchool = summarizeSchools([loner]).get(1)!;
    expect(steerWithSchool(loner, lonerSchool, SCHOOL_LOOSENESS_BY_SIZE.small, 1.2, TICK_DT)).toBe(
      1.2,
    );

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
});



describe('fish size classes drive schooling', () => {
  // A school's survival across a snapshot is asserted by the persistence
  // round-trip above, on the settled population.

  it('restores a pre-schooling snapshot as independent wanderers, and refuses a bird someone wrote into it', () => {
    // Old slices carry no schoolId. The honest reading is "creatures whose
    // schools we no longer know" — one school each — not one giant school.
    resetWildlifeState();
    loadPopulation({
      version: 1,
      nextId: 5,
      entities: [
        { id: 1, species: 'fish', x: 10, y: 10, heading: 0 },
        { id: 2, species: 'fish', x: 11, y: 10, heading: 0 },
        { id: 3, species: 'fish', x: 12, y: 10, heading: 0 },
        // A bird in a slice is a hand-edited or forward-versioned file.
        // Restoring it as a habitat creature would produce something with no
        // habitat, which the sweep would then delete anyway — dropping the row
        // is the honest read.
        { id: 4, species: 'bird', x: 20, y: 20, heading: 0, schoolId: 2, size: 1 },
      ],
    });
    expect(livingEntities().map((entity) => entity.species)).toEqual(['fish', 'fish', 'fish']);

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

describe('bird flocks arrive, cross and leave', () => {
  beforeEach(() => {
    resetWildlifeState();
  });

  it('never has more than MAX_CONCURRENT_FLOCKS aloft, or MAX_BIRDS_ALOFT birds, which bounds the whole broadcast at the population cap plus the sky', () => {
    // Long enough that the arrival hazard fires many times over.
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
    // One allocator, so no bird can inherit a fish's interpolation on the client.
    expect(new Set(ids).size).toBe(ids.length);
  });


  it('is not persisted, and a restore clears the sky', () => {
    spawnFlock({ worldSize: harness.world.size });
    expect(birdStates().length).toBeGreaterThan(0);

    const slices = harness.host.collectPersistence();
    // Through the host's slice envelope (`{ v, data }`, server
    // plugins/slice-envelope.ts): the stored value is the envelope now, and
    // this plugin's own shape is inside it.
    const slice = (slices.wildlife as { data: { entities: Array<{ species: string }> } }).data;
    // A crossing is not world state: nothing about it survives the snapshot.
    expect(slice.entities.some((entity) => entity.species === 'bird')).toBe(false);

    harness.host.restorePersistence(slices);
    // …and a restore resets the shared id counter, so the sky has to be cleared
    // with it or an airborne bird would hold an id about to be reissued.
    expect(livingBirds()).toHaveLength(0);
  });
});



// ─────────────────────────────────────────────────────────────────────────────
// WHALE PODS (2026-08-21). Owner: "add the ability to spawn different size
// whales and allow them to school like whales in real life with different
// sizes". Three separable claims — whales come in sizes, whales group, and a
// group is MIXED rather than graded — plus the spacing contract that had to
// move before the largest animal in the game could school at all.
// ─────────────────────────────────────────────────────────────────────────────

describe('whale pods', () => {
  it('keeps school spacing clear of every schooling creature\'s own body', () => {
    // THE CONTRACT that whale pods made load-bearing: cohesion pulls inward only
    // outside the comfort radius, separation pushes outward inside a body
    // length, and the two must never meet. Fish satisfied it by luck of scale —
    // a 0.42-cell body against a 2.5-cell radius — and a five-unit whale on the
    // same fixed radius would have been the first creature to sit inside its own
    // comfort distance, with cohesion and separation fighting over it.
    for (const species of WILDLIFE_HABITAT_SPECIES) {
      if (profileOf(species).groupSize === 1) continue;
      for (const size of WILDLIFE_SIZE_CLASSES) {
        const entity = { species, size } as WildlifeEntity;
        const comfort = SCHOOL_COMFORT_RADIUS_CELLS * schoolLoosenessOf(entity);
        // Two matched creatures hold two half-lengths — one body length — apart.
        expect(comfort).toBeGreaterThan(personalSpaceCellsOf(entity) * 2);
      }
    }
  });


});
