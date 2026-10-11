import { bandOf, isWater } from '@terrace/shared';
import { TEMPLE_SURVEY_RADIUS_CELLS } from '../protocol.ts';

export interface TempleWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
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

export function isTempleSite(world: TempleWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;

  const band = bandOf(world.heightAt(x, y));
  for (const [dx, dy] of TEMPLE_FOOTPRINT_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    if (!world.isCellUnlocked(nx, ny)) return false;
    const height = world.heightAt(nx, ny);
    if (isWater(height)) return false;
    if (bandOf(height) !== band) return false;
  }
  return true;
}
