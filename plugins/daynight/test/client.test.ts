import { describe, expect, it } from 'vitest';
import {
  DAY_LENGTH_SECONDS,
  DAYNIGHT_PHASE_DECIMALS,
  parseClockPayload,
  roundBroadcastPhase,
  wrapPhase,
} from '../protocol.ts';
import {
  DEFAULT_INTERPOLATION_SECONDS,
  DayNightInterpolator,
  MAX_INTERPOLATION_SECONDS,
  MIN_INTERPOLATION_SECONDS,
  lerpPhase,
} from '../client/interpolation.ts';
import { NIGHT_FLOOR_INTENSITY, skyStateAtPhase, sunHeight } from '../client/sky.ts';

describe('wrapPhase', () => {
  it('wraps any finite value into [0, 1)', () => {
    expect(wrapPhase(0)).toBe(0);
    expect(wrapPhase(0.5)).toBe(0.5);
    expect(wrapPhase(1)).toBe(0);
    expect(wrapPhase(1.25)).toBeCloseTo(0.25, 12);
    expect(wrapPhase(-0.25)).toBeCloseTo(0.75, 12);
    expect(wrapPhase(-1)).toBe(0);
    expect(wrapPhase(3.5)).toBeCloseTo(0.5, 12);
  });
});

describe('roundBroadcastPhase', () => {
  it('quantises to DAYNIGHT_PHASE_DECIMALS and wraps', () => {
    expect(roundBroadcastPhase(0.123456)).toBeCloseTo(0.1235, DAYNIGHT_PHASE_DECIMALS);
    expect(roundBroadcastPhase(1.5)).toBeCloseTo(0.5, DAYNIGHT_PHASE_DECIMALS);
    expect(roundBroadcastPhase(-0.25)).toBeCloseTo(0.75, DAYNIGHT_PHASE_DECIMALS);
  });
});

describe('parseClockPayload', () => {
  it('accepts a well-formed payload, wrapped', () => {
    expect(parseClockPayload({ phase: 0.42 })).toEqual({
      phase: 0.42,
      day: null,
      genesisDay: null,
    });
    expect(parseClockPayload({ phase: 1.25 })).toEqual({
      phase: 0.25,
      day: null,
      genesisDay: null,
    });
  });

  it('returns null for anything that is not a finite phase', () => {
    expect(parseClockPayload(null)).toBeNull();
    expect(parseClockPayload(42)).toBeNull();
    expect(parseClockPayload({})).toBeNull();
    expect(parseClockPayload({ phase: 'dawn' })).toBeNull();
    expect(parseClockPayload({ phase: Number.NaN })).toBeNull();
    expect(parseClockPayload({ phase: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('DAY_LENGTH_SECONDS', () => {
  it('is a positive, sane cycle length', () => {
    expect(DAY_LENGTH_SECONDS).toBe(24 * 60);
    expect(DAY_LENGTH_SECONDS).toBeGreaterThan(0);
  });
});

describe('sunHeight', () => {
  it('peaks at noon, crosses zero at both horizons, bottoms at midnight', () => {
    expect(sunHeight(0)).toBeCloseTo(0, 9);
    expect(sunHeight(0.25)).toBeCloseTo(1, 9);
    expect(sunHeight(0.5)).toBeCloseTo(0, 9);
    expect(sunHeight(0.75)).toBeCloseTo(-1, 9);
    expect(sunHeight(1.25)).toBeCloseTo(1, 9);
    expect(sunHeight(-0.75)).toBeCloseTo(1, 9);
  });
});

describe('skyStateAtPhase', () => {
  it('reproduces scene.ts\'s exact noon anchor at phase 0.25', () => {
    const state = skyStateAtPhase(0.25);
    expect(state.sunIntensity).toBeCloseTo(1.2, 9);
    expect(state.hemisphereIntensity).toBeCloseTo(1.5, 9);
    expect(state.ambientIntensity).toBeCloseTo(0.9, 9);
    expect(state.hemisphereSkyColor).toBe(0x9fc7e8);
    expect(state.hemisphereGroundColor).toBe(0x9a948a);
    expect(state.backgroundColor).toBe(0x9fc7e8);
    expect(state.sunColor).toBe(0xffffff);
    expect(state.ambientColor).toBe(0xffffff);

    const { x, y, z } = state.sunDirection;
    const magnitude = Math.hypot(x, y, z);
    expect(magnitude).toBeCloseTo(1, 9);
    expect(x / y).toBeCloseTo(0.7 / 0.45, 6);
    expect(z / y).toBeCloseTo(0.55 / 0.45, 6);
  });

  it('turns the sun fully off, and floors the ambient, at midnight (phase 0.75)', () => {
    const state = skyStateAtPhase(0.75);
    expect(state.sunIntensity).toBe(0);
    expect(state.ambientIntensity).toBeCloseTo(NIGHT_FLOOR_INTENSITY, 9);
    expect(NIGHT_FLOOR_INTENSITY).toBeGreaterThan(0);
    expect(NIGHT_FLOOR_INTENSITY).toBeLessThan(0.9);
    expect(state.hemisphereIntensity).toBeGreaterThan(0);
    expect(state.hemisphereIntensity).toBeLessThan(1.5);
  });

  it('the sun still points somewhere at midnight, below the horizon', () => {
    const { x, y, z } = skyStateAtPhase(0.75).sunDirection;
    expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
    expect(y).toBeLessThan(0);
  });

  it('both horizon crossings (dawn and dusk) land on the identical warm keyframe', () => {
    const dawn = skyStateAtPhase(0);
    const dusk = skyStateAtPhase(0.5);
    expect(dawn.hemisphereSkyColor).toBe(dusk.hemisphereSkyColor);
    expect(dawn.backgroundColor).toBe(dusk.backgroundColor);
    expect(dawn.sunColor).toBe(dusk.sunColor);
    expect(dawn.ambientColor).toBe(dusk.ambientColor);
    expect(dawn.sunIntensity).toBeCloseTo(dusk.sunIntensity, 9);
    expect(dawn.ambientIntensity).toBeCloseTo(dusk.ambientIntensity, 9);
    expect(dawn.hemisphereIntensity).toBeCloseTo(dusk.hemisphereIntensity, 9);
    const noonSky = skyStateAtPhase(0.25).hemisphereSkyColor;
    const horizonSky = dawn.hemisphereSkyColor;
    const redOf = (c: number): number => (c >> 16) & 0xff;
    const blueOf = (c: number): number => c & 0xff;
    expect(redOf(horizonSky)).toBeGreaterThan(redOf(noonSky));
    expect(blueOf(horizonSky)).toBeLessThan(blueOf(noonSky));
  });

  it('is continuous everywhere — no discontinuity at a keyframe boundary', () => {
    const epsilon = 1e-4;
    for (let step = 0; step < 2000; step++) {
      const phase = step / 2000;
      const a = skyStateAtPhase(phase);
      const b = skyStateAtPhase(wrapPhase(phase + epsilon));
      expect(Math.abs(a.sunIntensity - b.sunIntensity)).toBeLessThan(0.01);
      expect(Math.abs(a.ambientIntensity - b.ambientIntensity)).toBeLessThan(0.01);
      expect(Math.abs(a.hemisphereIntensity - b.hemisphereIntensity)).toBeLessThan(0.01);
    }
  });
});

describe('lerpPhase', () => {
  it('walks the plain way when there is no wrap to consider', () => {
    expect(lerpPhase(0.2, 0.4, 0.5)).toBeCloseTo(0.3, 9);
    expect(lerpPhase(0.2, 0.4, 0)).toBeCloseTo(0.2, 9);
    expect(lerpPhase(0.2, 0.4, 1)).toBeCloseTo(0.4, 9);
  });

  it('goes the SHORT way round the cycle at the wraparound boundary', () => {
    expect(lerpPhase(0.95, 0.05, 0.5)).toBeCloseTo(0, 9);
    expect(lerpPhase(0.95, 0.05, 1)).toBeCloseTo(0.05, 9);
    const result = lerpPhase(0.05, 0.95, 0.5);
    expect(Math.min(result, 1 - result)).toBeLessThan(1e-9);
  });
});

describe('DayNightInterpolator', () => {
  it('walks toward the newest phase and clamps at the end of the window', () => {
    const interpolator = new DayNightInterpolator();
    interpolator.receive(0.1);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive(0.3);

    expect(interpolator.samplePhase()).toBeCloseTo(0.1, 9);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.samplePhase()).toBeCloseTo(0.2, 9);

    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS * 10);
    expect(interpolator.samplePhase()).toBe(0.3);
    expect(interpolator.progress()).toBe(1);
  });

  it('places a first-seen phase exactly where the server says it is', () => {
    const interpolator = new DayNightInterpolator();
    interpolator.receive(0.77);
    expect(interpolator.samplePhase()).toBe(0.77);
  });

  it('measures the window and clamps it into the documented band', () => {
    const interpolator = new DayNightInterpolator();
    interpolator.receive(0);
    interpolator.advance(60);
    interpolator.receive(0.1);
    interpolator.advance(MAX_INTERPOLATION_SECONDS);
    expect(interpolator.progress()).toBe(1);

    const fast = new DayNightInterpolator();
    fast.receive(0);
    fast.advance(1e-9);
    fast.receive(0.1);
    fast.advance(MIN_INTERPOLATION_SECONDS);
    expect(fast.progress()).toBe(1);
  });

  it('starts the next segment from the RENDERED phase, not the last message', () => {
    const interpolator = new DayNightInterpolator();
    interpolator.receive(0);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive(0.4);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 4);
    expect(interpolator.samplePhase()).toBeCloseTo(0.1, 9);
    interpolator.receive(0.6);
    expect(interpolator.samplePhase()).toBeCloseTo(0.1, 9);
  });

  it('interpolates FORWARD through the midnight seam, never backward through noon', () => {
    const interpolator = new DayNightInterpolator();
    interpolator.receive(0.98);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS);
    interpolator.receive(0.02);
    interpolator.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(interpolator.samplePhase()).toBeCloseTo(0, 9);
  });

  it('forgets everything on clear', () => {
    const interpolator = new DayNightInterpolator();
    interpolator.receive(0.5);
    interpolator.clear();
    expect(interpolator.samplePhase()).toBe(0);
  });
});
