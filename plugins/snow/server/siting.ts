import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';

export interface SnowWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

export const SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA = 2;

export const SNOW_MIN_TERRAIN_HEIGHT =
  SEA_LEVEL + SNOW_MIN_TERRAIN_BANDS_ABOVE_SEA * BAND_HEIGHT;

export const SNOW_ELEVATION_SAMPLE_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.5, 0],
  [-0.5, 0],
  [0, 0.5],
  [0, -0.5],
];

export const SNOW_ELEVATION_SAMPLES = SNOW_ELEVATION_SAMPLE_OFFSETS.length;

function clampCell(value: number, worldSize: number): number {
  const cell = Math.floor(value);
  if (cell < 0) return 0;
  if (cell > worldSize - 1) return worldSize - 1;
  return cell;
}

export function meanUnlockedHeightUnder(
  world: SnowWorld,
  centreX: number,
  centreY: number,
  radius: number,
): number | null {
  let total = 0;
  let counted = 0;
  for (const [offsetX, offsetY] of SNOW_ELEVATION_SAMPLE_OFFSETS) {
    const x = clampCell(centreX + offsetX * radius, world.worldSize);
    const y = clampCell(centreY + offsetY * radius, world.worldSize);
    if (!world.isCellUnlocked(x, y)) continue;
    total += world.heightAt(x, y);
    counted++;
  }
  return counted === 0 ? null : total / counted;
}

export function isSnowSite(
  world: SnowWorld,
  centreX: number,
  centreY: number,
  radius: number,
): boolean {
  const mean = meanUnlockedHeightUnder(world, centreX, centreY, radius);
  return mean !== null && mean >= SNOW_MIN_TERRAIN_HEIGHT;
}
