import { CELL_WORLD_SIZE } from '@terrace/shared';
import { treeVariation, type TreeCell } from '../protocol.ts';
import type { TreePlacement } from './models.ts';

export type GroundLookup = (x: number, y: number) => number | null;

export interface PlacementResult {
  readonly placements: TreePlacement[];
  readonly pendingGround: number;
}

export function placementsFor(cells: Iterable<TreeCell>, groundAt: GroundLookup): PlacementResult {
  const placements: TreePlacement[] = [];
  let pendingGround = 0;

  for (const cell of cells) {
    const groundY = groundAt(cell.x, cell.y);
    if (groundY === null) {
      pendingGround++;
      continue;
    }

    const variation = treeVariation(cell.x, cell.y);
    placements.push({
      x: cell.x * CELL_WORLD_SIZE,
      z: cell.y * CELL_WORLD_SIZE,
      groundY,
      kind: variation.kind,
      scale: variation.scale,
      yaw: variation.yaw,
    });
  }

  return { placements, pendingGround };
}
