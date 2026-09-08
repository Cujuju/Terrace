import { beforeEach, describe, expect, it } from 'vitest';
import { createSeededRng } from '@terrace/shared';
import { plugin as weatherPlugin, currentWind, resetWeatherState } from '../server/index.ts';
import {
  WIND_MAX_SPEED_CELLS_PER_SECOND,
  WIND_MIN_SPEED_CELLS_PER_SECOND,
  WIND_VEER_RADIANS_PER_SECOND,
  advanceWind,
} from '../server/wind.ts';
import { setWeatherRandomSource } from '../server/rng.ts';

const TICK_SECONDS = 0.1;

beforeEach(() => {
  setWeatherRandomSource(createSeededRng(20260814).next);
  resetWeatherState();
});

describe('the world wind', () => {
  it('keeps its speed inside the band and veers it slowly', () => {
    let previousHeading = currentWind().heading;
    const maxVeerPerTick = WIND_VEER_RADIANS_PER_SECOND * TICK_SECONDS;

    for (let tick = 0; tick < 20000; tick++) {
      advanceWind(TICK_SECONDS);
      const wind = currentWind();
      expect(wind.speed).toBeGreaterThanOrEqual(WIND_MIN_SPEED_CELLS_PER_SECOND);
      expect(wind.speed).toBeLessThanOrEqual(WIND_MAX_SPEED_CELLS_PER_SECOND);

      let delta = (wind.heading - previousHeading) % (Math.PI * 2);
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      expect(Math.abs(delta)).toBeLessThanOrEqual(maxVeerPerTick + 1e-12);
      previousHeading = wind.heading;
    }
  });

  it('holds the heading in [0, 2π) however long the world runs', () => {
    for (let tick = 0; tick < 20000; tick++) advanceWind(TICK_SECONDS);
    expect(currentWind().heading).toBeGreaterThanOrEqual(0);
    expect(currentWind().heading).toBeLessThan(Math.PI * 2);
  });

  it('draws a fresh wind on world create rather than continuing the last one', () => {
    const before = { ...currentWind() };
    for (let tick = 0; tick < 100; tick++) advanceWind(TICK_SECONDS);
    weatherPlugin.onWorldCreate?.({} as never);
    const after = currentWind();
    expect(after.heading).not.toBe(before.heading);
    expect(after.speed).toBeGreaterThanOrEqual(WIND_MIN_SPEED_CELLS_PER_SECOND);
    expect(after.speed).toBeLessThanOrEqual(WIND_MAX_SPEED_CELLS_PER_SECOND);
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
