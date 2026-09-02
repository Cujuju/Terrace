// Snow siting, the anti-cheat rule inside it, and the hand-off that replaces the
// pre-split fallback to rain (#285).
//
// These are the pre-split weather suite's `snow siting` block, moved to the kind
// that owns it — with the three "it rains instead" assertions rewritten against
// the mechanism that carries that behaviour now: a hand-off BY NAME through the
// hub, because snow and rain are separate, independently-deletable folders.

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

/** The nominal world — 512 WORLD UNITS square, in cells. */
const WORLD_SIZE = cellsAcross(512);

/** A world with no land at all — a fresh Terrace world's shape. */
function flatSeaWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
}

/**
 * A world that is entirely highland: every cell four bands up, so every
 * candidate centre is a legal snow site and siting never has to reject.
 */
function highlandWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL + 4 * BAND_HEIGHT);
}

/** The World as the plugin reads it: core calls the field `size`, the API `worldSize`. */
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
    // Every cell is alpine, but only the first chunk column is revealed and that
    // column is dug down to the seabed. A siting rule that read locked heights
    // would find snow everywhere; one that respects the mask finds it nowhere.
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
    // Fully locked world: the honest answer is "this plugin is not allowed to
    // know", which must fail the site rather than default to flat ground.
    const world = asSnowWorld(
      worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL + 8 * BAND_HEIGHT, () => true),
    );
    expect(meanUnlockedHeightUnder(world, 256, 256, 30)).toBeNull();
    expect(isSnowSite(world, 256, 256, 30)).toBe(false);
  });

  it('clamps sample coordinates into the world for an off-map centre', () => {
    // A system may legitimately be born entirely outside the map; a height
    // lookup there would read past the end of the Int16Array and return
    // undefined, which would poison the mean.
    const world = asSnowWorld(highlandWorld());
    const mean = meanUnlockedHeightUnder(world, -200, WORLD_SIZE + 200, 40);
    expect(mean).not.toBeNull();
    expect(Number.isFinite(mean!)).toBe(true);
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
    // The pre-split sim turned an unsited snow spawn into a rain system by
    // changing a kind field. Across the split the same weather still arrives:
    // this plugin asks the hub for the kind named 'rain' to birth one instead.
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

    // A hub resolved the way the real one is — by name, through the host's
    // sibling lookup, with no import in either direction.
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
    // Every attempt the engine allows itself was spent before it gave up…
    expect(attempts).toBe(DISC_SITING_ATTEMPTS * SNOW_ELEVATION_SAMPLES);
    // …and the roll went to rain, once, by name.
    expect(handedOffTo).toEqual([SNOW_HAND_OFF_KIND]);
  });

  it('loses the roll silently when no hub — or no rain — can take it', () => {
    // Degraded, and deliberately so: a world with no rain plugin should have
    // exactly this much less weather.
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
    // The whole point of the hand-off: this plugin must keep working with no
    // rain plugin installed at all.
    expect(SNOW_HAND_OFF_KIND).toBe('rain');
  });
});

describe('snow as a plugin', () => {
  it('offers no spawn hand-off of its own', () => {
    // A roll another kind could not site, passed back to snow, would fail siting
    // again for the same reason it failed the first time.
    expect(snowPlugin.name).toBe('snow');
    expect(snowPlugin.persistence).toBeUndefined();
    expect(snowPlugin.onIntent).toBeUndefined();
    expect(snowPlugin.onTerrainChanged).toBeUndefined();
  });
});
