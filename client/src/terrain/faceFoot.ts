import { CELL_WORLD_SIZE } from '../config.ts';
import { worldPointToCell, type TerrainRayPick, type Vec3 } from './picking.ts';

const FOOT_STEP_BACK_CELLS = 0.25;

const MIN_HORIZONTAL_DIRECTION = 1e-4;

const HALF_CELL = 0.5;

export function footOfFaceCell(
  pick: TerrainRayPick,
  direction: Vec3,
  worldSize: number,
): { x: number; y: number } | null {
  if (!pick.hitRiser) return { x: pick.x, y: pick.y };
  const horizontal = Math.sqrt(direction.x * direction.x + direction.z * direction.z);
  if (!(horizontal > MIN_HORIZONTAL_DIRECTION)) return { x: pick.x, y: pick.y };
  const toEntry = distanceBackToBoxEntry(pick, direction);
  const step = toEntry + (FOOT_STEP_BACK_CELLS * CELL_WORLD_SIZE) / horizontal;
  return worldPointToCell(pick.hitX - direction.x * step, pick.hitZ - direction.z * step, worldSize);
}

function distanceBackToBoxEntry(pick: TerrainRayPick, direction: Vec3): number {
  let back = Infinity;
  if (direction.x !== 0) {
    const side = (pick.x + (direction.x > 0 ? -HALF_CELL : HALF_CELL)) * CELL_WORLD_SIZE;
    back = Math.min(back, (pick.hitX - side) / direction.x);
  }
  if (direction.z !== 0) {
    const side = (pick.y + (direction.z > 0 ? -HALF_CELL : HALF_CELL)) * CELL_WORLD_SIZE;
    back = Math.min(back, (pick.hitZ - side) / direction.z);
  }
  return back === Infinity || back < 0 ? 0 : back;
}
