import { drawnSpanIndexCoveringBand } from '@terrace/shared';
import { terrainHitInCell } from './pick/cellHit.ts';
import {
  MARCH_CEILING_WORLD_Y,
  MAX_TERRAIN_WORLD_Y,
  cellRevealed,
  clipRayToBox,
  marchCells,
  rayParameterAtGroundPoint,
  scaleRayToCellSpace,
} from './pick/rayMarch.ts';
import type { TerrainMirror } from './mirror.ts';
import type { CellOccupancy } from './occupancy.ts';
import type { DrawnRisers, PointedCellPick, TerrainRayPick, Vec3 } from './pick/types.ts';

export type { CellColumn, CellOccupancy, CellRayChord } from './occupancy.ts';
export { pointerToNdc, worldPointToCell } from './pick/rayMarch.ts';
export { columnOwningBand } from './pick/bandOwner.ts';
export type {
  BandOwner,
  CellPick,
  DrawnRisers,
  Ndc,
  PickFace,
  PointedCellPick,
  TerrainRayPick,
  Vec3,
  ViewportRect,
} from './pick/types.ts';

const MAX_STANDING_WORLD_HEIGHT = 4;

/** A strike parameter no cell can precede: the walk starts at the first cell. */
const BEFORE_ANY_CELL_T = Number.NEGATIVE_INFINITY;

export function pickTerrainCellByRay(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
  risers: DrawnRisers | null = null,
): TerrainRayPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;

  let found: TerrainRayPick | null = null;
  marchCells(size, origin, direction, MARCH_CEILING_WORLD_Y, (i, j, tEnter, tExit) => {
    found = terrainHitInCell(mirror, i, j, origin, direction, tEnter, tExit, risers);
    return found !== null;
  });
  return found;
}

/**
 * Material still at `band`, from the cell the aim STRUCK inward. A ray flies
 * over terrain it never touched, so the walk starts at the pick, taken here.
 */
export function carveReachCell(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
  band: number,
  risers: DrawnRisers | null = null,
): { x: number; y: number } | null {
  const size = mirror.map.size;
  if (size <= 0) return null;
  const aim = pickTerrainCellByRay(mirror, origin, direction, risers);
  if (aim === null) return null;

  // The aim's own column is the cut, and the band was read from it.
  if (
    cellRevealed(mirror, aim.x, aim.y) &&
    drawnSpanIndexCoveringBand(mirror.map, aim.x, aim.y, band) !== null
  ) {
    return { x: aim.x, y: aim.y };
  }

  // Inward from the STRIKE POINT, not from a cell id: a pick can name a
  // neighbour of the cell the ray marched through, which the walk never enters.
  const strikeT =
    rayParameterAtGroundPoint(origin, direction, aim.hitX, aim.hitZ) ?? BEFORE_ANY_CELL_T;
  let reached = false;
  let found: { x: number; y: number } | null = null;
  marchCells(size, origin, direction, MARCH_CEILING_WORLD_Y, (i, j, _tEnter, tExit) => {
    // A cell the ray has already left AT the strike is behind it, so the walk
    // starts in the next one; a boundary strike must not reach backwards.
    if (!reached) {
      if (tExit <= strikeT) return false;
      reached = true;
    }
    if (!cellRevealed(mirror, i, j)) return true;
    // F3: carve reach queries the drawn banding, matching the emitted caps.
    if (drawnSpanIndexCoveringBand(mirror.map, i, j, band) === null) return false;
    found = { x: i, y: j };
    return true;
  });
  return found;
}

export function pickTerrainInColumn(
  mirror: TerrainMirror,
  x: number,
  y: number,
  origin: Vec3,
  direction: Vec3,
  risers: DrawnRisers | null = null,
): TerrainRayPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  if (!cellRevealed(mirror, x, y)) return null;

  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return null;
  const clip = clipRayToBox(ray, x, x + 1, y, y + 1, MARCH_CEILING_WORLD_Y);
  if (clip === null) return null;

  let hit: TerrainRayPick | null = null;
  marchCells(size, origin, direction, MARCH_CEILING_WORLD_Y, (i, j, from, to) => {
    const struck = terrainHitInCell(mirror, i, j, origin, direction, from, to, risers);
    if (struck === null || struck.x !== x || struck.y !== y) return false;
    hit = struck;
    return true;
  });
  if (hit !== null) return hit;

  // F5 (chosen): a pinned-column miss returns null. A fallback to the tread
  // below would name a cell the march never struck, so sculpt would cut an
  // unaimed band.
  return null;
}

export function pickPointedCellByRay(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
  occupants: readonly CellOccupancy[],
  risers: DrawnRisers | null = null,
): PointedCellPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;

  const dirLength = Math.hypot(direction.x, direction.y, direction.z);
  if (!(dirLength > 0)) return null;

  const oy = origin.y;
  const dy = direction.y;

  const ceilingY = MAX_TERRAIN_WORLD_Y + MAX_STANDING_WORLD_HEIGHT;
  const chord = { fromX: 0, fromZ: 0, toX: 0, toZ: 0 };

  let found: PointedCellPick | null = null;
  marchCells(size, origin, direction, ceilingY, (i, j, tEnter, tExit) => {
    const entryY = oy + tEnter * dy;
    const exitY = oy + tExit * dy;
    const lowY = entryY < exitY ? entryY : exitY;
    const highY = entryY < exitY ? exitY : entryY;

    if (occupants.length > 0) {
      chord.fromX = origin.x + tEnter * direction.x;
      chord.fromZ = origin.z + tEnter * direction.z;
      chord.toX = origin.x + tExit * direction.x;
      chord.toZ = origin.z + tExit * direction.z;
    }

    for (const occupant of occupants) {
      const column = occupant(i, j, chord);
      if (column === null) continue;
      if (lowY > column.hiY || highY < column.loY) continue;
      const insideOnEntry = entryY <= column.hiY && entryY >= column.loY;
      const faceY = insideOnEntry ? entryY : entryY > column.hiY ? column.hiY : column.loY;
      const t = insideOnEntry || dy === 0 ? tEnter : tEnter + (faceY - entryY) / dy;
      found = { x: i, y: j, distance: t * dirLength };
      return true;
    }

    const terrain = terrainHitInCell(mirror, i, j, origin, direction, tEnter, tExit, risers);
    if (terrain === null) return false;
    found = {
      x: terrain.x,
      y: terrain.y,
      distance: Math.hypot(
        terrain.hitX - origin.x,
        terrain.hitY - origin.y,
        terrain.hitZ - origin.z,
      ),
    };
    return true;
  });
  return found;
}
