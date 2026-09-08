import { CELL_WORLD_SIZE } from '@terrace/shared';
import { grassKey, grassVariation, type GrassCell } from '../protocol.ts';
import type { GrassPlacement } from './grassModels.ts';

export type GrassGroundLookup = (x: number, y: number) => number | null;

export interface GrassPlacementResult {
  readonly placements: GrassPlacement[];
  readonly pendingCells: number[];
}

export function grassPlacementsFor(
  cells: Iterable<GrassCell>,
  groundAt: GrassGroundLookup,
): GrassPlacementResult {
  const placements: GrassPlacement[] = [];
  const pendingCells: number[] = [];

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingCells.push(grassKey(cell.x, cell.y));
      continue;
    }

    const variation = grassVariation(cell.x, cell.y);
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
