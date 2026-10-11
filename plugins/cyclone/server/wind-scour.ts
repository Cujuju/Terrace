import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { footprintUnlocked } from '../../../server/src/plugins/footprint.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type {
  RotatingStormDamage,
  RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';

export const WIND_SCOUR_HEIGHT_UNITS = BAND_HEIGHT / 4;

export const WIND_SCOUR_BRUSH_RADIUS_CELLS = 2;

export const WIND_SCOUR_MIN_SEVERITY = 0.5;

export const WIND_SCOUR_MAX_CELLS_PER_EVENT = 3;

export function scourStruckGround(
  world: WorldApi & RotatingStormWorld,
  damage: RotatingStormDamage,
): Array<{ x: number; y: number }> {
  const cut: Array<{ x: number; y: number }> = [];

  for (const cell of damage.cells) {
    if (cut.length >= WIND_SCOUR_MAX_CELLS_PER_EVENT) break;
    if (cell.severity < WIND_SCOUR_MIN_SEVERITY) continue;
    if (world.heightAt(cell.x, cell.y) <= SEA_LEVEL) continue;
    if (!footprintUnlocked(world, cell.x, cell.y, WIND_SCOUR_BRUSH_RADIUS_CELLS)) continue;

    const amount = Math.round(WIND_SCOUR_HEIGHT_UNITS * cell.severity);
    if (amount <= 0) continue;

    world.sculpt(cell.x, cell.y, WIND_SCOUR_BRUSH_RADIUS_CELLS, -amount);
    cut.push({ x: cell.x, y: cell.y });
  }

  return cut;
}
