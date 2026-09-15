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

function insideWorld(cell: number, worldSize: number): boolean {
  return cell >= 0 && cell < worldSize;
}

// Samples that fall off the map are dropped, not clamped: a disc straddling
// the edge is judged by the ground actually under it.
export function meanUnlockedHeightUnder(
  world: SnowWorld,
  centreX: number,
  centreY: number,
  radius: number,
): number | null {
  let total = 0;
  let counted = 0;
  for (const [offsetX, offsetY] of SNOW_ELEVATION_SAMPLE_OFFSETS) {
    const x = Math.floor(centreX + offsetX * radius);
    const y = Math.floor(centreY + offsetY * radius);
    if (!insideWorld(x, world.worldSize) || !insideWorld(y, world.worldSize)) continue;
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
