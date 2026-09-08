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
  newStillness,
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

const WORLD_SIZE = cellsAcross(128);
const WORLD_CENTER = WORLD_SIZE / 2;

const TICK_DT = 0.1;

const BOWL_SLOPE_PER_CELL = 8 / WORLD_UNIT_CELLS;

function bowl(radius: number): (x: number, y: number) => number {
  return (x, y) => {
    const dx = x - WORLD_CENTER;
    const dy = y - WORLD_CENTER;
    return Math.round((Math.sqrt(dx * dx + dy * dy) - radius) * BOWL_SLOPE_PER_CELL);
  };
}

const MASSIF_CENTER = cellsAcross(24);

const ALPINE_PEAK_HEIGHT = (SNOW_LINE_BANDS_ABOVE_SEA + 2) * BAND_HEIGHT;
const ALPINE_PLATEAU_RADIUS = cellsAcross(14);

function alpine(seaRadius: number): (x: number, y: number) => number {
  const sea = bowl(seaRadius);
  return (x, y) => {
    const dx = x - MASSIF_CENTER;
    const dy = y - MASSIF_CENTER;
    if (Math.sqrt(dx * dx + dy * dy) <= ALPINE_PLATEAU_RADIUS) return ALPINE_PEAK_HEIGHT;
    return sea(x, y);
  };
}

const GREAT_BASIN_RADIUS = cellsAcross(50);
const TRENCH_RADIUS = cellsAcross(70);
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
  grantTokenEveryUnlockedChunk(world, PLAYER.token);
  host.playerJoined(PLAYER);

  return { world, host, sink };
}

function tick(harness: Harness, times: number): void {
  for (let n = 0; n < times; n++) harness.host.tick(TICK_DT);
}

function lairView(world: World): LairWorld {
  return {
    worldSize: world.size,
    heightAt: (x, y) => world.heightAt(x, y),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

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

function largestRegion(survey: LairSurvey): LairRegion | null {
  let best: LairRegion | null = null;
  for (const region of survey.regions) {
    if (best === null || region.cells > best.cells) best = region;
  }
  return best;
}

const ALWAYS = (): number => 0;
const NEVER = (): number => 1;

function livingMonster(): Monster | null {
  const alive = livingMonsters();
  if (alive.length > MAX_LIVING_MONSTERS_PER_KIND) {
    throw new Error(`expected at most one monster, found ${alive.length}`);
  }
  return alive[0] ?? null;
}

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
    expect({ x: region.x, y: region.y }).toEqual({ x: WORLD_CENTER, y: WORLD_CENTER });
    expect(region.extremeHeight).toBe(heightOf(WORLD_CENTER, WORLD_CENTER));
  });

  it('ignores locked territory entirely', () => {
    const heightOf = bowl(GREAT_BASIN_RADIUS);
    const lockedCX = WORLD_CENTER / CHUNK_SIZE;
    const lockedCY = WORLD_CENTER / CHUNK_SIZE;
    const inLockedChunk = (x: number, y: number): boolean =>
      Math.floor(x / CHUNK_SIZE) === lockedCX && Math.floor(y / CHUNK_SIZE) === lockedCY;

    const harness = boot(heightOf, (cx, cy) => cx === lockedCX && cy === lockedCY);
    const survey = surveyLairs(WATER_HABITAT, lairView(harness.world));

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

    tick(harness, 600);
    expect(livingMonsterCount()).toBe(MAX_LIVING_MONSTERS_PER_KIND);
    expect(livingMonster()!.id).toBe(id);
  });
});

interface BasinState {
  radius: number;
  floorHeight: number;
}

const NEUTRAL_GROUND_HEIGHT = BAND_HEIGHT;

function announcedTerrain<T extends object>(state: T): T {
  return new Proxy(state, {
    set(target, key, value, receiver) {
      releaseHabitatIndex();
      return Reflect.set(target, key, value, receiver);
    },
  });
}

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

interface MassifState {
  radius: number;
  peakHeight: number;
}

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

function yetiMassif(): MassifState {
  return announcedTerrain({
    radius: cellsAcross(14),
    peakHeight: SNOW_LINE_MIN_HEIGHT + 2 * BAND_HEIGHT,
  });
}

function cthulhuBasin(): BasinState {
  return announcedTerrain({ radius: cellsAcross(30), floorHeight: DEEP_WATER_MAX_HEIGHT - 30 });
}

const KRAKEN_TRENCH_RADIUS_CELLS = cellsAcross(40);

const KRAKEN_TRENCH_POCKET_RADIUS_CELLS = Math.ceil(
  3 * bodyRadiusCells(profileOf('kraken')),
);

const KRAKEN_TRENCH_DEPTH_MARGIN = (() => {
  const demandDepth = KRAKEN_LAIR_MIN_DEPTH_BANDS * BAND_HEIGHT;
  const rimDepth = DEEP_WATER_BANDS_BELOW_SEA * BAND_HEIGHT;
  const fraction = KRAKEN_TRENCH_POCKET_RADIUS_CELLS / KRAKEN_TRENCH_RADIUS_CELLS;
  const exact = (fraction * (demandDepth - rimDepth)) / (1 - fraction);
  return Math.ceil(exact / BAND_HEIGHT) * BAND_HEIGHT;
})();

function krakenTrench(): BasinState {
  return announcedTerrain({
    radius: KRAKEN_TRENCH_RADIUS_CELLS,
    floorHeight:
      SEA_LEVEL - (KRAKEN_LAIR_MIN_DEPTH_BANDS * BAND_HEIGHT + KRAKEN_TRENCH_DEPTH_MARGIN),
  });
}

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

    basin.radius = 0;
    expect(isLairCell(WATER_HABITAT, world, livingMonster()!.x, livingMonster()!.y)).toBe(false);

    expect(enforceHabitat(world)).toBe(false);
    for (let n = 0; n < LAIR_SURVEY_INTERVAL_SECONDS / TICK_DT + 1; n++) {
      advanceSummoning(world, TICK_DT);
      enforceHabitat(world);
    }

    expect(livingMonster()).not.toBeNull();
    expect(livingMonster()!.id).toBe(id);
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
  });
});

describe('summon cells are spread, not pinned to the deepest cell', () => {
  function summonAt(world: LairWorld, nextId: number): { x: number; y: number } {
    restoreSummoning([], nextId, {});
    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();
    return { x: kraken!.x, y: kraken!.y };
  }

  const PROBE_IDS = Array.from({ length: 3 }, (_, i) => i + 1);

  it('lands on many different cells across successive summons', () => {
    const world = basinWorld(krakenTrench());
    const seen = new Set(PROBE_IDS.map((id) => {
      const cell = summonAt(world, id);
      return `${cell.x},${cell.y}`;
    }));

    expect(seen.size).toBeGreaterThan(PROBE_IDS.length / 2);
  });
});

const PUDDLE_MAX_SHARE_OF_ARRIVAL_BAR = 1 / 4;

describe('the kraken is not evicted by terrain (owner ruling, 2026-08-19)', () => {
  it('stays when its region shrinks to a puddle around it', () => {
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();

    trench.radius = krakenPocketRadiusCells(trench) + 1;
    expect(Math.PI * trench.radius * trench.radius).toBeLessThan(
      KRAKEN_MIN_LAIR_DEEP_CELLS * PUDDLE_MAX_SHARE_OF_ARRIVAL_BAR,
    );
    expect(isLairCell(WATER_HABITAT, world, kraken!.x, kraken!.y)).toBe(true);

    for (let n = 0; n < (LAIR_SURVEY_INTERVAL_SECONDS * 3) / TICK_DT; n++) {
      advanceSummoning(world, TICK_DT);
      enforceHabitat(world);
    }
    expect(livingMonsterOfKind('kraken')).not.toBeNull();
    expect(livingMonsterOfKind('kraken')!.id).toBe(kraken!.id);
    expect(cooldownRemainingSecondsFor('kraken')).toBe(0);
  });

  it('submerges the moment its OWN cell stops being deep water — physics, not policy', () => {
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const kraken = livingMonsterOfKind('kraken');
    expect(kraken).not.toBeNull();

    trench.radius = 0;
    expect(isLairCell(WATER_HABITAT, world, kraken!.x, kraken!.y)).toBe(false);

    expect(enforceHabitat(world)).toBe(true);
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBe(KRAKEN_RESPAWN_COOLDOWN_SECONDS);
    expect(livingMonsterOfKind('cthulhu')).not.toBeNull();
  });

  it('refuses to summon again until the cooldown is served, then summons exactly one', () => {
    const trench = krakenTrench();
    const world = basinWorld(trench);

    setMonsterRandomSource(ALWAYS);
    advanceSummoning(world, TICK_DT);
    const firstId = livingMonsterOfKind('kraken')!.id;

    trench.radius = 0;
    expect(enforceHabitat(world)).toBe(true);
    expect(livingMonsterOfKind('kraken')).toBeNull();

    trench.radius = cellsAcross(40);
    for (let n = 0; n < (KRAKEN_RESPAWN_COOLDOWN_SECONDS - 2) / TICK_DT; n++) {
      advanceSummoning(world, TICK_DT);
    }
    expect(livingMonsterOfKind('kraken')).toBeNull();
    expect(cooldownRemainingSecondsFor('kraken')).toBeGreaterThan(0);

    for (let n = 0; n < 3 / TICK_DT; n++) advanceSummoning(world, TICK_DT);
    expect(livingCountOfKind('kraken')).toBe(1);
    expect(livingMonsterOfKind('kraken')!.id).toBeGreaterThan(firstId);
  });
});

describe('per-kind slots (2026-08-19 — was: the kinds contest one slot)', () => {
  it('a trench world comes to hold BOTH sea kinds at once — Cthulhu no longer blocks the kraken', () => {
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
    expect(countDeepCells(heightOf)).toBeGreaterThan(MIN_LAIR_DEEP_CELLS);
    expect(countDeepCells(heightOf)).toBeLessThan(KRAKEN_MIN_LAIR_DEEP_CELLS);
    expect(heightOf(WORLD_CENTER, WORLD_CENTER)).toBeGreaterThan(
      SEA_LEVEL - KRAKEN_LAIR_MIN_DEPTH_BANDS * BAND_HEIGHT,
    );

    setMonsterRandomSource(ALWAYS);
    const harness = boot(heightOf);
    tick(harness, 600);
    expect(livingMonster()!.kind).toBe('cthulhu');
  });
});

describe('kraken bar at the natural ocean floor (owner-decided 2026-08-19)', () => {

  it('summons a kraken into a natural-floor trench', () => {
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

  const GENESIS_PROBE_SEED = 2654435761 >>> 0;
  const GENESIS_PROBE_SIZE = cellsAcross(128);

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
      { version: 1, monster: { id: 0, kind: 'cthulhu', x: 1, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: { id: 1, kind: 'dagon', x: 1, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: { id: 1, kind: 'cthulhu', x: NaN, y: 1, heading: 0 }, nextId: 2 },
      { version: 1, monster: 'yes', nextId: 2 },
    ];

    for (const slice of corrupt) {
      resetMonstersState();
      loadMonsters(slice);
      expect(livingMonsters()).toEqual([]);
      for (const kind of MONSTER_KINDS) {
        expect(cooldownRemainingSecondsFor(kind)).toBe(0);
      }
    }
  });

  it('migrates a version-1 slice, and its cooldown is the KRAKEN\'s', () => {
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

  function withCthulhu(): Harness {
    setMonsterRandomSource(ALWAYS);
    const harness = boot();
    tick(harness, 1);
    expect(livingMonster()!.kind).toBe('cthulhu');
    setMonsterRandomSource(NEVER);
    harness.sink.clear();
    return harness;
  }

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

describe('issue #19 — Cthulhu’s veto costs zero mana', () => {
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
    setMonsterRandomSource(ALWAYS);
    const heightOf = alpine(GREAT_BASIN_RADIUS);
    expect(countSnowCells(heightOf)).toBeGreaterThan(YETI_MIN_LAIR_SNOW_CELLS);
    expect(countDeepCells(heightOf)).toBeGreaterThan(MIN_LAIR_DEEP_CELLS);

    const harness = boot(heightOf);
    tick(harness, 1);

    expect(seaMonster()!.kind).toBe('cthulhu');
    expect(snowMonster()!.kind).toBe('yeti');
    expect(livingMonsterCount()).toBe(2);

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

    snowMonster()!.x = MASSIF_CENTER + 0.5;
    snowMonster()!.y = MASSIF_CENTER + 0.5;

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

describe('body-aware habitat poses', () => {
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
    return { id: 1, kind: 'kraken', x, y, heading, idle: false, climb: null, ...newStillness(x, y) };
  }

  it('never lets a wide monster lay its body over the shore', () => {
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
  function openSea(): LairWorld {
    return {
      worldSize: WORLD_SIZE,
      heightAt: () => DEEP_WATER_MAX_HEIGHT,
      isCellUnlocked: () => true,
    };
  }

  const NO_NOISE = (): number => 0.5;

  const COMBINED_RADII_CELLS =
    bodyRadiusCells(profileOf('kraken')) + bodyRadiusCells(profileOf('cthulhu'));

  const COMBINED_STEP_CELLS =
    (profileOf('kraken').lurkSpeedCellsPerSecond + profileOf('cthulhu').lurkSpeedCellsPerSecond) *
    TICK_DT;

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
          heading: 0,
        },
        {
          id: 2,
          kind: 'cthulhu',
          x: WORLD_CENTER + START_SEPARATION_CELLS / 2,
          y: WORLD_CENTER,
          heading: Math.PI,
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
