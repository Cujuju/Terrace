// The client half's PURE logic: payload validation, interpolation and the fall
// maths.
//
// These are the pre-split weather suite's `parseSystemsPayload`,
// `WeatherInterpolator` and `the falling column` blocks. The first two now cover
// code that lives in @terrace/shared and in core's client kit — four plugins
// share one disc payload and one interpolator — and they are asserted from here
// because this is the plugin whose halves they join.
//
// Rendering is verified by eye per design doc ("no headless GL rig"), so nothing
// here imports three, which is also what lets it run in the same node
// environment as the server tests.

import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  MAX_HEIGHT,
  WORLD_UNITS_PER_BAND,
  roundBroadcastIntensity,
  roundBroadcastPosition,
} from '@terrace/shared';
import { parseDiscSystemsPayload, type DiscSystemState } from '../protocol.ts';
import {
  DEFAULT_INTERPOLATION_SECONDS,
  DiscInterpolator,
  MAX_INTERPOLATION_SECONDS,
  MIN_INTERPOLATION_SECONDS,
} from '../../../client/src/plugins/kit/discInterpolator.ts';
import {
  CLOUD_BASE_WORLD_Y,
  MAX_GROUND_WORLD_Y,
  PRECIPITATION_COLUMN_WORLD_UNITS,
  PRECIPITATION_FLOOR_WORLD_Y,
  driftSeconds,
  fallFraction,
} from '../../../client/src/plugins/kit/precipitation.ts';
import { RAIN_DROP_COUNT, RAIN_PROFILE } from '../client/rig.ts';

function system(id: number, overrides: Partial<DiscSystemState> = {}): DiscSystemState {
  return { id, x: 0, y: 0, radius: 30, intensity: 1, vx: 0, vy: 0, ...overrides };
}

// ── The wire ─────────────────────────────────────────────────────────────────

describe('parseDiscSystemsPayload', () => {
  it('accepts a well-formed payload unchanged', () => {
    const payload = { systems: [system(1), system(2, { radius: 12 })] };
    expect(parseDiscSystemsPayload(payload)).toEqual(payload.systems);
  });

  it('reads an empty list as a clear sky, not as a failure', () => {
    expect(parseDiscSystemsPayload({ systems: [] })).toEqual([]);
  });

  it('returns null for anything that is not a system list', () => {
    expect(parseDiscSystemsPayload(null)).toBeNull();
    expect(parseDiscSystemsPayload(42)).toBeNull();
    expect(parseDiscSystemsPayload({})).toBeNull();
    expect(parseDiscSystemsPayload({ systems: 'rain' })).toBeNull();
  });

  it('drops malformed entries individually and keeps the rest', () => {
    const good = system(1);
    const parsed = parseDiscSystemsPayload({
      systems: [
        good,
        null,
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
    const parsed = parseDiscSystemsPayload({
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

describe('DiscInterpolator', () => {
  it('walks the centre between two broadcasts and clamps at the end', () => {
    const interpolator = new DiscInterpolator();
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
    const interpolator = new DiscInterpolator();
    interpolator.receive([system(1, { radius: 20, intensity: 0 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([system(1, { radius: 40, intensity: 1 })]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);

    const sampled = interpolator.sample().get(1)!;
    expect(sampled.radius).toBeCloseTo(30, 9);
    expect(sampled.intensity).toBeCloseTo(0.5, 9);
  });

  it('places a first-seen system exactly where the server says it is', () => {
    const interpolator = new DiscInterpolator();
    interpolator.receive([system(9, { x: 123, y: 456 })]);
    const sampled = interpolator.sample().get(9)!;
    expect(sampled.x).toBe(123);
    expect(sampled.y).toBe(456);
  });

  it('drops a system the moment it leaves the list', () => {
    const interpolator = new DiscInterpolator();
    interpolator.receive([system(1), system(2)]);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive([system(1)]);
    expect(interpolator.sample().has(2)).toBe(false);
  });

  it('measures the window and clamps it into the documented band', () => {
    const interpolator = new DiscInterpolator();
    interpolator.receive([system(1, { x: 0 })]);
    // A stall far longer than the ceiling must not become the window.
    interpolator.advance(60);
    interpolator.receive([system(1, { x: 10 })]);
    interpolator.advance(MAX_INTERPOLATION_SECONDS);
    expect(interpolator.progress()).toBe(1);

    // …and a burst far shorter than the floor must not either.
    const fast = new DiscInterpolator();
    fast.receive([system(1, { x: 0 })]);
    fast.advance(1e-9);
    fast.receive([system(1, { x: 10 })]);
    fast.advance(MIN_INTERPOLATION_SECONDS);
    expect(fast.progress()).toBe(1);
  });

  it('starts the next segment from the RENDERED pose, not the last message', () => {
    const interpolator = new DiscInterpolator();
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
    const interpolator = new DiscInterpolator();
    interpolator.receive([system(1)]);
    interpolator.clear();
    expect(interpolator.sample().size).toBe(0);
  });
});

// ── The vertical layout, and the fall ────────────────────────────────────────

describe('the falling column', () => {
  it('derives the cloud base from the shared height constants', () => {
    // The ceiling in BANDS times what a band draws — the quotient alone was
    // world units only while a band drew one world unit.
    expect(MAX_GROUND_WORLD_Y).toBe((MAX_HEIGHT / BAND_HEIGHT) * WORLD_UNITS_PER_BAND);
    // Clear sky above the tallest possible mountain, at the worst case.
    expect(CLOUD_BASE_WORLD_Y).toBeGreaterThan(MAX_GROUND_WORLD_Y);
    // The column reaches past a fresh world's open-sea floor (three bands down)
    // so precipitation visibly meets the ground everywhere.
    expect(PRECIPITATION_FLOOR_WORLD_Y).toBeLessThan(-3);
    expect(PRECIPITATION_COLUMN_WORLD_UNITS).toBe(
      CLOUD_BASE_WORLD_Y - PRECIPITATION_FLOOR_WORLD_Y,
    );
  });

  it('wraps every particle into [0, 1) for any elapsed time', () => {
    const speed = RAIN_PROFILE.fallSpeed;
    for (const elapsed of [0, 0.016, 1, 3600, 86400, -5]) {
      for (const birth of [0, 0.25, 0.999999]) {
        const fraction = fallFraction(elapsed, birth, speed);
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThan(1);
      }
    }
  });

  it('advances a particle down the column at exactly its fall speed', () => {
    const speed = RAIN_PROFILE.fallSpeed;
    expect(fallFraction(0, 0, speed)).toBe(0);
    expect(fallFraction(1, 0, speed) * PRECIPITATION_COLUMN_WORLD_UNITS).toBeCloseTo(speed, 9);
  });

  it('spreads particles through the column by their birth phase', () => {
    const speed = RAIN_PROFILE.fallSpeed;
    expect(fallFraction(0, 0.25, speed)).toBeCloseTo(0.25, 12);
    expect(fallFraction(0, 0.75, speed)).toBeCloseTo(0.75, 12);
  });

  it('carries a drop across the whole column in the time the column takes', () => {
    expect(driftSeconds(1, RAIN_PROFILE.fallSpeed)).toBeCloseTo(
      PRECIPITATION_COLUMN_WORLD_UNITS / RAIN_PROFILE.fallSpeed,
      9,
    );
  });

  it('draws rain as streaks that do not sway — a swaying streak would smear', () => {
    expect(RAIN_PROFILE.form).toBe('streak');
    expect(RAIN_PROFILE.swayCells).toBe(0);
    expect(RAIN_PROFILE.count).toBe(RAIN_DROP_COUNT);
  });
});
