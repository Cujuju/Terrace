import { CELL_WORLD_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import { treeKey, treeKindAt, treeVariation, type TreeCell } from '../protocol.ts';
import type { TreePlacement } from './models.ts';

const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

export type GroundLookup = (x: number, y: number) => number | null;

export interface PlacementResult {
  readonly placements: TreePlacement[];
  readonly pendingCells: number[];
}

export function placementsFor(cells: Iterable<TreeCell>, groundAt: GroundLookup): PlacementResult {
  const placements: TreePlacement[] = [];
  const pendingCells: number[] = [];

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingCells.push(treeKey(cell.x, cell.y));
      continue;
    }

    const variation = treeVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      cellX: cell.x,
      cellY: cell.y,
      groundY,
      kind: treeKindAt(cell.x, cell.y, groundY / HEIGHT_WORLD_SCALE),
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingCells };
}
