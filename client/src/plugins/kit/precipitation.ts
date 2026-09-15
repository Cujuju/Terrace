import { BAND_HEIGHT, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, WORLD_UNITS_PER_BAND } from '@terrace/shared';

const WORLD_UNIT_HEIGHT_UNITS = MAX_HEIGHT / MAX_RELIEF_WORLD_UNITS;

export const MAX_GROUND_WORLD_Y = (MAX_HEIGHT / BAND_HEIGHT) * WORLD_UNITS_PER_BAND;

export const CLOUD_HEADROOM_WORLD_UNITS = MAX_GROUND_WORLD_Y / 2;

export const CLOUD_BASE_WORLD_Y = MAX_GROUND_WORLD_Y + CLOUD_HEADROOM_WORLD_UNITS;

const FRESH_SEABED_DEPTH_BELOW_SEA = 192;
const PRECIPITATION_FLOOR_CLEARANCE = WORLD_UNIT_HEIGHT_UNITS / 4;
export const PRECIPITATION_FLOOR_BANDS_BELOW_SEA =
  (FRESH_SEABED_DEPTH_BELOW_SEA + PRECIPITATION_FLOOR_CLEARANCE) / BAND_HEIGHT;

export const PRECIPITATION_FLOOR_WORLD_Y =
  -PRECIPITATION_FLOOR_BANDS_BELOW_SEA * WORLD_UNITS_PER_BAND;

export const PRECIPITATION_COLUMN_WORLD_UNITS =
  CLOUD_BASE_WORLD_Y - PRECIPITATION_FLOOR_WORLD_Y;

export interface PrecipitationProfile {
  readonly form: 'streak' | 'flake';
  readonly count: number;
  readonly fallSpeed: number;
  readonly streakLength: number;
  readonly spriteSize: number;
  readonly opacity: number;
  readonly color: number;
  readonly swayCells: number;
  readonly swayHz: number;
  readonly innerRadiusFraction: number;
}

export function seedRadius(u: number, innerRadiusFraction: number): number {
  const innerArea = innerRadiusFraction * innerRadiusFraction;
  return Math.sqrt(innerArea + u * (1 - innerArea));
}

export function fallFraction(
  elapsedSeconds: number,
  birth: number,
  fallSpeed: number,
): number {
  const cycles = birth + (elapsedSeconds * fallSpeed) / PRECIPITATION_COLUMN_WORLD_UNITS;
  return ((cycles % 1) + 1) % 1;
}

export function driftSeconds(fraction: number, fallSpeed: number): number {
  return (fraction * PRECIPITATION_COLUMN_WORLD_UNITS) / fallSpeed;
}
