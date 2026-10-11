import { CELL_WORLD_SIZE } from '@terrace/shared';
import { FLORA_CELL_KEY_STRIDE, fringeVariation, type FringeSpecies } from '../protocol.ts';
import type { FringePlacement } from './fringeModels.ts';

export type FringeGroundLookup = (x: number, y: number) => number | null;

export interface FringePlacementResult {
  readonly placements: FringePlacement[];
  readonly pendingCells: number[];
}

export function fringePlacementsFor(
  plants: Iterable<readonly [number, FringeSpecies]>,
  groundAt: FringeGroundLookup,
): FringePlacementResult {
  const placements: FringePlacement[] = [];
  const pendingCells: number[] = [];

  for (const [key, species] of plants) {
    const cellX = key % FLORA_CELL_KEY_STRIDE;
    const cellY = Math.floor(key / FLORA_CELL_KEY_STRIDE);
    const groundY = groundAt(cellX, cellY);
    if (groundY === null) {
      pendingCells.push(key);
      continue;
    }

    const variation = fringeVariation(cellX, cellY);
    placements.push({
      x: cellX * CELL_WORLD_SIZE,
      z: cellY * CELL_WORLD_SIZE,
      cellX,
      cellY,
      groundY,
      species,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingCells };
}
