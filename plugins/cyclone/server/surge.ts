import { BAND_HEIGHT, SEA_LEVEL } from '@terrace/shared';
import { footprintUnlocked } from '../../../server/src/plugins/footprint.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import type {
  RotatingStorm,
  RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';

export const SURGE_SCOUR_HEIGHT_UNITS = BAND_HEIGHT / 2;

export const SURGE_BRUSH_RADIUS_CELLS = 4;

export const SURGE_INTERVAL_SECONDS = 10;

export const SURGE_MIN_INTENSITY = 0.5;

export const SURGE_SITING_ATTEMPTS = 12;

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function isShoreline(world: RotatingStormWorld, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (world.heightAt(x, y) <= SEA_LEVEL) return false;
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (world.heightAt(nx, ny) <= SEA_LEVEL) return true;
  }
  return false;
}

export function tickSurge(
  world: WorldApi & RotatingStormWorld,
  storm: RotatingStorm,
  intensity: number,
  dt: number,
  random: () => number,
): { x: number; y: number } | null {
  storm.ownerDebtSeconds += dt;
  if (storm.ownerDebtSeconds < SURGE_INTERVAL_SECONDS) return null;
  storm.ownerDebtSeconds = 0;
  if (intensity < SURGE_MIN_INTENSITY) return null;

  for (let attempt = 0; attempt < SURGE_SITING_ATTEMPTS; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * storm.radius;
    const x = Math.round(storm.x + Math.cos(angle) * distance);
    const y = Math.round(storm.y + Math.sin(angle) * distance);
    if (!isShoreline(world, x, y)) continue;
    if (!footprintUnlocked(world, x, y, SURGE_BRUSH_RADIUS_CELLS)) continue;

    world.sculpt(
      x,
      y,
      SURGE_BRUSH_RADIUS_CELLS,
      -Math.round(SURGE_SCOUR_HEIGHT_UNITS * intensity),
    );
    return { x, y };
  }
  return null;
}
