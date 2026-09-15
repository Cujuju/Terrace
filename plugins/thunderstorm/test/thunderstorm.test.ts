import { beforeEach, describe, expect, it } from 'vitest';
import { cellsAcross, createSeededRng } from '@terrace/shared';
import {
  MAX_ACTIVE_SYSTEMS,
  MAX_STRIKES_PER_MESSAGE,
  STRIKE_NO_SYSTEM,
  STRIKE_WIRE_STRIDE,
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
  MIN_FLASH_INTERVAL_SECONDS,
  flashBrightness,
} from '../client/lightning.ts';
import { CLOUD_BASE_WORLD_Y } from '../../../client/src/plugins/kit/precipitation.ts';
import {
  BUDGET_SHARE_FLOOR_INTENSITY,
  DRY_STRIKE_MAX_SAMPLE_ATTEMPTS,
  DRY_STRIKE_TARGET_SAMPLES,
  EXPOSURE_SAMPLE_RADIUS_CELLS,
  SAMPLE_ATTEMPT_MULTIPLIER,
  STRIKE_BUDGET_PER_SECOND,
  STRIKE_MAX_SAMPLE_ATTEMPTS,
  STRIKE_TARGET_SAMPLES,
  chooseDryStrikeCell,
  rollStrikes,
  type StrikeSource,
  type StrikeWorld,
} from '../server/lightning.ts';
import { setThunderstormRandomSource } from '../server/rng.ts';

const BUDGET_SEED = 20260927;

const SECONDS_PER_HOUR = 3600;

const BUDGET_TOLERANCE = 0.15;

const TICK_RATE_TOLERANCE = 0.1;

const openWorld: StrikeWorld = {
  worldSize: 64,
  heightAt: () => 100,
  isCellUnlocked: () => true,
};

function storm(id: number, overrides: Partial<StrikeSource> = {}): StrikeSource {
  return { id, x: 32, y: 32, radius: 20, peakIntensity: 1, envelope: 1, ...overrides };
}

function strikesOverAnHour(
  world: StrikeWorld,
  systems: readonly StrikeSource[],
  dt: number,
): number {
  setThunderstormRandomSource(createSeededRng(BUDGET_SEED).next);
  let struck = 0;
  for (let tick = 0; tick < Math.round(SECONDS_PER_HOUR / dt); tick++) {
    for (const strike of rollStrikes(world, systems, dt)) {
      if (strike.systemId !== STRIKE_NO_SYSTEM) struck++;
    }
  }
  return struck;
}

beforeEach(() => {
  setThunderstormRandomSource(createSeededRng(20260824).next);
});

describe('the photosensitivity floor', () => {
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
    expect(governor.requestFlash()).toBe(true);
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
    governor.advance(MIN_FLASH_INTERVAL_SECONDS * 10);
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
});

describe('the strike budget', () => {
  it('is SHARED across storms, not multiplied by them', () => {
    const expected = STRIKE_BUDGET_PER_SECOND * SECONDS_PER_HOUR;
    const dt = 0.05;
    const one = strikesOverAnHour(openWorld, [storm(1)], dt);
    const three = strikesOverAnHour(openWorld, [storm(1), storm(2), storm(3)], dt);

    expect(one).toBeGreaterThan(0);
    expect(Math.abs(one - expected)).toBeLessThanOrEqual(expected * BUDGET_TOLERANCE);
    expect(Math.abs(three - expected)).toBeLessThanOrEqual(expected * BUDGET_TOLERANCE);
  });

  it('spends the same hour whatever the tick rate', () => {
    const fine = strikesOverAnHour(openWorld, [storm(1)], 0.05);
    const coarse = strikesOverAnHour(openWorld, [storm(1)], 0.5);
    expect(Math.abs(fine - coarse)).toBeLessThanOrEqual(
      Math.min(fine, coarse) * TICK_RATE_TOLERANCE,
    );
  });

  it('scales with intensity below one storm-equivalent instead of sharing', () => {
    expect(BUDGET_SHARE_FLOOR_INTENSITY).toBe(1);
    const half = strikesOverAnHour(openWorld, [storm(1, { peakIntensity: 0.5 })], 0.5);
    const full = strikesOverAnHour(openWorld, [storm(1)], 0.5);
    expect(half).toBeLessThan(full);
  });

  it('throws nothing from a storm that has not gathered yet', () => {
    setThunderstormRandomSource(() => 0);
    const strikes = rollStrikes(openWorld, [storm(1, { envelope: 0 })], 1);
    expect(strikes.filter((s) => s.systemId !== STRIKE_NO_SYSTEM)).toHaveLength(0);
  });
});

describe('how many draws a strike may cost', () => {
  it('gives up after a bounded number of draws, and samples one world unit out', () => {
    expect(STRIKE_MAX_SAMPLE_ATTEMPTS).toBe(SAMPLE_ATTEMPT_MULTIPLIER * STRIKE_TARGET_SAMPLES);
    expect(DRY_STRIKE_MAX_SAMPLE_ATTEMPTS).toBe(
      SAMPLE_ATTEMPT_MULTIPLIER * DRY_STRIKE_TARGET_SAMPLES,
    );
    expect(EXPOSURE_SAMPLE_RADIUS_CELLS).toBe(cellsAcross(1));

    let drawn = 0;
    const counting: StrikeWorld = {
      worldSize: 64,
      heightAt: () => 100,
      isCellUnlocked: () => {
        drawn++;
        return false;
      },
    };
    expect(chooseDryStrikeCell(counting)).toBeNull();
    expect(drawn).toBe(DRY_STRIKE_MAX_SAMPLE_ATTEMPTS);
  });
});

describe('the strike wire form', () => {
  it('round-trips through the packed wire form', () => {
    const strikes = [
      { systemId: STRIKE_NO_SYSTEM, x: 3, y: 4 },
      { systemId: 7, x: 100, y: 200 },
    ];
    expect(parseStrikesPayload({ strikes: packStrikes(strikes) })).toEqual(strikes);
    expect(parseStrikesPayload({ strikes: 'nope' })).toBeNull();
    expect(parseStrikesPayload(null)).toBeNull();
  });

  it('refuses a system id that is not a whole count of systems', () => {
    expect(parseStrikesPayload({ strikes: [1.5, 3, 4] })).toEqual([]);
    expect(parseStrikesPayload({ strikes: [-1, 3, 4] })).toEqual([]);
    expect(parseStrikesPayload({ strikes: [Number.NaN, 3, 4] })).toEqual([]);
    expect(parseStrikesPayload({ strikes: [STRIKE_NO_SYSTEM, 3, 4] })).toEqual([
      { systemId: STRIKE_NO_SYSTEM, x: 3, y: 4 },
    ]);
  });

  it('stops at the cap instead of walking an oversized array', () => {
    const oversized: number[] = [];
    let read = 0;
    for (let n = 0; n < MAX_STRIKES_PER_MESSAGE * 4; n++) oversized.push(1, n, n);
    const watched = new Proxy(oversized, {
      get(target, key, receiver): unknown {
        if (typeof key === 'string' && Number.isInteger(Number(key))) read++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });

    const parsed = parseStrikesPayload({ strikes: watched });
    expect(parsed).toHaveLength(MAX_STRIKES_PER_MESSAGE);
    expect(read).toBe(MAX_STRIKES_PER_MESSAGE * STRIKE_WIRE_STRIDE);
  });
});
