import { drawnBandOfSample, isWater } from '@terrace/shared';
import { TEMPLE_SURVEY_RADIUS_CELLS } from './protocol.ts';

export interface TempleTerrain {
  readonly worldSize: number;
  /** Unavailable or locked ground is null. */
  heightAt(x: number, y: number): number | null;
}

export const TEMPLE_FOOTPRINT_OFFSETS: ReadonlyArray<readonly [number, number]> =
  (() => {
    const offsets: Array<readonly [number, number]> = [];
    for (let dy = -TEMPLE_SURVEY_RADIUS_CELLS; dy <= TEMPLE_SURVEY_RADIUS_CELLS; dy++) {
      for (let dx = -TEMPLE_SURVEY_RADIUS_CELLS; dx <= TEMPLE_SURVEY_RADIUS_CELLS; dx++) {
        offsets.push([dx, dy] as const);
      }
    }
    return offsets;
  })();

export function isTempleGround(terrain: TempleTerrain, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= terrain.worldSize || y >= terrain.worldSize) return false;

  const centre = terrain.heightAt(x, y);
  if (centre === null) return false;
  const band = drawnBandOfSample(centre);
  for (const [dx, dy] of TEMPLE_FOOTPRINT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= terrain.worldSize || ny >= terrain.worldSize) return false;
    const height = terrain.heightAt(nx, ny);
    if (height === null || isWater(height) || drawnBandOfSample(height) !== band) return false;
  }
  return true;
}
