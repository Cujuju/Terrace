import { CELL_WORLD_SIZE } from '@terrace/shared';
import { stumpKey, stumpVariation, type StumpCell } from '../protocol.ts';
import type { StumpPlacement } from './stumpModels.ts';

export type StumpGroundLookup = (x: number, y: number) => number | null;

export interface StumpPlacementResult {
  readonly placements: StumpPlacement[];
  readonly pendingCells: number[];
}

export function stumpPlacementsFor(
  cells: Iterable<StumpCell>,
  groundAt: StumpGroundLookup,
): StumpPlacementResult {
  const placements: StumpPlacement[] = [];
  const pendingCells: number[] = [];

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingCells.push(stumpKey(cell.x, cell.y));
      continue;
    }

    const variation = stumpVariation(cell.x, cell.y);
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
