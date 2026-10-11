import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL, cellsAcross, createSeededRng } from '@terrace/shared';
import { worldWithTerrain } from '../../../server/test/support/world.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  MAX_STRIKES_PER_MESSAGE,
  STRIKE_NO_SYSTEM,
  THUNDERSTORM_PLUGIN_NAME,
  THUNDERSTORM_STRIKES_MESSAGE,
  THUNDERSTORM_SYSTEMS_MESSAGE,
  parseStrikesPayload,
  type ThunderstormStrike,
} from '../protocol.ts';
import {
  chooseDryStrikeCell,
  exposureAt,
  rollStrikes,
  type StrikeSource,
  type StrikeWorld,
} from '../server/lightning.ts';
import {
  plugin as thunderstormPlugin,
  resetThunderstormState,
  systemStates,
} from '../server/index.ts';
import { resetWeatherBridge } from '../server/weather-bridge.ts';
import { setThunderstormRandomSource } from '../server/rng.ts';

const WORLD_SIZE = cellsAcross(128);

const TICK_SECONDS = 0.5;

const SUMMON_SITE = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };

const SITING_WORLD_SIZE = cellsAcross(512);

const SITING_SEED = 20260927;

const openWorld: StrikeWorld = {
  worldSize: 64,
  heightAt: () => 100,
  isCellUnlocked: () => true,
};

function storm(id: number, overrides: Partial<StrikeSource> = {}): StrikeSource {
  return { id, x: 32, y: 32, radius: 20, peakIntensity: 1, envelope: 1, ...overrides };
}

interface Recorder {
  readonly api: WorldApi;
  readonly broadcasts: { readonly type: string; readonly payload: unknown }[];
  readonly events: { readonly type: string; readonly payload: unknown }[];
}

function recordingWorld(sibling: Record<string, unknown> | null): Recorder {
  const broadcasts: { type: string; payload: unknown }[] = [];
  const events: { type: string; payload: unknown }[] = [];
  const api = {
    worldSize: WORLD_SIZE,
    heightAt: () => SEA_LEVEL + BAND_HEIGHT,
    isCellUnlocked: () => true,
    sibling: () => sibling,
    broadcast: (type: string, payload: unknown) => {
      broadcasts.push({ type, payload });
    },
    broadcastVisible: <T,>(
      type: string,
      items: readonly T[],
      _positionOf: (item: T) => { x: number; y: number },
      buildPayload: (visible: readonly T[]) => unknown,
    ) => {
      broadcasts.push({ type, payload: buildPayload(items) });
    },
    emitEvent: (type: string, payload: unknown) => {
      events.push({ type, payload });
    },
  } as unknown as WorldApi;
  return { api, broadcasts, events };
}

function fakeHub(): {
  module: Record<string, unknown>;
  entries: Record<string, unknown>[];
  unregistered: number;
} {
  const entries: Record<string, unknown>[] = [];
  const state = { unregistered: 0 };
  const module = {
    currentWind: () => ({ heading: 0, speed: 0 }),
    registerSkyKind: (entry: Record<string, unknown>) => {
      entries.push(entry);
      return () => {
        state.unregistered++;
      };
    },
  };
  return {
    module,
    entries,
    get unregistered(): number {
      return state.unregistered;
    },
  };
}

function strikesFrom(payload: unknown): readonly ThunderstormStrike[] {
  return parseStrikesPayload(payload) ?? [];
}

beforeEach(() => {
  setThunderstormRandomSource(createSeededRng(20260915).next);
  resetThunderstormState();
  resetWeatherBridge();
});

describe('thunderstorm as a plugin', () => {
  it('carries its own ceiling, and no persistence', () => {
    expect(thunderstormPlugin.name).toBe(THUNDERSTORM_PLUGIN_NAME);
    expect(MAX_ACTIVE_SYSTEMS).toBe(3);
    expect(thunderstormPlugin.persistence).toBeUndefined();
    expect(thunderstormPlugin.onIntent).toBeUndefined();
    expect(thunderstormPlugin.onTerrainChanged).toBeUndefined();
  });

  it('names its strike message so the host prefixes it thunderstorm:strikes', () => {
    expect(THUNDERSTORM_STRIKES_MESSAGE).toBe('strikes');
    expect(THUNDERSTORM_PLUGIN_NAME).toBe('thunderstorm');
  });

  it('never packs more strikes in a tick than one message can carry', () => {
    expect(MAX_ACTIVE_SYSTEMS + 1).toBeLessThanOrEqual(MAX_STRIKES_PER_MESSAGE);
  });
});

describe('thunderstorm without the weather hub', () => {
  it('ticks and strikes with no sibling at all', () => {
    const world = recordingWorld(null);
    thunderstormPlugin.onWorldCreate?.(world.api);
    expect(thunderstormPlugin.onAction?.(world.api, THUNDERSTORM_PLUGIN_NAME, SUMMON_SITE)?.ok)
      .toBe(true);

    let struck = 0;
    for (let tick = 0; tick < 20_000 && struck === 0; tick++) {
      thunderstormPlugin.onTick?.(world.api, TICK_SECONDS);
      struck = world.broadcasts
        .filter((sent) => sent.type === THUNDERSTORM_STRIKES_MESSAGE)
        .reduce((count, sent) => count + strikesFrom(sent.payload).length, 0);
    }

    expect(struck).toBeGreaterThan(0);
    expect(world.events.some((sent) => sent.type === THUNDERSTORM_STRIKES_MESSAGE)).toBe(true);
    thunderstormPlugin.onWorldClose?.(world.api);
  });
});

describe('thunderstorm and the hub', () => {
  it('unregisters on close, and a reopen leaves exactly one live entry', () => {
    const hub = fakeHub();
    const world = recordingWorld(hub.module);

    thunderstormPlugin.onWorldCreate?.(world.api);
    expect(hub.entries).toHaveLength(1);
    expect(hub.unregistered).toBe(0);

    thunderstormPlugin.onWorldClose?.(world.api);
    expect(hub.unregistered).toBe(1);

    thunderstormPlugin.onWorldCreate?.(world.api);
    expect(hub.entries).toHaveLength(2);
    expect(hub.entries.length - hub.unregistered).toBe(1);
    thunderstormPlugin.onWorldClose?.(world.api);
  });

  it('puts no strike on the wire from a system that is not alive that tick', () => {
    const hub = fakeHub();
    const world = recordingWorld(hub.module);
    thunderstormPlugin.onWorldCreate?.(world.api);
    thunderstormPlugin.onAction?.(world.api, THUNDERSTORM_PLUGIN_NAME, SUMMON_SITE);

    let seen = 0;
    for (let tick = 0; tick < 20_000; tick++) {
      const before = world.broadcasts.length;
      const alive = new Set(systemStates().map((system) => system.id));
      thunderstormPlugin.onTick?.(world.api, TICK_SECONDS);
      for (const sent of world.broadcasts.slice(before)) {
        if (sent.type !== THUNDERSTORM_STRIKES_MESSAGE) continue;
        for (const strike of strikesFrom(sent.payload)) {
          if (strike.systemId === STRIKE_NO_SYSTEM) continue;
          expect(alive.has(strike.systemId)).toBe(true);
          seen++;
        }
      }
      if (seen > 40) break;
    }
    expect(seen).toBeGreaterThan(0);
    thunderstormPlugin.onWorldClose?.(world.api);
  });

  it('broadcasts the system list on its own cadence', () => {
    const hub = fakeHub();
    const world = recordingWorld(hub.module);
    thunderstormPlugin.onWorldCreate?.(world.api);
    for (let tick = 0; tick < 100; tick++) thunderstormPlugin.onTick?.(world.api, TICK_SECONDS);
    expect(world.broadcasts.some((sent) => sent.type === THUNDERSTORM_SYSTEMS_MESSAGE)).toBe(true);
    thunderstormPlugin.onWorldClose?.(world.api);
  });
});

describe('where a bolt may land', () => {
  const REVEALED_COLUMNS = 4;
  const REVEALED_CELLS = REVEALED_COLUMNS * CHUNK_SIZE;

  function partlyRevealedWorld(): StrikeWorld {
    const world = worldWithTerrain(
      SITING_WORLD_SIZE,
      () => SEA_LEVEL + BAND_HEIGHT,
      (cx) => cx >= REVEALED_COLUMNS,
    );
    return {
      worldSize: world.size,
      heightAt: (x, y) => world.heightAt(x, y),
      isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
    };
  }

  it('lands in the world, inside the storm, and only on UNLOCKED ground', () => {
    const world = partlyRevealedWorld();
    const source = storm(1, { x: REVEALED_CELLS, y: REVEALED_CELLS, radius: REVEALED_CELLS });
    setThunderstormRandomSource(createSeededRng(SITING_SEED).next);

    let struck = 0;
    for (let tick = 0; tick < 200_000; tick++) {
      for (const strike of rollStrikes(world, [source], 0.5)) {
        struck++;
        expect(strike.x).toBeGreaterThanOrEqual(0);
        expect(strike.y).toBeGreaterThanOrEqual(0);
        expect(strike.x).toBeLessThan(world.worldSize);
        expect(strike.y).toBeLessThan(world.worldSize);
        expect(world.isCellUnlocked(strike.x, strike.y)).toBe(true);
        if (strike.systemId === STRIKE_NO_SYSTEM) continue;
        const dx = strike.x - source.x;
        const dy = strike.y - source.y;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThanOrEqual(source.radius + 1);
      }
      if (struck > 500) break;
    }
    expect(struck).toBeGreaterThan(0);
  });

  it('spends the roll rather than striking a world nobody has revealed', () => {
    const locked = worldWithTerrain(SITING_WORLD_SIZE, () => SEA_LEVEL + BAND_HEIGHT, () => true);
    const world: StrikeWorld = {
      worldSize: locked.size,
      heightAt: (x, y) => locked.heightAt(x, y),
      isCellUnlocked: (x, y) => locked.isCellUnlocked(x, y),
    };
    expect(chooseDryStrikeCell(world)).toBeNull();
    for (let tick = 0; tick < 2000; tick++) {
      expect(rollStrikes(world, [storm(1, { x: 100, y: 100, radius: 50 })], 1)).toEqual([]);
    }
  });

  it('refuses the sea for a dry bolt, and prefers the exposed cell on land', () => {
    const sea = worldWithTerrain(SITING_WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
    const seaWorld: StrikeWorld = {
      worldSize: sea.size,
      heightAt: (x, y) => sea.heightAt(x, y),
      isCellUnlocked: (x, y) => sea.isCellUnlocked(x, y),
    };
    expect(chooseDryStrikeCell(seaWorld)).toBeNull();

    const flat: StrikeWorld = { ...openWorld };
    const bump: StrikeWorld = {
      ...openWorld,
      heightAt: (x, y) => (x === 32 && y === 32 ? 200 : 100),
    };
    expect(exposureAt(bump, 32, 32)).toBeGreaterThan(exposureAt(flat, 32, 32));
  });
});
