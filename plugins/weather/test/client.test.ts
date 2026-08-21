// The client half's PURE logic: payload validation, interpolation, the fall
// maths, and — the one that matters most — the photosensitivity floor.
//
// Rendering is verified by eye per design §8 ("no headless GL rig"), so nothing
// here imports three, which is also what lets it run in the same node
// environment as the server tests. That split is why sky.ts exists separately
// from rig.ts: every value that decides how the weather BEHAVES is reachable
// without a GL context.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, MAX_HEIGHT } from '@terrace/shared';
import {
  WEATHER_KINDS,
  parseSystemsPayload,
  roundBroadcastIntensity,
  roundBroadcastPosition,
  type WeatherSystemState,
} from '../protocol.ts';
import {
  DEFAULT_INTERPOLATION_SECONDS,
  MAX_INTERPOLATION_SECONDS,
  MIN_INTERPOLATION_SECONDS,
  WeatherInterpolator,
} from '../client/interpolation.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  BOLT_MAX_REACH_FRACTION,
  BOLT_TOP_WORLD_Y,
  CLOUD_BASE_WORLD_Y,
  FLASH_ATTACK_SECONDS,
  FLASH_DURATION_SECONDS,
  FOG_LAYERS,
  LightningGovernor,
  LightningSchedule,
  MAX_FLASH_INTERVAL_SECONDS,
  MAX_TERRAIN_WORLD_Y,
  WORLD_UNITS_PER_BAND,
  MEAN_FLASH_INTERVAL_SECONDS,
  MIN_FLASH_INTERVAL_SECONDS,
  PRECIPITATION_COLUMN_WORLD_UNITS,
  PRECIPITATION_FLOOR_WORLD_Y,
  PRECIPITATION_PROFILES,
  createFlashRandom,
  driftSeconds,
  fallFraction,
  flashBrightness,
  fogEdgeWobble,
  nextFlashIntervalSeconds,
} from '../client/sky.ts';

function system(
  id: number,
  overrides: Partial<WeatherSystemState> = {},
): WeatherSystemState {
  return {
    id,
    kind: 'rain',
    x: 0,
    y: 0,
    radius: 30,
    intensity: 1,
    vx: 0,
    vy: 0,
    ...overrides,
  };
}

// ── The wire ─────────────────────────────────────────────────────────────────

describe('parseSystemsPayload', () => {
  it('accepts a well-formed payload unchanged', () => {
    const payload = { systems: [system(1), system(2, { kind: 'fog' })] };
    expect(parseSystemsPayload(payload)).toEqual(payload.systems);
  });

  it('reads an empty list as a clear sky, not as a failure', () => {
    expect(parseSystemsPayload({ systems: [] })).toEqual([]);
  });

  it('returns null for anything that is not a system list', () => {
    expect(parseSystemsPayload(null)).toBeNull();
    expect(parseSystemsPayload(42)).toBeNull();
    expect(parseSystemsPayload({})).toBeNull();
    expect(parseSystemsPayload({ systems: 'rain' })).toBeNull();
  });

  it('drops malformed entries individually and keeps the rest', () => {
    const good = system(1);
    const parsed = parseSystemsPayload({
      systems: [
        good,
        null,
        { ...system(2), kind: 'hail' },
        { ...system(3), id: Number.NaN },
        { ...system(4), radius: 0 },
        { ...system(5), radius: -3 },
        { ...system(6), x: 'over there' },
        { ...system(7), vx: Number.POSITIVE_INFINITY },
        { ...system(8), intensity: undefined },
      ],
    });
    expect(parsed).toEqual([good]);
  });

  it('clamps intensity rather than dropping the system', () => {
    const parsed = parseSystemsPayload({
      systems: [system(1, { intensity: 4 }), system(2, { intensity: -1 })],
    });
    expect(parsed?.map((entry) => entry.intensity)).toEqual([1, 0]);
  });

  it('rounds positions to 1/100 cell and intensity to 1/1000', () => {
    expect(roundBroadcastPosition(1.234567)).toBe(1.23);
    expect(roundBroadcastPosition(-1.235)).toBe(-1.24);
    expect(roundBroadcastIntensity(0.1234567)).toBe(0.123);
    // The clamp is part of the rounding contract, so an over-range envelope
    // cannot reach the wire.
    expect(roundBroadcastIntensity(1.5)).toBe(1);
    expect(roundBroadcastIntensity(-0.2)).toBe(0);
  });
});

// ── Interpolation ────────────────────────────────────────────────────────────

describe('WeatherInterpolator', () => {
  it('walks the centre between two broadcasts and clamps at the end', () => {
    const interpolator = new WeatherInterpolator();
    interpolator.receive([system(1, { x: 0, y: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([system(1, { x: 10, y: 20 })]);

    expect(interpolator.sample().get(1)!.x).toBeCloseTo(0, 9);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(5, 9);
    expect(interpolator.sample().get(1)!.y).toBeCloseTo(10, 9);

    // Past the window it holds at truth rather than running ahead of it.
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS * 10);
    expect(interpolator.sample().get(1)!.x).toBe(10);
    expect(interpolator.progress()).toBe(1);
  });

  it('interpolates radius and intensity too', () => {
    const interpolator = new WeatherInterpolator();
    interpolator.receive([system(1, { radius: 20, intensity: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([system(1, { radius: 40, intensity: 1 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);

    const sampled = interpolator.sample().get(1)!;
    expect(sampled.radius).toBeCloseTo(30, 9);
    expect(sampled.intensity).toBeCloseTo(0.5, 9);
  });

  it('places a first-seen system exactly where the server says it is', () => {
    const interpolator = new WeatherInterpolator();
    interpolator.receive([system(9, { x: 123, y: 456 })]);
    const sampled = interpolator.sample().get(9)!;
    expect(sampled.x).toBe(123);
    expect(sampled.y).toBe(456);
  });

  it('drops a system the moment it leaves the list', () => {
    const interpolator = new WeatherInterpolator();
    interpolator.receive([system(1), system(2)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([system(1)]);
    expect(interpolator.sample().has(2)).toBe(false);
  });

  it('measures the window and clamps it into the documented band', () => {
    const interpolator = new WeatherInterpolator();
    interpolator.receive([system(1, { x: 0 })]);
    // A stall far longer than the ceiling must not become the window.
    interpolator.advance(60);
    interpolator.receive([system(1, { x: 10 })]);
    interpolator.advance(MAX_INTERPOLATION_SECONDS);
    expect(interpolator.progress()).toBe(1);

    // …and a burst far shorter than the floor must not either.
    const fast = new WeatherInterpolator();
    fast.receive([system(1, { x: 0 })]);
    fast.advance(1e-9);
    fast.receive([system(1, { x: 10 })]);
    fast.advance(MIN_INTERPOLATION_SECONDS);
    expect(fast.progress()).toBe(1);
  });

  it('starts the next segment from the RENDERED pose, not the last message', () => {
    const interpolator = new WeatherInterpolator();
    interpolator.receive([system(1, { x: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([system(1, { x: 10 })]);
    // Only a quarter of the way there when the next message lands.
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 4);
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(2.5, 9);
    interpolator.receive([system(1, { x: 20 })]);
    // The new segment starts at 2.5, not back at 10 and not at 0.
    expect(interpolator.sample().get(1)!.x).toBeCloseTo(2.5, 9);
  });

  it('forgets everything on clear', () => {
    const interpolator = new WeatherInterpolator();
    interpolator.receive([system(1)]);
    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});

// ── The vertical layout, and the fall ────────────────────────────────────────

describe('the falling column', () => {
  it('derives the cloud base from the shared height constants', () => {
    // The ceiling in BANDS times what a band draws — the quotient alone was
    // world units only while a band drew one world unit, which stopped being
    // true on 2026-08-20 (see WORLD_UNITS_PER_BAND).
    expect(MAX_TERRAIN_WORLD_Y).toBe((MAX_HEIGHT / BAND_HEIGHT) * WORLD_UNITS_PER_BAND);
    // Clear sky above the tallest possible mountain, at the worst case.
    expect(CLOUD_BASE_WORLD_Y).toBeGreaterThan(MAX_TERRAIN_WORLD_Y);
    // The column reaches past a fresh world's open-sea floor (three bands down)
    // so precipitation visibly meets the ground everywhere.
    expect(PRECIPITATION_FLOOR_WORLD_Y).toBeLessThan(-3);
    expect(PRECIPITATION_COLUMN_WORLD_UNITS).toBe(
      CLOUD_BASE_WORLD_Y - PRECIPITATION_FLOOR_WORLD_Y,
    );
  });

  it('wraps every particle into [0, 1) for any elapsed time', () => {
    const speed = PRECIPITATION_PROFILES.rain!.fallSpeed;
    for (const elapsed of [0, 0.016, 1, 3600, 86400, -5]) {
      for (const birth of [0, 0.25, 0.999999]) {
        const fraction = fallFraction(elapsed, birth, speed);
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThan(1);
      }
    }
  });

  it('advances a particle down the column at exactly its fall speed', () => {
    const speed = PRECIPITATION_PROFILES.snow!.fallSpeed;
    const start = fallFraction(0, 0, speed);
    const after = fallFraction(1, 0, speed);
    expect(start).toBe(0);
    expect(after * PRECIPITATION_COLUMN_WORLD_UNITS).toBeCloseTo(speed, 9);
  });

  it('spreads particles through the column by their birth phase', () => {
    const speed = PRECIPITATION_PROFILES.rain!.fallSpeed;
    expect(fallFraction(0, 0.25, speed)).toBeCloseTo(0.25, 12);
    expect(fallFraction(0, 0.75, speed)).toBeCloseTo(0.75, 12);
  });

  it('shears snow far more than rain for the same wind — it fell for longer', () => {
    const rain = PRECIPITATION_PROFILES.rain!;
    const snow = PRECIPITATION_PROFILES.snow!;
    const rainDrift = driftSeconds(1, rain.fallSpeed);
    const snowDrift = driftSeconds(1, snow.fallSpeed);
    expect(rainDrift).toBeCloseTo(PRECIPITATION_COLUMN_WORLD_UNITS / rain.fallSpeed, 9);
    expect(snowDrift).toBeGreaterThan(rainDrift * 5);
  });

  it('gives fog no precipitation profile, and everything else one', () => {
    expect(PRECIPITATION_PROFILES.fog).toBeNull();
    for (const kind of WEATHER_KINDS) {
      if (kind === 'fog') continue;
      expect(PRECIPITATION_PROFILES[kind]).not.toBeNull();
    }
    // A storm is rain, harder — the same form, more of it.
    expect(PRECIPITATION_PROFILES.storm!.form).toBe('streak');
    expect(PRECIPITATION_PROFILES.storm!.count).toBeGreaterThan(
      PRECIPITATION_PROFILES.rain!.count,
    );
    // Only snow sways; a streak that swayed would smear.
    expect(PRECIPITATION_PROFILES.rain!.swayCells).toBe(0);
    expect(PRECIPITATION_PROFILES.snow!.swayCells).toBeGreaterThan(0);
  });
});

describe('the fog bank', () => {
  it('stays below the height a player can raise land clear of it', () => {
    // Fog fills valleys and shoreline flats; it is not scene fog and must not
    // swallow a mountain. Three bands of sculpting puts land above the top sheet.
    for (const layer of FOG_LAYERS) {
      expect(layer.height + layer.bobUnits).toBeLessThan(3);
      expect(layer.opacity).toBeGreaterThan(0);
      expect(layer.radiusScale).toBeGreaterThan(0);
      expect(layer.radiusScale).toBeLessThanOrEqual(1);
    }
  });

  it('never lets two sheets share a spin or bob rate', () => {
    const spins = FOG_LAYERS.map((layer) => layer.spinHz);
    const bobs = FOG_LAYERS.map((layer) => layer.bobHz);
    expect(new Set(spins).size).toBe(spins.length);
    expect(new Set(bobs).size).toBe(bobs.length);
    // Slow enough to be invisible frame to frame: every period is tens of
    // seconds, which is also why none of it is a photosensitivity concern.
    for (const rate of [...spins, ...bobs]) expect(Math.abs(rate)).toBeLessThan(0.05);
  });

  it('tears the outline without ever inverting it', () => {
    for (let step = 0; step < 360; step++) {
      const wobble = fogEdgeWobble((step / 360) * Math.PI * 2);
      expect(wobble).toBeGreaterThan(0.5);
      expect(wobble).toBeLessThan(1.5);
    }
  });
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
    const governor = new LightningGovernor();
    // A source pinned at 0 asks for the shortest interval the sampler can give,
    // which is exactly the case the floor exists for.
    const schedule = new LightningSchedule(() => 0);
    const dt = 1 / 60;
    let sinceLast = Number.POSITIVE_INFINITY;
    let flashes = 0;

    for (let frame = 0; frame < 60 * 600; frame++) {
      governor.advance(dt);
      const flash = schedule.advance(dt, true, governor);
      sinceLast += dt;
      if (flash !== null) {
        expect(sinceLast).toBeGreaterThanOrEqual(MIN_FLASH_INTERVAL_SECONDS - 1e-9);
        expect(flash.reach).toBeLessThanOrEqual(BOLT_MAX_REACH_FRACTION);
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
    const schedules = [0, 1, 2].map(() => new LightningSchedule(() => 0));
    const dt = 1 / 60;
    let sinceLast = Number.POSITIVE_INFINITY;
    let flashes = 0;

    for (let frame = 0; frame < 60 * 600; frame++) {
      governor.advance(dt);
      sinceLast += dt;
      for (const schedule of schedules) {
        if (schedule.advance(dt, true, governor) === null) continue;
        expect(sinceLast).toBeGreaterThanOrEqual(MIN_FLASH_INTERVAL_SECONDS - 1e-9);
        sinceLast = 0;
        flashes++;
      }
    }
    expect(flashes).toBeGreaterThan(0);
    // No more flashes than the floor physically allows in ten minutes.
    expect(flashes).toBeLessThanOrEqual(600 / MIN_FLASH_INTERVAL_SECONDS + 1);
  });

  it('starts nothing at all when the caller is not armed', () => {
    const governor = new LightningGovernor();
    const schedule = new LightningSchedule(() => 0);
    for (let frame = 0; frame < 60 * 600; frame++) {
      governor.advance(1 / 60);
      expect(schedule.advance(1 / 60, false, governor)).toBeNull();
    }
    // …and the governor was never touched, so the first armed frame afterwards
    // is free to flash rather than being held back by phantom suppressions.
    expect(governor.secondsSinceLastFlash()).toBe(Number.POSITIVE_INFINITY);
  });

  it('fires at most once for one enormous frame, never a backlog burst', () => {
    const governor = new LightningGovernor();
    const schedule = new LightningSchedule(() => 0);
    governor.advance(600);
    const first = schedule.advance(600, true, governor);
    expect(first).not.toBeNull();
    // The very next frame is inside the floor, so nothing can follow it.
    governor.advance(1 / 60);
    expect(schedule.advance(1 / 60, true, governor)).toBeNull();
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
    // storm and is handed to whatever system acquires the rig next. If release()
    // did not reset it, a schedule freed while still inside FLASH_DURATION_SECONDS
    // of its last real flash would carry that brightness straight into the new
    // storm's first frame — a flash the governor never approved. This is the test
    // for the fix, not just the symptom: it checks brightness() goes to 0 the
    // INSTANT reset() is called, with no advance() in between to decay it away.
    const governor = new LightningGovernor();
    governor.advance(MEAN_FLASH_INTERVAL_SECONDS * 10);
    const schedule = new LightningSchedule(() => 0);

    const started = schedule.advance(MEAN_FLASH_INTERVAL_SECONDS * 10, true, governor);
    expect(started).not.toBeNull();
    // Move partway through the flash's decay — armed false, so this only ages
    // `sinceFlash` and proposes nothing new, exactly like a rig whose storm has
    // already dissipated (rig.ts: `if (!lit) return;` stops calling advance() at
    // all once intensity hits 0, so age freezes rather than resets on its own).
    schedule.advance(FLASH_ATTACK_SECONDS * 2, false, governor);
    expect(schedule.brightness()).toBeGreaterThan(0);

    schedule.reset();
    // No advance() call here — this is the pool handing the rig to a brand-new
    // storm before a single frame has run.
    expect(schedule.brightness()).toBe(0);

    // The redrawn wait also respects the photosensitivity floor: the very next
    // frame cannot propose a flash the governor would have to refuse.
    const immediate = schedule.advance(1 / 60, true, governor);
    expect(immediate).toBeNull();
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
