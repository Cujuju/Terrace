import { cellsAcross } from '@terrace/shared';
import { randomInRange, randomSigned, weatherRandom } from './rng.ts';

export const WIND_MIN_SPEED_CELLS_PER_SECOND = cellsAcross(0.6);
export const WIND_MAX_SPEED_CELLS_PER_SECOND = cellsAcross(2);

export const WIND_VEER_RADIANS_PER_SECOND = 0.01;

export const WIND_SPEED_DRIFT_CELLS_PER_SECOND_SQUARED = cellsAcross(0.05);

export interface Wind {
  heading: number;
  speed: number;
}

let wind: Wind = { heading: 0, speed: 0 };

export function currentWind(): Readonly<Wind> {
  return wind;
}

export function windVelocity(): { vx: number; vy: number } {
  return {
    vx: Math.cos(wind.heading) * wind.speed,
    vy: Math.sin(wind.heading) * wind.speed,
  };
}

export function resetWind(): void {
  wind = {
    heading: weatherRandom() * Math.PI * 2,
    speed: randomInRange(WIND_MIN_SPEED_CELLS_PER_SECOND, WIND_MAX_SPEED_CELLS_PER_SECOND),
  };
}

resetWind();

export function advanceWind(dt: number): void {
  wind.heading += randomSigned(WIND_VEER_RADIANS_PER_SECOND) * dt;
  const twoPi = Math.PI * 2;
  wind.heading = ((wind.heading % twoPi) + twoPi) % twoPi;

  const speed = wind.speed + randomSigned(WIND_SPEED_DRIFT_CELLS_PER_SECOND_SQUARED) * dt;
  wind.speed = Math.min(
    WIND_MAX_SPEED_CELLS_PER_SECOND,
    Math.max(WIND_MIN_SPEED_CELLS_PER_SECOND, speed),
  );
}
