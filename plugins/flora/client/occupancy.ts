import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  CellColumn,
  CellOccupancy,
  CellRayChord,
} from '../../../client/src/plugins/types.ts';
import {
  cropKey,
  treeKey,
  treeVariation,
  FLORA_TREE_SCALE_MAX,
  type CropCell,
  type TreeCell,
} from '../protocol.ts';
import {
  BROADLEAF_CROWN_CENTRE_Y,
  BROADLEAF_CROWN_RADIUS,
  BROADLEAF_CROWN_SEGMENTS,
  CONIFER_CROWN_HEIGHT,
  CONIFER_CROWN_RADIUS,
  CONIFER_CROWN_SEGMENTS,
  TRUNK_BOTTOM_RADIUS,
  TRUNK_HEIGHT,
} from './models.ts';
import type { InstanceReach } from './instanceBounds.ts';
import type { GroundLookup } from './placement.ts';

function facetedRadius(radius: number, segments: number): number {
  return radius * Math.cos(Math.PI / segments);
}

const CONIFER_SILHOUETTE_RADIUS = facetedRadius(CONIFER_CROWN_RADIUS, CONIFER_CROWN_SEGMENTS);
const BROADLEAF_SILHOUETTE_RADIUS = facetedRadius(
  BROADLEAF_CROWN_RADIUS,
  BROADLEAF_CROWN_SEGMENTS,
);

const CELL_HALF_DIAGONAL_IN_CELLS = Math.SQRT2 / 2;

function neighbourhoodInCells(worldRadius: number): number {
  return Math.floor(worldRadius / CELL_WORLD_SIZE + CELL_HALF_DIAGONAL_IN_CELLS);
}

const TREE_MAX_CROWN_RADIUS = Math.max(CONIFER_SILHOUETTE_RADIUS, BROADLEAF_SILHOUETTE_RADIUS) *
  FLORA_TREE_SCALE_MAX;
const TREE_NEIGHBOURHOOD_CELLS = neighbourhoodInCells(TREE_MAX_CROWN_RADIUS);

function treeColumnAt(
  kind: 'conifer' | 'broadleaf',
  scale: number,
  groundY: number,
  distance: number,
): CellColumn | null {
  const trunkTopY = groundY + TRUNK_HEIGHT * scale;
  const onTrunk = distance <= TRUNK_BOTTOM_RADIUS * scale;

  if (kind === 'conifer') {
    const radius = CONIFER_SILHOUETTE_RADIUS * scale;
    if (distance > radius) return onTrunk ? { loY: groundY, hiY: trunkTopY } : null;
    const hiY = trunkTopY + CONIFER_CROWN_HEIGHT * scale * (1 - distance / radius);
    return { loY: onTrunk ? groundY : trunkTopY, hiY };
  }

  const radius = BROADLEAF_SILHOUETTE_RADIUS * scale;
  if (distance > radius) return onTrunk ? { loY: groundY, hiY: trunkTopY } : null;
  const centreY = groundY + BROADLEAF_CROWN_CENTRE_Y * scale;
  const halfChord = Math.sqrt(radius * radius - distance * distance);
  return {
    loY: onTrunk ? groundY : centreY - halfChord,
    hiY: centreY + halfChord,
  };
}

function distanceToChord(chord: CellRayChord, plantX: number, plantZ: number): number {
  const alongX = chord.toX - chord.fromX;
  const alongZ = chord.toZ - chord.fromZ;
  const toPlantX = plantX - chord.fromX;
  const toPlantZ = plantZ - chord.fromZ;
  const lengthSquared = alongX * alongX + alongZ * alongZ;
  let along = lengthSquared > 0 ? (toPlantX * alongX + toPlantZ * alongZ) / lengthSquared : 0;
  if (along < 0) along = 0;
  else if (along > 1) along = 1;
  return Math.hypot(toPlantX - along * alongX, toPlantZ - along * alongZ);
}

function widen(into: CellColumn | null, column: CellColumn): CellColumn {
  if (into === null) return column;
  return {
    loY: into.loY < column.loY ? into.loY : column.loY,
    hiY: into.hiY > column.hiY ? into.hiY : column.hiY,
  };
}

export function treeOccupancy(
  trees: ReadonlyMap<number, TreeCell>,
  groundAt: GroundLookup,
): CellOccupancy {
  return (x: number, y: number, chord: CellRayChord): CellColumn | null => {
    if (trees.size === 0) return null;
    let column: CellColumn | null = null;
    for (let dy = -TREE_NEIGHBOURHOOD_CELLS; dy <= TREE_NEIGHBOURHOOD_CELLS; dy++) {
      for (let dx = -TREE_NEIGHBOURHOOD_CELLS; dx <= TREE_NEIGHBOURHOOD_CELLS; dx++) {
        const cell = trees.get(treeKey(x + dx, y + dy));
        if (cell === undefined) continue;
        const groundY = groundAt(cell.x, cell.y);
        if (groundY === null) continue;
        const variation = treeVariation(cell.x, cell.y);
        const distance = distanceToChord(
          chord,
          cell.x * CELL_WORLD_SIZE,
          cell.y * CELL_WORLD_SIZE,
        );
        const one = treeColumnAt(variation.kind, variation.scale, groundY, distance);
        if (one !== null) column = widen(column, one);
      }
    }
    return column;
  };
}

export function cropOccupancy(
  crops: ReadonlyMap<number, CropCell>,
  groundAt: GroundLookup,
  reach: InstanceReach,
): CellOccupancy {
  const neighbourhood = neighbourhoodInCells(reach.horizontal);
  return (x: number, y: number, chord: CellRayChord): CellColumn | null => {
    if (crops.size === 0) return null;
    let column: CellColumn | null = null;
    for (let dy = -neighbourhood; dy <= neighbourhood; dy++) {
      for (let dx = -neighbourhood; dx <= neighbourhood; dx++) {
        const cell = crops.get(cropKey(x + dx, y + dy));
        if (cell === undefined) continue;
        const distance = distanceToChord(
          chord,
          cell.x * CELL_WORLD_SIZE,
          cell.y * CELL_WORLD_SIZE,
        );
        if (distance > reach.horizontal) continue;
        const groundY = groundAt(cell.x, cell.y);
        if (groundY === null) continue;
        column = widen(column, {
          loY: groundY - reach.down,
          hiY: groundY + reach.up,
        });
      }
    }
    return column;
  };
}
