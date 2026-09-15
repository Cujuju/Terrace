import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, SEA_LEVEL, createSeededRng } from '@terrace/shared';
import { DEV_SEARCH_RADIUS_CELLS } from '../../../server/src/plugins/kit/devSite.ts';
import type { RotatingStormWorld } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import type { PluginActionOutcome, WorldApi } from '../../../server/src/plugins/types.ts';
import { CYCLONE_SURGE_SETTING_KEY, MAX_ACTIVE_CYCLONES } from '../protocol.ts';
import { plugin as cyclonePlugin } from '../server/index.ts';
import { CYCLONE_SLICE_VERSION, loadCyclones, saveCyclones } from '../server/persistence.ts';
import { cyclones, isCycloneSite, trySpawnCyclone } from '../server/sim.ts';
import { SURGE_INTERVAL_SECONDS, tickSurge } from '../server/surge.ts';
import { WIND_SCOUR_BRUSH_RADIUS_CELLS, scourStruckGround } from '../server/wind-scour.ts';

const WORLD: RotatingStormWorld = { worldSize: 256, heightAt: () => 0 };

const WORLD_SIZE = 512;

const LAND_HEIGHT = SEA_LEVEL + BAND_HEIGHT;

const SITE = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };

const SURGE_SEED = 20260915;

interface Sculpt {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly delta: number;
}

function seaWorld(
  heightAt: (x: number, y: number) => number,
  chunksUnlocked = true,
): { api: WorldApi; sculpts: Sculpt[] } {
  const sculpts: Sculpt[] = [];
  const api = {
    worldSize: WORLD_SIZE,
    difficulty: 0.5,
    heightAt,
    isCellUnlocked: () => chunksUnlocked,
    isChunkUnlocked: () => chunksUnlocked,
    setting: (key: string) => (key === CYCLONE_SURGE_SETTING_KEY ? 'on' : 'rare'),
    sibling: () => null,
    broadcastVisible: () => {},
    broadcast: () => {},
    emitEvent: () => {},
    sculpt: (x: number, y: number, radius: number, delta: number) => {
      sculpts.push({ x, y, radius, delta });
    },
  } as unknown as WorldApi;
  return { api, sculpts };
}

const openSea = (): number => SEA_LEVEL;

const continent = (): number => LAND_HEIGHT;

// Every land cell touches water, so a surge draw lands on a shoreline often.
const shoreEverywhere = (x: number, y: number): number =>
  (x + y) % 2 === 0 ? LAND_HEIGHT : SEA_LEVEL;

function summon(world: WorldApi, site: { x: number; y: number }): PluginActionOutcome {
  return cyclonePlugin.onAction!(world, 'cyclone', site);
}

beforeEach(() => {
  cyclones.reset();
});

describe('the cyclone slice', () => {
  it('restores the storm, its name and the roster counter through a JSON round trip', () => {
    const before = cyclones.spawnAt(WORLD, 100, 120);
    before.envelope = 1;
    cyclones.advance(WORLD, 0.1);
    expect(before.name).toBe('Hurricane Ada');

    const written = JSON.parse(JSON.stringify(saveCyclones()));
    const expected = cyclones.states();

    cyclones.reset();
    expect(cyclones.count()).toBe(0);

    loadCyclones(written);

    expect(cyclones.states()).toEqual(expected);
    expect(cyclones.storms()[0]?.name).toBe('Hurricane Ada');
    expect(cyclones.spawnAt(WORLD, 100, 120).name).toBe('Hurricane Bramble');
  });

  it('leaves an empty sky when the slice is unreadable, rather than the old one', () => {
    cyclones.spawnAt(WORLD, 100, 120);
    loadCyclones({ storms: 'not a list' });
    expect(cyclones.count()).toBe(0);
  });

  it('is version 1 — the only version there has been', () => {
    expect(CYCLONE_SLICE_VERSION).toBe(1);
  });
});

describe('where a cyclone forms', () => {
  it('forms over open water and nowhere else', () => {
    expect(trySpawnCyclone(seaWorld(openSea).api)).not.toBeNull();
    expect(trySpawnCyclone(seaWorld(continent).api)).toBeNull();
  });

  it('asks its own disc, not one cell: a puddle mid-continent is not open water', () => {
    const world = seaWorld((x, y) => (x === SITE.x && y === SITE.y ? SEA_LEVEL : LAND_HEIGHT)).api;
    expect(isCycloneSite(world, SITE.x, SITE.y)).toBe(false);
    expect(isCycloneSite(seaWorld(openSea).api, SITE.x, SITE.y)).toBe(true);
  });
});

describe('what a cyclone is allowed to cut', () => {
  it('scours nothing on ground no player has unlocked', () => {
    const locked = seaWorld(continent, false);
    const cut = scourStruckGround(locked.api, {
      stormId: 1,
      x: SITE.x,
      y: SITE.y,
      radius: 40,
      eyeRadius: 5,
      intensity: 1,
      durationSeconds: 1,
      cells: [{ x: SITE.x, y: SITE.y, severity: 1 }],
    });
    expect(cut).toEqual([]);
    expect(locked.sculpts).toEqual([]);
  });

  it('scours the same strike once the ground IS unlocked', () => {
    const open = seaWorld(continent);
    const cut = scourStruckGround(open.api, {
      stormId: 1,
      x: SITE.x,
      y: SITE.y,
      radius: 40,
      eyeRadius: 5,
      intensity: 1,
      durationSeconds: 1,
      cells: [{ x: SITE.x, y: SITE.y, severity: 1 }],
    });
    expect(cut).toEqual([{ x: SITE.x, y: SITE.y }]);
    expect(open.sculpts[0]?.radius).toBe(WIND_SCOUR_BRUSH_RADIUS_CELLS);
    expect(open.sculpts[0]?.delta).toBeLessThan(0);
  });

  it('surges nothing on ground no player has unlocked, and keeps the rest of the clock', () => {
    const locked = seaWorld(shoreEverywhere, false);
    const storm = cyclones.spawnAt(locked.api, SITE.x, SITE.y);
    storm.envelope = 1;
    const OVERSHOOT_SECONDS = 1;
    storm.ownerDebtSeconds = SURGE_INTERVAL_SECONDS + OVERSHOOT_SECONDS;

    expect(tickSurge(locked.api, storm, 1, 0, createSeededRng(SURGE_SEED).next)).toBeNull();
    expect(locked.sculpts).toEqual([]);
    expect(storm.ownerDebtSeconds).toBe(OVERSHOOT_SECONDS);
  });

  it('surges on a shoreline the players hold', () => {
    const open = seaWorld(shoreEverywhere);
    const storm = cyclones.spawnAt(open.api, SITE.x, SITE.y);
    storm.envelope = 1;
    storm.ownerDebtSeconds = SURGE_INTERVAL_SECONDS;

    expect(tickSurge(open.api, storm, 1, 0, createSeededRng(SURGE_SEED).next)).not.toBeNull();
    expect(open.sculpts[0]?.delta).toBeLessThan(0);
  });
});

describe('the roster across world creates', () => {
  it('starts empty when a create restored no slice', () => {
    const world = seaWorld(openSea).api;
    cyclonePlugin.onWorldCreate!(world);
    cyclones.spawnAt(world, SITE.x, SITE.y);

    cyclonePlugin.onWorldCreate!(world);

    expect(cyclones.count()).toBe(0);
  });

  it('keeps the roster a create DID restore, slice first as the host runs it', () => {
    const world = seaWorld(openSea).api;
    cyclonePlugin.onWorldCreate!(world);
    cyclones.spawnAt(world, SITE.x, SITE.y);
    const saved = JSON.parse(JSON.stringify(saveCyclones()));

    cyclonePlugin.persistence!.load(saved, CYCLONE_SLICE_VERSION);
    cyclonePlugin.onWorldCreate!(world);

    expect(cyclones.count()).toBe(1);
  });
});

describe('summoning a cyclone', () => {
  it('names the env that parked the sky', () => {
    const world = seaWorld(openSea).api;
    cyclonePlugin.onWorldCreate!(world);
    cyclones.freeze(true);
    expect(summon(world, SITE).detail).toContain('CYCLONE_DEV_FORCE');
  });

  it('refuses a site that is not a place in this world', () => {
    const world = seaWorld(openSea).api;
    cyclonePlugin.onWorldCreate!(world);
    expect(summon(world, { x: SITE.x, y: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      detail: 'that is not a place in this world',
    });
  });

  it('refuses once the sky already holds its ceiling', () => {
    const world = seaWorld(openSea).api;
    cyclonePlugin.onWorldCreate!(world);
    for (let summoned = 0; summoned < MAX_ACTIVE_CYCLONES; summoned++) {
      expect(summon(world, SITE).ok).toBe(true);
    }
    expect(summon(world, SITE)).toEqual({
      ok: false,
      detail: `${MAX_ACTIVE_CYCLONES} cyclone is already in the air`,
    });
  });

  it('refuses when there is no open water within reach of where you looked', () => {
    const world = seaWorld(continent).api;
    cyclonePlugin.onWorldCreate!(world);
    expect(summon(world, SITE)).toEqual({
      ok: false,
      detail: `no open water within ${DEV_SEARCH_RADIUS_CELLS} cells of (${SITE.x}, ${SITE.y})`,
    });
  });
});
