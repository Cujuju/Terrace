import { cellsAcross } from '@terrace/shared';
import { DEFAULT_TICK_HZ } from '../../../server/src/config.ts';
import { randomInRange, randomSigned, weatherRandom } from './rng.ts';

export const WIND_MIN_SPEED_CELLS_PER_SECOND = cellsAcross(0.6);
export const WIND_MAX_SPEED_CELLS_PER_SECOND = cellsAcross(2);

// Zero-mean random walk; steps scale with √dt so spread is TICK_HZ-independent.
// Magnitudes reproduce the per-tick jitter tuned at the default rate.
const REFERENCE_TICK_SECONDS = 1 / DEFAULT_TICK_HZ;

export const WIND_HEADING_JITTER_RADIANS_PER_SQRT_SECOND =
  0.01 * Math.sqrt(REFERENCE_TICK_SECONDS);

export const WIND_SPEED_JITTER_CELLS_PER_SECOND_PER_SQRT_SECOND =
  cellsAcross(0.05) * Math.sqrt(REFERENCE_TICK_SECONDS);

export interface Wind {
  heading: number;
  speed: number;
}

const wind: Wind = { heading: 0, speed: 0 };

export function currentWind(): Readonly<Wind> {
  return { heading: wind.heading, speed: wind.speed };
}

export function windVelocity(): { vx: number; vy: number } {
  return {
    vx: Math.cos(wind.heading) * wind.speed,
    vy: Math.sin(wind.heading) * wind.speed,
  };
}

export function resetWind(): void {
  wind.heading = weatherRandom() * Math.PI * 2;
  wind.speed = randomInRange(WIND_MIN_SPEED_CELLS_PER_SECOND, WIND_MAX_SPEED_CELLS_PER_SECOND);
}

export function maxHeadingStepFor(dt: number): number {
  return WIND_HEADING_JITTER_RADIANS_PER_SQRT_SECOND * Math.sqrt(dt);
}

export function advanceWind(dt: number): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  const rootDt = Math.sqrt(dt);

  const twoPi = Math.PI * 2;
  const heading = wind.heading + randomSigned(WIND_HEADING_JITTER_RADIANS_PER_SQRT_SECOND) * rootDt;
  wind.heading = ((heading % twoPi) + twoPi) % twoPi;

  const speed = wind.speed + randomSigned(WIND_SPEED_JITTER_CELLS_PER_SECOND_PER_SQRT_SECOND) * rootDt;
  wind.speed = Math.min(
    WIND_MAX_SPEED_CELLS_PER_SECOND,
    Math.max(WIND_MIN_SPEED_CELLS_PER_SECOND, speed),
  );
}
