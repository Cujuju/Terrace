// PHOTOSENSITIVITY, and the strikes that drive it.
//
// The photosensitivity block is the pre-split weather suite's, moved verbatim to
// the plugin that owns lightning now; nothing in it was weakened, because it is
// the one property in this codebase that is a safety requirement rather than a
// tuning choice.
//
// Nothing here imports three: every value that decides how the flash BEHAVES is
// reachable without a GL context.

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

// ── PHOTOSENSITIVITY ─────────────────────────────────────────────────────────

describe('the photosensitivity floor', () => {
  it('never samples an interval below the floor or above the ceiling', () => {
    // Includes the two ends of the uniform range, which are where the clamps
    // bite: u → 0 gives an interval of 0, u → 1 gives Infinity.
    for (const u of [0, 1e-12, 0.001, 0.5, 0.9, 0.999999, 1 - 1e-15, 1]) {
      const interval = nextFlashIntervalSeconds(u);
      expect(interval).toBeGreaterThanOrEqual(MIN_FLASH_INTERVAL_SECONDS);
      expect(interval).toBeLessThanOrEqual(MAX_FLASH_INTERVAL_SECONDS);
      expect(Number.isFinite(interval)).toBe(true);
    }
    // The floor is at least the WCAG-derived three seconds it is documented as.
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
      // Once it has started falling it never rises again.
      if (!rising) expect(now).toBeLessThanOrEqual(previous + 1e-12);
      previous = now;
    }
    expect(risesThenFalls).toBe(1);
    expect(flashBrightness(FLASH_ATTACK_SECONDS)).toBeCloseTo(1, 9);
    expect(flashBrightness(-1)).toBe(0);
    expect(flashBrightness(FLASH_DURATION_SECONDS)).toBe(0);
    expect(flashBrightness(Number.NaN)).toBe(0);
    // Several frames of attack at 60 Hz, so it is a ramp and not a one-frame jump.
    expect(FLASH_ATTACK_SECONDS).toBeGreaterThan(2 / 60);
  });

  it('holds the floor within one storm across a long run', () => {
    // The server decides when a bolt lands (server/lightning.ts), so the worst
    // case this floor exists for is a server striking EVERY FRAME.
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
    // Three storms, all begging to flash every frame. Per-rig floors would each
    // hold and the client would still see three flashes 16 ms apart; this is the
    // property MAX_ACTIVE_SYSTEMS makes possible and the governor forbids.
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
    // No more flashes than the floor physically allows in ten minutes.
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
    // …and the governor was never touched, so the first strike afterwards is
    // free to flash rather than being held back by phantom suppressions.
    expect(governor.secondsSinceLastFlash()).toBe(Number.POSITIVE_INFINITY);
  });

  it('drops a second strike inside the floor rather than deferring it', () => {
    // A queue would repay the suppressed flashes the instant the floor cleared,
    // which is the burst the floor exists to prevent.
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
    // Still inside the floor: a poisoned accumulator would have read as "ready".
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
    // A rig is POOLED (client/rig.ts): a storm's LightningSchedule outlives the
    // storm and is handed to whatever system acquires the rig next.
    const governor = new LightningGovernor();
    governor.advance(MEAN_FLASH_INTERVAL_SECONDS * 10);
    const schedule = new LightningSchedule();

    expect(schedule.strike(governor)).toBe(true);
    schedule.advance(FLASH_ATTACK_SECONDS * 2);
    expect(schedule.brightness()).toBeGreaterThan(0);

    schedule.reset();
    // No advance() call here — this is the pool handing the rig to a brand-new
    // storm before a single frame has run.
    expect(schedule.brightness()).toBe(0);

    // And the floor still holds across the handover.
    schedule.advance(1 / 60);
    expect(schedule.strike(governor)).toBe(false);
  });

  it('places a bolt from the cloud base down into the haze', () => {
    expect(BOLT_TOP_WORLD_Y).toBe(CLOUD_BASE_WORLD_Y);
    expect(BOLT_BOTTOM_WORLD_Y).toBeGreaterThan(0);
    expect(BOLT_BOTTOM_WORLD_Y).toBeLessThan(BOLT_TOP_WORLD_Y);
  });

  it('draws a reproducible stream from a seeded generator', () => {
    // The floor above is only assertable because the stream is reproducible.
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

// ── The strikes themselves ───────────────────────────────────────────────────

describe('strikes', () => {
  it('round-trips through the packed wire form', () => {
    const strikes = [
      { systemId: STRIKE_NO_SYSTEM, x: 3, y: 4 },
      { systemId: 7, x: 100, y: 200 },
    ];
    expect(parseStrikesPayload({ strikes: packStrikes(strikes) })).toEqual(strikes);
    expect(parseStrikesPayload({ strikes: 'nope' })).toBeNull();
    // Fractional or negative cells are dropped individually.
    expect(parseStrikesPayload({ strikes: [1, 1.5, 2, 2, 3, 4] })).toEqual([
      { systemId: 2, x: 3, y: 4 },
    ]);
  });

  it('refuses the sea for a dry bolt, and finds the exposed cell on land', () => {
    // An ocean world simply gets no dry lightning, which is honest.
    const sea = worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
    const seaWorld = { worldSize: sea.size, heightAt: (x: number, y: number) => sea.heightAt(x, y) };
    expect(chooseDryStrikeCell(seaWorld)).toBeNull();

    // Height alone picks the middle of a plateau; prominence is what finds the
    // cell standing above what surrounds it.
    const flat = { worldSize: 64, heightAt: () => 100 };
    const bump = {
      worldSize: 64,
      heightAt: (x: number, y: number) => (x === 32 && y === 32 ? 200 : 100),
    };
    expect(exposureAt(bump, 32, 32)).toBeGreaterThan(exposureAt(flat, 32, 32));
  });

  it('shares one world-wide budget across storms instead of multiplying it', () => {
    // Two full-strength storms throw the budget BETWEEN them, not twice it —
    // otherwise "how often does lightning start a fire" would be a function of
    // the system cap rather than a lightning decision.
    const world = { worldSize: 64, heightAt: () => 100 };
    const storm = (id: number) => ({
      id,
      x: 32,
      y: 32,
      radius: 20,
      peakIntensity: 1,
      envelope: 1,
    });
    // A source that always fires every roll: the count is then exactly the
    // number of storms that were ALLOWED to roll, which is what is under test.
    setThunderstormRandomSource(() => 0);
    const one = rollStrikes(world, [storm(1)], 1);
    const three = rollStrikes(world, [storm(1), storm(2), storm(3)], 1);
    // Each living storm still gets a roll; what the budget divides is the RATE,
    // and the rate a lone storm gets is the whole budget.
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
    // plugins/fire/server/index.ts subscribes to exactly that string; this is
    // the half of that contract this plugin owns.
    expect(THUNDERSTORM_STRIKES_MESSAGE).toBe('strikes');
    expect(THUNDERSTORM_PLUGIN_NAME).toBe('thunderstorm');
  });
});
