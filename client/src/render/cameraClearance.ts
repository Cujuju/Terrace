import { CAMERA_GROUND_CLEARANCE_WORLD_UNITS } from '../config.ts';

export type GroundHeightSampler = (
  worldX: number,
  worldZ: number,
) => number | null;

const CLEARANCE_WORLD_UNITS = CAMERA_GROUND_CLEARANCE_WORLD_UNITS;

export function clearedCameraY(cameraY: number, groundY: number): number {
  const floor = groundY + CLEARANCE_WORLD_UNITS;
  return cameraY < floor ? floor : cameraY;
}

export function applyGroundClearance(
  position: { x: number; y: number; z: number },
  sampleGroundY: GroundHeightSampler,
): boolean {
  const groundY = sampleGroundY(position.x, position.z);
  if (groundY === null) return false;
  const cleared = clearedCameraY(position.y, groundY);
  if (cleared === position.y) return false;
  position.y = cleared;
  return true;
}
