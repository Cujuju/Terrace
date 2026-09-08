import { isFarmlandCell, type FarmlandWorld } from '@terrace/shared';

export type { FarmlandWorld };

const MOORE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

export function hasNearbyFarmland(world: FarmlandWorld, x: number, y: number): boolean {
  if (isFarmlandCell(world, x, y)) return true;
  for (const [dx, dy] of MOORE_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) continue;
    if (isFarmlandCell(world, nx, ny)) return true;
  }
  return false;
}
