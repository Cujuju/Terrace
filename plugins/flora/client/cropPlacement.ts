import { CELL_WORLD_SIZE } from '@terrace/shared';
import { cropKey, cropVariation, type CropCell } from '../protocol.ts';
import type { CropPlacement } from './cropModels.ts';

export type CropGroundLookup = (x: number, y: number) => number | null;

export interface CropPlacementResult {
  readonly placements: CropPlacement[];
  readonly pendingCells: number[];
}

export function cropPlacementsFor(
  cells: Iterable<CropCell>,
  groundAt: CropGroundLookup,
): CropPlacementResult {
  const placements: CropPlacement[] = [];
  const pendingCells: number[] = [];

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingCells.push(cropKey(cell.x, cell.y));
      continue;
    }

    const variation = cropVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      cellX: cell.x,
      cellY: cell.y,
      groundY,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingCells };
}
