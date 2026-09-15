import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL, cellsAcross, createSeededRng } from '@terrace/shared';
import { World } from '../../../server/src/world/world.ts';
import { worldWithTerrain } from '../../../server/test/support/world.ts';
import { DISC_SITING_ATTEMPTS } from '../../../server/src/plugins/kit/discSystems.ts';
import {
  SNOW_ELEVATION_SAMPLES,
  SNOW_MIN_TERRAIN_HEIGHT,
  isSnowSite,
  meanUnlockedHeightUnder,
  type SnowWorld,
} from '../server/siting.ts';
import {
  SNOW_HAND_OFF_KIND,
  plugin as snowPlugin,
  livingSystems,
  resetSnowState,
  setSnowWorld,
  snowSystems,
} from '../server/index.ts';
import { setSnowRandomSource } from '../server/rng.ts';
import {
  handOffSpawnTo,
  loadWeatherBridge,
  resetWeatherBridge,
} from '../server/weather-bridge.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';

const WORLD_SIZE = cellsAcross(512);

function flatSeaWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
}

function highlandWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL + 4 * BAND_HEIGHT);
}

function asSnowWorld(world: World): SnowWorld {
  return {
    worldSize: world.size,
    heightAt: (x, y) => world.heightAt(x, y),
    isCellUnlocked: (x, y) => world.isCellUnlocked(x, y),
  };
}

beforeEach(() => {
  setSnowRandomSource(createSeededRng(20260814).next);
  resetSnowState();
  resetWeatherBridge();
  setSnowWorld(null);
});

describe('snow siting', () => {
  it('samples five points and averages only UNLOCKED ground', () => {
    expect(SNOW_ELEVATION_SAMPLES).toBe(5);
    const world = asSnowWorld(highlandWorld());
    const mean = meanUnlockedHeightUnder(world, 256, 256, 30);
    expect(mean).toBe(SEA_LEVEL + 4 * BAND_HEIGHT);
    expect(mean).toBeGreaterThanOrEqual(SNOW_MIN_TERRAIN_HEIGHT);
  });

  it('refuses to site snow on a world with no land', () => {
    expect(isSnowSite(asSnowWorld(flatSeaWorld()), 256, 256, 30)).toBe(false);
  });

  it('IGNORES mountains in LOCKED chunks — no side channel on hidden terrain', () => {
    const revealedColumns = 1;
    const world = asSnowWorld(
      worldWithTerrain(
        WORLD_SIZE,
        (x) =>
          x < revealedColumns * CHUNK_SIZE ? SEA_LEVEL - BAND_HEIGHT : SEA_LEVEL + 8 * BAND_HEIGHT,
        (cx) => cx >= revealedColumns,
      ),
    );
    setSnowWorld(world);
    for (let n = 0; n < 400; n++) snowSystems.spawnOne(WORLD_SIZE);
    expect(livingSystems()).toHaveLength(0);
  });

  it('treats a candidate with no unlocked sample as unknown, not as sea level', () => {
    const world = asSnowWorld(
      worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL + 8 * BAND_HEIGHT, () => true),
    );
    expect(meanUnlockedHeightUnder(world, 256, 256, 30)).toBeNull();
    expect(isSnowSite(world, 256, 256, 30)).toBe(false);
  });

  it('judges an off-map centre by the samples that land in the world, or refuses', () => {
    const world = asSnowWorld(highlandWorld());
    expect(meanUnlockedHeightUnder(world, -10, 256, 40)).toBe(SEA_LEVEL + 4 * BAND_HEIGHT);
    expect(meanUnlockedHeightUnder(world, -200, WORLD_SIZE + 200, 40)).toBeNull();
  });

  it('sites at exactly the threshold and refuses one unit below it', () => {
    const at = asSnowWorld(worldWithTerrain(WORLD_SIZE, () => SNOW_MIN_TERRAIN_HEIGHT));
    const below = asSnowWorld(worldWithTerrain(WORLD_SIZE, () => SNOW_MIN_TERRAIN_HEIGHT - 1));
    expect(isSnowSite(at, 256, 256, 30)).toBe(true);
    expect(isSnowSite(below, 256, 256, 30)).toBe(false);
  });

  it('never spawns snow on a world with no land', () => {
    setSnowWorld(asSnowWorld(flatSeaWorld()));
    for (let n = 0; n < 400; n++) expect(snowSystems.spawnOne(WORLD_SIZE)).toBeNull();
    expect(livingSystems()).toHaveLength(0);
  });

  it('does spawn snow on highland', () => {
    setSnowWorld(asSnowWorld(highlandWorld()));
    expect(snowSystems.spawnOne(WORLD_SIZE)).not.toBeNull();
    expect(livingSystems()).toHaveLength(1);
  });
});

describe('the unsited roll (#285)', () => {
  it('hands the roll to the kind called rain, BY NAME, and only after trying', () => {
    let attempts = 0;
    const handedOffTo: string[] = [];
    setSnowWorld({
      worldSize: WORLD_SIZE,
      heightAt: () => {
        attempts++;
        return SEA_LEVEL - BAND_HEIGHT;
      },
      isCellUnlocked: () => true,
    });

    const fakeHub = {
      currentWind: () => ({ heading: 0, speed: 0 }),
      registerSkyKind: () => () => {},
      spawnSkyKind: (name: string) => {
        handedOffTo.push(name);
        return true;
      },
    };
    loadWeatherBridge({ sibling: () => fakeHub } as unknown as WorldApi);

    expect(snowSystems.spawnOne(WORLD_SIZE)).toBeNull();
    expect(livingSystems()).toHaveLength(0);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(DISC_SITING_ATTEMPTS * SNOW_ELEVATION_SAMPLES);
    expect(handedOffTo).toEqual([SNOW_HAND_OFF_KIND]);
  });

  it('loses the roll silently when no hub — or no rain — can take it', () => {
    setSnowWorld({
      worldSize: WORLD_SIZE,
      heightAt: () => SEA_LEVEL - BAND_HEIGHT,
      isCellUnlocked: () => true,
    });
    expect(handOffSpawnTo(SNOW_HAND_OFF_KIND)).toBe(false);
    expect(snowSystems.spawnOne(WORLD_SIZE)).toBeNull();
    expect(livingSystems()).toHaveLength(0);
  });

  it('names rain as a STRING, never as an import', () => {
    expect(SNOW_HAND_OFF_KIND).toBe('rain');
  });
});

describe('snow as a plugin', () => {
  it('offers no spawn hand-off of its own', () => {
    expect(snowPlugin.name).toBe('snow');
    expect(snowPlugin.persistence).toBeUndefined();
    expect(snowPlugin.onIntent).toBeUndefined();
    expect(snowPlugin.onTerrainChanged).toBeUndefined();
  });
});

describe('snow and the hub', () => {
  function fakeHub(): { module: Record<string, unknown>; entries: Record<string, unknown>[]; handOffs: string[] } {
    const entries: Record<string, unknown>[] = [];
    const handOffs: string[] = [];
    const module = {
      currentWind: () => ({ heading: 0, speed: 0 }),
      registerSkyKind: (entry: Record<string, unknown>) => {
        entries.push(entry);
        return () => undefined;
      },
      spawnSkyKind: (name: string) => {
        handOffs.push(name);
        return true;
      },
    };
    return { module, entries, handOffs };
  }

  function stubWorld(world: World, hub: Record<string, unknown>): WorldApi {
    return {
      worldSize: world.size,
      heightAt: (x: number, y: number) => world.heightAt(x, y),
      isCellUnlocked: (x: number, y: number) => world.isCellUnlocked(x, y),
      sibling: () => hub,
      broadcast: () => undefined,
    } as unknown as WorldApi;
  }

  it('registers no spawnOne: nothing can hand a spawn TO snow', () => {
    const hub = fakeHub();
    snowPlugin.onWorldCreate?.(stubWorld(flatSeaWorld(), hub.module));
    expect(hub.entries).toHaveLength(1);
    expect(hub.entries[0]!['spawnOne']).toBeUndefined();
    snowPlugin.onWorldClose?.(stubWorld(flatSeaWorld(), hub.module));
  });

  it('summoned snow ignores siting: it falls on the sea if asked', () => {
    const hub = fakeHub();
    const api = stubWorld(flatSeaWorld(), hub.module);
    snowPlugin.onWorldCreate?.(api);
    const outcome = snowPlugin.onAction?.(api, 'snow', { x: 10, y: 10 });
    expect(outcome?.ok).toBe(true);
    expect(livingSystems()).toHaveLength(1);
    snowPlugin.onWorldClose?.(api);
  });

  it('hands off only when it had a slot to give: a full sky rolls nothing', () => {
    const hub = fakeHub();
    const api = stubWorld(flatSeaWorld(), hub.module);
    snowPlugin.onWorldCreate?.(api);
    const smallWorld = cellsAcross(128);
    expect(snowSystems.spawnOne(smallWorld)).toBeNull();
    expect(hub.handOffs).toEqual([SNOW_HAND_OFF_KIND]);
    for (let n = 0; n < snowSystems.capFor(smallWorld); n++) {
      expect(snowSystems.spawnAt(smallWorld, 10, 10)).not.toBeNull();
    }
    expect(snowSystems.spawnOne(smallWorld)).toBeNull();
    expect(hub.handOffs).toHaveLength(1);
    snowPlugin.onWorldClose?.(api);
  });
});
