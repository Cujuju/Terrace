import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { DEV_SEARCH_RADIUS_CELLS } from '../../../server/src/plugins/kit/devSite.ts';
import type { RotatingStormWorld } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import type { PluginActionOutcome, WorldApi } from '../../../server/src/plugins/types.ts';
import { MAX_ACTIVE_TORNADOES, TORNADO_FREQUENCY_SETTING_KEY } from '../protocol.ts';
import { plugin as tornadoPlugin } from '../server/index.ts';
import { loadTornadoes, saveTornadoes, TORNADO_SLICE_VERSION } from '../server/persistence.ts';
import { isLand, tornadoes, trySpawnTornado } from '../server/sim.ts';
import { loadWeatherBridge, resetWeatherBridge } from '../server/weather-bridge.ts';

const WORLD: RotatingStormWorld = { worldSize: 256, heightAt: () => 400 };

const WORLD_SIZE = 512;

const LAND_HEIGHT = SEA_LEVEL + BAND_HEIGHT;

const COAST_X = WORLD_SIZE / 2;

const STORM_CELL_RADIUS_CELLS = 40;

const SITE = { x: WORLD_SIZE - 64, y: WORLD_SIZE / 2 };

interface SkyCell {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

function hubWorld(
  heightAt: (x: number, y: number) => number,
  cells: readonly SkyCell[] = [],
): WorldApi {
  return {
    worldSize: WORLD_SIZE,
    difficulty: 0.5,
    heightAt,
    isCellUnlocked: () => true,
    setting: () => 'rare',
    sibling: () => ({ livingSystems: () => cells }),
    broadcastVisible: () => {},
    broadcast: () => {},
    emitEvent: () => {},
  } as unknown as WorldApi;
}

function coastHeight(x: number): number {
  return x < COAST_X ? SEA_LEVEL : LAND_HEIGHT;
}

function summon(world: WorldApi, site: { x: number; y: number }): PluginActionOutcome {
  return tornadoPlugin.onAction!(world, 'tornado', site);
}

beforeEach(() => {
  tornadoes.reset();
  resetWeatherBridge();
});

describe('the tornado slice', () => {
  it('restores the funnels and the generator through a JSON round trip', () => {
    const before = tornadoes.spawnAt(WORLD, 100, 120);
    before.envelope = 1;
    tornadoes.advance(WORLD, 0.1);

    const written = JSON.parse(JSON.stringify(saveTornadoes()));
    const expected = tornadoes.states();

    tornadoes.reset();
    expect(tornadoes.count()).toBe(0);

    loadTornadoes(written);

    expect(tornadoes.states()).toEqual(expected);
    expect(tornadoes.spawnAt(WORLD, 10, 10).id).toBe(before.id + 1);
  });

  it('leaves an empty sky when the slice is unreadable, rather than the old one', () => {
    tornadoes.spawnAt(WORLD, 100, 120);
    loadTornadoes({ nextStormId: 'no' });
    expect(tornadoes.count()).toBe(0);
  });

  it('is version 1 — the only version there has been', () => {
    expect(TORNADO_SLICE_VERSION).toBe(1);
  });
});

describe('where a tornado forms', () => {
  it('forms only under a thunderstorm that is actually raging', () => {
    const cell = { kind: 'thunderstorm', x: SITE.x, y: SITE.y, radius: STORM_CELL_RADIUS_CELLS };
    loadWeatherBridge(hubWorld(coastHeight, [{ ...cell, intensity: 0 }]));
    expect(trySpawnTornado(hubWorld(coastHeight))).toBeNull();

    loadWeatherBridge(hubWorld(coastHeight, [{ ...cell, intensity: 0.4 }]));
    expect(trySpawnTornado(hubWorld(coastHeight))).not.toBeNull();
  });

  it('ignores a sky system that is not a thunderstorm', () => {
    loadWeatherBridge(
      hubWorld(coastHeight, [
        { kind: 'rain', x: SITE.x, y: SITE.y, radius: STORM_CELL_RADIUS_CELLS, intensity: 1 },
      ]),
    );
    expect(trySpawnTornado(hubWorld(coastHeight))).toBeNull();
  });

  it('touches down on land, never on the water under the same cell', () => {
    const world = hubWorld(coastHeight, [
      { kind: 'thunderstorm', x: SITE.x, y: SITE.y, radius: STORM_CELL_RADIUS_CELLS, intensity: 1 },
    ]);
    loadWeatherBridge(world);
    const born = trySpawnTornado(world);
    expect(born).not.toBeNull();
    expect(isLand(world, Math.round(born!.x), Math.round(born!.y))).toBe(true);
  });

  it('forms nowhere when the cell stands entirely over water', () => {
    const allWater = (): number => SEA_LEVEL;
    const world = hubWorld(allWater, [
      { kind: 'thunderstorm', x: 100, y: 100, radius: STORM_CELL_RADIUS_CELLS, intensity: 1 },
    ]);
    loadWeatherBridge(world);
    expect(trySpawnTornado(world)).toBeNull();
  });
});

describe('the roster across world creates', () => {
  it('starts empty when a create restored no slice', () => {
    const world = hubWorld(coastHeight);
    tornadoPlugin.onWorldCreate!(world);
    tornadoes.spawnAt(world, SITE.x, SITE.y);

    tornadoPlugin.onWorldCreate!(world);

    expect(tornadoes.count()).toBe(0);
  });

  it('keeps the roster a create DID restore, slice first as the host runs it', () => {
    const world = hubWorld(coastHeight);
    tornadoPlugin.onWorldCreate!(world);
    tornadoes.spawnAt(world, SITE.x, SITE.y);
    const saved = JSON.parse(JSON.stringify(saveTornadoes()));

    tornadoPlugin.persistence!.load(saved, TORNADO_SLICE_VERSION);
    tornadoPlugin.onWorldCreate!(world);

    expect(tornadoes.count()).toBe(1);
  });
});

describe('summoning a tornado', () => {
  it('names the env that parked the sky', () => {
    const world = hubWorld(coastHeight);
    tornadoPlugin.onWorldCreate!(world);
    tornadoes.freeze(true);
    expect(summon(world, SITE).detail).toContain('TORNADO_DEV_FORCE');
  });

  it('refuses a site that is not a place in this world', () => {
    const world = hubWorld(coastHeight);
    tornadoPlugin.onWorldCreate!(world);
    expect(summon(world, { x: Number.NaN, y: SITE.y })).toEqual({
      ok: false,
      detail: 'that is not a place in this world',
    });
  });

  it('refuses once the sky already holds its ceiling', () => {
    const world = hubWorld(coastHeight);
    tornadoPlugin.onWorldCreate!(world);
    for (let summoned = 0; summoned < MAX_ACTIVE_TORNADOES; summoned++) {
      expect(summon(world, SITE).ok).toBe(true);
    }
    expect(summon(world, SITE)).toEqual({
      ok: false,
      detail: `${MAX_ACTIVE_TORNADOES} tornadoes are already in the air`,
    });
  });

  it('refuses when there is no land within reach of where you looked', () => {
    const world = hubWorld(() => SEA_LEVEL);
    tornadoPlugin.onWorldCreate!(world);
    expect(summon(world, SITE)).toEqual({
      ok: false,
      detail: `no land within ${DEV_SEARCH_RADIUS_CELLS} cells of (${SITE.x}, ${SITE.y})`,
    });
  });

  it('refuses while tornadoes are off for this world', () => {
    const world = {
      ...hubWorld(coastHeight),
      setting: (key: string) => (key === TORNADO_FREQUENCY_SETTING_KEY ? 'off' : undefined),
    } as unknown as WorldApi;
    tornadoPlugin.onWorldCreate!(world);
    expect(summon(world, SITE).ok).toBe(false);
  });
});
