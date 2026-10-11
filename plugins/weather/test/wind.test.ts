import { beforeEach, describe, expect, it } from 'vitest';
import { createSeededRng } from '@terrace/shared';
import { plugin as weatherPlugin, currentWind, resetWeatherState } from '../server/index.ts';
import {
  WIND_MAX_SPEED_CELLS_PER_SECOND,
  WIND_MIN_SPEED_CELLS_PER_SECOND,
  advanceWind,
  maxHeadingStepFor,
  resetWind,
} from '../server/wind.ts';
import { setWeatherRandomSource } from '../server/rng.ts';

const TICK_SECONDS = 0.1;
const SEED = 20260814;

beforeEach(() => {
  setWeatherRandomSource(createSeededRng(SEED).next);
  resetWeatherState();
});

function signedDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function unwrappedDriftOver(ticks: number, dt: number): number {
  let previous = currentWind().heading;
  let drift = 0;
  for (let tick = 0; tick < ticks; tick++) {
    advanceWind(dt);
    const heading = currentWind().heading;
    drift += signedDelta(previous, heading);
    previous = heading;
  }
  return drift;
}

describe('the world wind', () => {
  it('keeps its speed inside the band and veers it slowly', () => {
    let previousHeading = currentWind().heading;
    const maxStep = maxHeadingStepFor(TICK_SECONDS);

    for (let tick = 0; tick < 20000; tick++) {
      advanceWind(TICK_SECONDS);
      const wind = currentWind();
      expect(wind.speed).toBeGreaterThanOrEqual(WIND_MIN_SPEED_CELLS_PER_SECOND);
      expect(wind.speed).toBeLessThanOrEqual(WIND_MAX_SPEED_CELLS_PER_SECOND);
      expect(Math.abs(signedDelta(previousHeading, wind.heading))).toBeLessThanOrEqual(
        maxStep + 1e-12,
      );
      previousHeading = wind.heading;
    }
  });

  it('actually moves: an hour of ticks changes the heading', () => {
    const start = currentWind().heading;
    let moved = 0;
    for (let tick = 0; tick < 36000; tick++) {
      advanceWind(TICK_SECONDS);
      moved = Math.max(moved, Math.abs(signedDelta(start, currentWind().heading)));
    }
    expect(moved).toBeGreaterThan(maxHeadingStepFor(TICK_SECONDS) * 10);
  });

  it('spreads the same over an hour whatever the tick rate', () => {
    const HOUR_SECONDS = 3600;
    const SAMPLES = 24;
    function rmsDriftAt(dt: number): number {
      let sumSquares = 0;
      for (let sample = 0; sample < SAMPLES; sample++) {
        setWeatherRandomSource(createSeededRng(SEED + sample).next);
        resetWind();
        const drift = unwrappedDriftOver(Math.round(HOUR_SECONDS / dt), dt);
        sumSquares += drift * drift;
      }
      return Math.sqrt(sumSquares / SAMPLES);
    }
    const slow = rmsDriftAt(1);
    const fast = rmsDriftAt(1 / 60);
    expect(slow / fast).toBeGreaterThan(0.5);
    expect(slow / fast).toBeLessThan(2);
  });

  it('holds the heading in [0, 2π) however long the world runs', () => {
    for (let tick = 0; tick < 20000; tick++) advanceWind(TICK_SECONDS);
    expect(currentWind().heading).toBeGreaterThanOrEqual(0);
    expect(currentWind().heading).toBeLessThan(Math.PI * 2);
  });

  it('ignores a tick it cannot use rather than poisoning the heading', () => {
    const before = currentWind();
    advanceWind(Number.NaN);
    advanceWind(Number.POSITIVE_INFINITY);
    advanceWind(0);
    advanceWind(-1);
    expect(currentWind()).toEqual(before);
    advanceWind(TICK_SECONDS);
    expect(Number.isFinite(currentWind().heading)).toBe(true);
  });

  it('draws a fresh wind on world create rather than continuing the last one', () => {
    const firstDraw = { ...currentWind() };
    for (let tick = 0; tick < 100; tick++) advanceWind(TICK_SECONDS);
    expect(currentWind()).not.toEqual(firstDraw);

    setWeatherRandomSource(createSeededRng(SEED).next);
    weatherPlugin.onWorldCreate?.({} as never);
    expect(currentWind()).toEqual(firstDraw);
  });

  it('hands out a copy: a holder can neither steer the hub nor go stale', () => {
    const held = currentWind() as { heading: number; speed: number };
    held.speed = 99999;
    expect(currentWind().speed).toBeLessThanOrEqual(WIND_MAX_SPEED_CELLS_PER_SECOND);
    resetWind();
    expect(held.speed).toBe(99999);
  });
});

describe('the hub as a plugin', () => {
  it('has no wire, no persistence, no actions and never touches the world', () => {
    expect(weatherPlugin.persistence).toBeUndefined();
    expect(weatherPlugin.actions).toBeUndefined();
    expect(weatherPlugin.onIntent).toBeUndefined();
    expect(weatherPlugin.onTerrainChanged).toBeUndefined();
  });
});
