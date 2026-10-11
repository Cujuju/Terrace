import { CELL_WORLD_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import { FLORA_TREE_SCALE_MAX, treeKey, treeKindAt, treeVariation, type TreeCell } from '../protocol.ts';
import { TRUNK_BOTTOM_RADIUS, type TreePlacement } from './models.ts';

const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

export type GroundLookup = (x: number, y: number) => number | null;

export const TREE_GROUND_REACH_CELLS = TRUNK_BOTTOM_RADIUS * FLORA_TREE_SCALE_MAX / CELL_WORLD_SIZE;

export function supportedTreeGroundAt(
  groundAt: GroundLookup,
  x: number,
  y: number,
  worldSize: number,
): number | null {
  const radius = TRUNK_BOTTOM_RADIUS * treeVariation(x, y).scale / CELL_WORLD_SIZE;
  if (x - radius < 0 || y - radius < 0 || x + radius > worldSize || y + radius > worldSize) return null;
  const groundY = groundAt(x, y);
  if (groundY === null) return null;
  // The enclosing square supports every trunk yaw; branches may overhang.
  for (const dx of [-radius, radius]) {
    for (const dy of [-radius, radius]) {
      if (groundAt(x + dx, y + dy) !== groundY) return null;
    }
  }
  return groundY;
}

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
