import { CELL_WORLD_SIZE } from '@terrace/shared';
import { stumpVariation, type StumpCell } from '../protocol.ts';
import type { StumpPlacement } from './stumpModels.ts';

export type StumpGroundLookup = (x: number, y: number) => number | null;

export interface StumpPlacementResult {
  readonly placements: StumpPlacement[];
  readonly pendingGround: number;
}

export function stumpPlacementsFor(
  cells: Iterable<StumpCell>,
  groundAt: StumpGroundLookup,
): StumpPlacementResult {
  const placements: StumpPlacement[] = [];
  let pendingGround = 0;

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const variation = stumpVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      groundY,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
