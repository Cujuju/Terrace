import { beforeEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT, SEA_LEVEL, cellsAcross, createSeededRng } from '@terrace/shared';
import { worldWithTerrain } from '../../../server/test/support/world.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  STRIKE_NO_SYSTEM,
  THUNDERSTORM_COVERAGE_FRACTION,
  THUNDERSTORM_PLUGIN_NAME,
  THUNDERSTORM_STRIKES_MESSAGE,
  packStrikes,
  parseStrikesPayload,
} from '../protocol.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  BOLT_TOP_WORLD_Y,
  FLASH_ATTACK_SECONDS,
  FLASH_DURATION_SECONDS,
  LightningGovernor,
  LightningSchedule,
  MAX_FLASH_INTERVAL_SECONDS,
  MEAN_FLASH_INTERVAL_SECONDS,
  MIN_FLASH_INTERVAL_SECONDS,
  createFlashRandom,
  flashBrightness,
  nextFlashIntervalSeconds,
} from '../client/lightning.ts';
import { CLOUD_BASE_WORLD_Y } from '../../../client/src/plugins/kit/precipitation.ts';
import {
  STRIKE_BUDGET_PER_SECOND,
  chooseDryStrikeCell,
  exposureAt,
  rollStrikes,
} from '../server/lightning.ts';
import { plugin as thunderstormPlugin } from '../server/index.ts';
import { setThunderstormRandomSource } from '../server/rng.ts';

const WORLD_SIZE = cellsAcross(512);

beforeEach(() => {
  setThunderstormRandomSource(createSeededRng(20260824).next);
});

describe('the photosensitivity floor', () => {
  it('never samples an interval below the floor or above the ceiling', () => {
    for (const u of [0, 1e-12, 0.001, 0.5, 0.9, 0.999999, 1 - 1e-15, 1]) {
      const interval = nextFlashIntervalSeconds(u);
      expect(interval).toBeGreaterThanOrEqual(MIN_FLASH_INTERVAL_SECONDS);
      expect(interval).toBeLessThanOrEqual(MAX_FLASH_INTERVAL_SECONDS);
      expect(Number.isFinite(interval)).toBe(true);
    }
    expect(MIN_FLASH_INTERVAL_SECONDS).toBeGreaterThanOrEqual(3);
    expect(MEAN_FLASH_INTERVAL_SECONDS).toBeGreaterThan(MIN_FLASH_INTERVAL_SECONDS);
  });

  it('has exactly one rise and one fall — no strobing inside a flash', () => {
    const step = FLASH_DURATION_SECONDS / 400;
    let risesThenFalls = 0;
    let previous = flashBrightness(0);
    let rising = true;
    for (let t = step; t < FLASH_DURATION_SECONDS; t += step) {
      const now = flashBrightness(t);
      if (rising && now < previous) {
        rising = false;
        risesThenFalls++;
      }
      if (!rising) expect(now).toBeLessThanOrEqual(previous + 1e-12);
      previous = now;
    }
    expect(risesThenFalls).toBe(1);
    expect(flashBrightness(FLASH_ATTACK_SECONDS)).toBeCloseTo(1, 9);
    expect(flashBrightness(-1)).toBe(0);
    expect(flashBrightness(FLASH_DURATION_SECONDS)).toBe(0);
    expect(flashBrightness(Number.NaN)).toBe(0);
    expect(FLASH_ATTACK_SECONDS).toBeGreaterThan(2 / 60);
  });

  it('holds the floor within one storm across a long run', () => {
    const governor = new LightningGovernor();
    const schedule = new LightningSchedule();
    const dt = 1 / 60;
    let sinceLast = Number.POSITIVE_INFINITY;
    let flashes = 0;

    for (let frame = 0; frame < 60 * 600; frame++) {
      governor.advance(dt);
      schedule.advance(dt);
      sinceLast += dt;
      if (schedule.strike(governor)) {
        expect(sinceLast).toBeGreaterThanOrEqual(MIN_FLASH_INTERVAL_SECONDS - 1e-9);
        sinceLast = 0;
        flashes++;
      }
    }
    expect(flashes).toBeGreaterThan(0);
  });

  it('holds the floor ACROSS concurrent storms — the governor, not the clock', () => {
    const governor = new LightningGovernor();
    const schedules = Array.from({ length: MAX_ACTIVE_SYSTEMS }, () => new LightningSchedule());
    const dt = 1 / 60;
    let sinceLast = Number.POSITIVE_INFINITY;
    let flashes = 0;

    for (let frame = 0; frame < 60 * 600; frame++) {
      governor.advance(dt);
      sinceLast += dt;
      for (const schedule of schedules) {
        schedule.advance(dt);
        if (!schedule.strike(governor)) continue;
        expect(sinceLast).toBeGreaterThanOrEqual(MIN_FLASH_INTERVAL_SECONDS - 1e-9);
        sinceLast = 0;
        flashes++;
      }
    }
    expect(flashes).toBeGreaterThan(0);
    expect(flashes).toBeLessThanOrEqual(600 / MIN_FLASH_INTERVAL_SECONDS + 1);
  });

  it('starts nothing at all on its own — only a strike lights it', () => {
    const governor = new LightningGovernor();
    const schedule = new LightningSchedule();
    for (let frame = 0; frame < 60 * 600; frame++) {
      governor.advance(1 / 60);
      schedule.advance(1 / 60);
      expect(schedule.brightness()).toBe(0);
    }
    expect(governor.secondsSinceLastFlash()).toBe(Number.POSITIVE_INFINITY);
  });

  it('drops a second strike inside the floor rather than deferring it', () => {
    const governor = new LightningGovernor();
    const schedule = new LightningSchedule();
    governor.advance(600);
    expect(schedule.strike(governor)).toBe(true);
    governor.advance(1 / 60);
    schedule.advance(1 / 60);
    expect(schedule.strike(governor)).toBe(false);
  });

  it('survives a NaN dt without disarming the floor forever', () => {
    const governor = new LightningGovernor();
    governor.advance(Number.NaN);
    expect(governor.secondsSinceLastFlash()).toBe(Number.POSITIVE_INFINITY);
    expect(governor.requestFlash()).toBe(true);
    governor.advance(Number.NaN);
    expect(governor.requestFlash()).toBe(false);
  });

  it('resets to ready, so a disposed and re-attached plugin is not held back', () => {
    const governor = new LightningGovernor();
    expect(governor.requestFlash()).toBe(true);
    expect(governor.requestFlash()).toBe(false);
    governor.reset();
    expect(governor.requestFlash()).toBe(true);
  });

  it('schedule.reset() goes dark on the spot, so a pooled rig never reopens mid-flash', () => {
    const governor = new LightningGovernor();
    governor.advance(MEAN_FLASH_INTERVAL_SECONDS * 10);
    const schedule = new LightningSchedule();

    expect(schedule.strike(governor)).toBe(true);
    schedule.advance(FLASH_ATTACK_SECONDS * 2);
    expect(schedule.brightness()).toBeGreaterThan(0);

    schedule.reset();
    expect(schedule.brightness()).toBe(0);

    schedule.advance(1 / 60);
    expect(schedule.strike(governor)).toBe(false);
  });

  it('places a bolt from the cloud base down into the haze', () => {
    expect(BOLT_TOP_WORLD_Y).toBe(CLOUD_BASE_WORLD_Y);
    expect(BOLT_BOTTOM_WORLD_Y).toBeGreaterThan(0);
    expect(BOLT_BOTTOM_WORLD_Y).toBeLessThan(BOLT_TOP_WORLD_Y);
  });

  it('draws a reproducible stream from a seeded generator', () => {
    const a = createFlashRandom(1234);
    const b = createFlashRandom(1234);
    for (let n = 0; n < 100; n++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('strikes', () => {
  it('round-trips through the packed wire form', () => {
    const strikes = [
      { systemId: STRIKE_NO_SYSTEM, x: 3, y: 4 },
      { systemId: 7, x: 100, y: 200 },
    ];
    expect(parseStrikesPayload({ strikes: packStrikes(strikes) })).toEqual(strikes);
    expect(parseStrikesPayload({ strikes: 'nope' })).toBeNull();
    expect(parseStrikesPayload({ strikes: [1, 1.5, 2, 2, 3, 4] })).toEqual([
      { systemId: 2, x: 3, y: 4 },
    ]);
  });

  it('refuses the sea for a dry bolt, and finds the exposed cell on land', () => {
    const sea = worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
    const seaWorld = { worldSize: sea.size, heightAt: (x: number, y: number) => sea.heightAt(x, y) };
    expect(chooseDryStrikeCell(seaWorld)).toBeNull();

    const flat = { worldSize: 64, heightAt: () => 100 };
    const bump = {
      worldSize: 64,
      heightAt: (x: number, y: number) => (x === 32 && y === 32 ? 200 : 100),
    };
    expect(exposureAt(bump, 32, 32)).toBeGreaterThan(exposureAt(flat, 32, 32));
  });

  it('shares one world-wide budget across storms instead of multiplying it', () => {
    const world = { worldSize: 64, heightAt: () => 100 };
    const storm = (id: number) => ({
      id,
      x: 32,
      y: 32,
      radius: 20,
      peakIntensity: 1,
      envelope: 1,
    });
    setThunderstormRandomSource(() => 0);
    const one = rollStrikes(world, [storm(1)], 1);
    const three = rollStrikes(world, [storm(1), storm(2), storm(3)], 1);
    expect(one.filter((s) => s.systemId !== STRIKE_NO_SYSTEM)).toHaveLength(1);
    expect(three.filter((s) => s.systemId !== STRIKE_NO_SYSTEM)).toHaveLength(3);
    expect(STRIKE_BUDGET_PER_SECOND).toBeGreaterThan(0);
  });

  it('throws nothing from a storm that has not gathered yet', () => {
    const world = { worldSize: 64, heightAt: () => 100 };
    setThunderstormRandomSource(() => 0);
    const strikes = rollStrikes(
      world,
      [{ id: 1, x: 32, y: 32, radius: 20, peakIntensity: 1, envelope: 0 }],
      1,
    );
    expect(strikes.filter((s) => s.systemId !== STRIKE_NO_SYSTEM)).toHaveLength(0);
  });
});

describe('thunderstorm as a plugin', () => {
  it('carries its own share of the sky, its own ceiling, and no persistence', () => {
    expect(thunderstormPlugin.name).toBe(THUNDERSTORM_PLUGIN_NAME);
    expect(THUNDERSTORM_COVERAGE_FRACTION).toBeCloseTo(0.036, 12);
    expect(MAX_ACTIVE_SYSTEMS).toBe(3);
    expect(thunderstormPlugin.persistence).toBeUndefined();
    expect(thunderstormPlugin.onIntent).toBeUndefined();
    expect(thunderstormPlugin.onTerrainChanged).toBeUndefined();
  });

  it('names its strike message so the host prefixes it thunderstorm:strikes', () => {
    expect(THUNDERSTORM_STRIKES_MESSAGE).toBe('strikes');
    expect(THUNDERSTORM_PLUGIN_NAME).toBe('thunderstorm');
  });
});
