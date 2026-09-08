import {
  CELL_CENTRE_OFFSET_CELLS,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  TERRAIN_LOD_NEAR_N,
  bandOf,
  cellCentreCoord,
  chunkIndex,
  drawnGroundHeight,
  isSpanDrawn,
  spanAt,
  spanUndersideHeight,
  spanCapHeight,
  spanCount,
  spanIndexCoveringBand,
  worldToCellCoord,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { hasChunk, type TerrainMirror } from './mirror.ts';
import type { CellOccupancy, CellRayChord } from './occupancy.ts';

export type { CellColumn, CellOccupancy, CellRayChord } from './occupancy.ts';

export interface Ndc {
  x: number;
  y: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CellPick {
  x: number;
  y: number;
}

export function pointerToNdc(
  clientX: number,
  clientY: number,
  rect: ViewportRect,
): Ndc | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
}

export function worldPointToCell(
  worldX: number,
  worldZ: number,
  worldSize: number,
): CellPick | null {
  const max = worldSize - 1;
  const cellX = worldX / CELL_WORLD_SIZE;
  const cellZ = worldZ / CELL_WORLD_SIZE;
  if (!Number.isFinite(cellX) || !Number.isFinite(cellZ)) {
    return null;
  }

  const clamp = (v: number): number => (v <= 0 ? 0 : v > max ? max : v);
  return { x: clamp(Math.round(cellX)), y: clamp(Math.round(cellZ)) };
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TerrainRayPick {
  readonly x: number;
  readonly y: number;
  readonly surfaceY: number;
  readonly spanIndex: number;
  readonly hitRiser: boolean;
  readonly hitY: number;
  readonly hitX: number;
  readonly hitZ: number;
}

const MAX_TERRAIN_WORLD_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE;
const MIN_TERRAIN_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE;

const marchStepLimit = (worldSize: number): number => 2 * worldSize + 2;

function cellRevealed(mirror: TerrainMirror, x: number, y: number): boolean {
  return hasChunk(
    mirror,
    chunkIndex(
      mirror.map.size,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
    ),
  );
}

type CellVisitor = (i: number, j: number, tEnter: number, tExit: number) => boolean;

const MAX_STANDING_WORLD_HEIGHT = 4;

interface ScaledRay {
  readonly ox: number;
  readonly oz: number;
  readonly oy: number;
  readonly dx: number;
  readonly dz: number;
  readonly dy: number;
}

function scaleRayToCellSpace(origin: Vec3, direction: Vec3): ScaledRay | null {
  const ox = worldToCellCoord(origin.x);
  const oz = worldToCellCoord(origin.z);
  const dx = direction.x / CELL_WORLD_SIZE;
  const dz = direction.z / CELL_WORLD_SIZE;
  const oy = origin.y;
  const dy = direction.y;
  if (
    !Number.isFinite(ox) || !Number.isFinite(oz) || !Number.isFinite(oy) ||
    !Number.isFinite(dx) || !Number.isFinite(dz) || !Number.isFinite(dy)
  ) {
    return null;
  }
  if (dx === 0 && dz === 0 && dy === 0) return null;
  return { ox, oz, oy, dx, dz, dy };
}

interface RayBoxClip {
  readonly tEnter: number;
  readonly tExit: number;
}

function clipRayToBox(
  ray: ScaledRay,
  xLo: number,
  xHi: number,
  zLo: number,
  zHi: number,
  ceilingY: number,
): RayBoxClip | null {
  let tMin = 0;
  let tMax = Infinity;
  const clipSlab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (d === 0) return o >= lo && o <= hi;
    const t1 = (lo - o) / d;
    const t2 = (hi - o) / d;
    const near = t1 < t2 ? t1 : t2;
    const far = t1 < t2 ? t2 : t1;
    if (near > tMin) tMin = near;
    if (far < tMax) tMax = far;
    return tMin <= tMax;
  };
  if (!clipSlab(ray.ox, ray.dx, xLo, xHi)) return null;
  if (!clipSlab(ray.oz, ray.dz, zLo, zHi)) return null;
  if (!clipSlab(ray.oy, ray.dy, MIN_TERRAIN_WORLD_Y, ceilingY)) return null;
  if (tMin < 0) tMin = 0;
  if (tMin > tMax) return null;
  return { tEnter: tMin, tExit: tMax };
}

function marchCells(
  size: number,
  origin: Vec3,
  direction: Vec3,
  ceilingY: number,
  visit: CellVisitor,
): void {
  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return;
  const { ox, oz, dx, dz } = ray;

  const clip = clipRayToBox(ray, 0, size, 0, size, ceilingY);
  if (clip === null) return;
  const tMin = clip.tEnter;
  const tMax = clip.tExit;

  const u = ox + tMin * dx;
  const v = oz + tMin * dz;
  let i = Math.floor(u);
  let j = Math.floor(v);
  if (i < 0) i = 0;
  else if (i >= size) i = size - 1;
  if (j < 0) j = 0;
  else if (j >= size) j = size - 1;

  const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepJ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  let tNextU = stepI === 0 ? Infinity : tMin + ((stepI > 0 ? i + 1 : i) - u) / dx;
  let tNextV = stepJ === 0 ? Infinity : tMin + ((stepJ > 0 ? j + 1 : j) - v) / dz;
  const tDeltaU = stepI === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaV = stepJ === 0 ? Infinity : Math.abs(1 / dz);

  const limit = marchStepLimit(size);
  let tEnter = tMin;
  for (let step = 0; step < limit; step++) {
    if (i < 0 || i >= size || j < 0 || j >= size) return;
    const tExit = Math.min(tNextU, tNextV, tMax);
    if (tExit < tEnter) return;

    if (visit(i, j, tEnter, tExit)) return;

    if (tExit >= tMax) return;
    tEnter = tNextU < tNextV ? tNextU : tNextV;
    if (tNextU === tEnter) {
      i += stepI;
      tNextU += tDeltaU;
    }
    if (tNextV === tEnter) {
      j += stepJ;
      tNextV += tDeltaV;
    }
  }
}

const SUBCELLS_PER_CELL = TERRAIN_LOD_NEAR_N;

const SUBCELL_STEP_LIMIT = 2 * SUBCELLS_PER_CELL;

type SubcellVisitor = (
  su: number,
  sv: number,
  tEnter: number,
  tExit: number,
) => boolean;

function marchSubcells(
  ray: ScaledRay,
  i: number,
  j: number,
  tFrom: number,
  tTo: number,
  visit: SubcellVisitor,
): void {
  const du = ray.dx * SUBCELLS_PER_CELL;
  const dv = ray.dz * SUBCELLS_PER_CELL;
  const u = (ray.ox + tFrom * ray.dx) * SUBCELLS_PER_CELL;
  const v = (ray.oz + tFrom * ray.dz) * SUBCELLS_PER_CELL;
  const loU = i * SUBCELLS_PER_CELL;
  const loV = j * SUBCELLS_PER_CELL;
  const hiU = loU + SUBCELLS_PER_CELL - 1;
  const hiV = loV + SUBCELLS_PER_CELL - 1;

  let su = Math.floor(u);
  let sv = Math.floor(v);
  if (su < loU) su = loU;
  else if (su > hiU) su = hiU;
  if (sv < loV) sv = loV;
  else if (sv > hiV) sv = hiV;

  const stepU = du > 0 ? 1 : du < 0 ? -1 : 0;
  const stepV = dv > 0 ? 1 : dv < 0 ? -1 : 0;
  let tNextU = stepU === 0 ? Infinity : tFrom + ((stepU > 0 ? su + 1 : su) - u) / du;
  let tNextV = stepV === 0 ? Infinity : tFrom + ((stepV > 0 ? sv + 1 : sv) - v) / dv;
  const tDeltaU = stepU === 0 ? Infinity : Math.abs(1 / du);
  const tDeltaV = stepV === 0 ? Infinity : Math.abs(1 / dv);

  let tEnter = tFrom;
  for (let step = 0; step < SUBCELL_STEP_LIMIT; step++) {
    const tExit = Math.min(tNextU, tNextV, tTo);
    if (tExit < tEnter) return;

    if (visit(su, sv, tEnter, tExit)) return;

    if (tExit >= tTo) return;
    tEnter = tNextU < tNextV ? tNextU : tNextV;
    if (tNextU === tEnter) {
      su += stepU;
      tNextU += tDeltaU;
    }
    if (tNextV === tEnter) {
      sv += stepV;
      tNextV += tDeltaV;
    }
    if (su < loU || su > hiU || sv < loV || sv > hiV) return;
  }
}

interface DrawnOwner {
  readonly x: number;
  readonly y: number;
  readonly spanIndex: number;
  readonly undersideY: number;
}

/** Half-sub-cells: the coarsest unit in which sub-cell and cell centres are both integral. */
const HALF_SUBCELLS_PER_SUBCELL = 2;

const HALF_SUBCELLS_PER_CELL = HALF_SUBCELLS_PER_SUBCELL * SUBCELLS_PER_CELL;

const FOOTPRINT_SPAN_CELLS = 2;

function subcellCentreCells(sub: number): number {
  return (sub + CELL_CENTRE_OFFSET_CELLS) / SUBCELLS_PER_CELL;
}

function subcellCentreHalfSubcells(sub: number): number {
  return sub * HALF_SUBCELLS_PER_SUBCELL + HALF_SUBCELLS_PER_SUBCELL / 2;
}

function cellCentreHalfSubcells(cell: number): number {
  return cell * HALF_SUBCELLS_PER_CELL + HALF_SUBCELLS_PER_CELL / 2;
}

/** Lower cell of the pair whose centres bracket this sub-cell, as the blend reads it. */
function blendBaseCell(centreHalfSubcells: number): number {
  return Math.floor(
    (centreHalfSubcells - HALF_SUBCELLS_PER_CELL / 2) / HALF_SUBCELLS_PER_CELL,
  );
}

function clampCell(size: number, cell: number): number {
  return cell < 0 ? 0 : cell > size - 1 ? size - 1 : cell;
}

/**
 * Nearest revealed cell of the sub-cell's blend footprint holding `band`. The
 * cell a sub-cell sits in is always the nearest of the four.
 */
function drawnBandOwner(
  mirror: TerrainMirror,
  i: number,
  j: number,
  su: number,
  sv: number,
  band: number,
): DrawnOwner | null {
  const size = mirror.map.size;
  const centreX = subcellCentreHalfSubcells(su);
  const centreZ = subcellCentreHalfSubcells(sv);
  const baseX = blendBaseCell(centreX);
  const baseZ = blendBaseCell(centreZ);
  let owner: DrawnOwner | null = null;
  let nearest = 0;
  for (let dz = 0; dz < FOOTPRINT_SPAN_CELLS; dz++) {
    const y = clampCell(size, baseZ + dz);
    const offZ = centreZ - cellCentreHalfSubcells(y);
    for (let dx = 0; dx < FOOTPRINT_SPAN_CELLS; dx++) {
      const x = clampCell(size, baseX + dx);
      if (x === i && y === j) continue;
      const offX = centreX - cellCentreHalfSubcells(x);
      const distance = offX * offX + offZ * offZ;
      if (owner !== null && distance >= nearest) continue;
      if (!cellRevealed(mirror, x, y)) continue;
      const spanIndex = spanIndexCoveringBand(mirror.map, x, y, band);
      if (spanIndex === null) continue;
      const span = spanAt(mirror.map, x, y, spanIndex);
      if (!isSpanDrawn(span)) continue;
      owner = {
        x,
        y,
        spanIndex,
        undersideY: spanUndersideHeight(span) * HEIGHT_WORLD_SCALE,
      };
      nearest = distance;
    }
  }
  return owner;
}

/** A drawn sample inside a cell blends only cells within one step of that cell. */
const DRAWN_BLEND_RADIUS_CELLS = 1;

/**
 * Ceiling of everything pickable in a cell: no span cap, and no drawn height a
 * sub-cell can blend to, rises above the tallest cell of the blend footprint.
 */
function cellCeilingBound(mirror: TerrainMirror, i: number, j: number): number {
  const size = mirror.map.size;
  const cells = mirror.renderMap.cells;
  const x0 = i > DRAWN_BLEND_RADIUS_CELLS ? i - DRAWN_BLEND_RADIUS_CELLS : 0;
  const y0 = j > DRAWN_BLEND_RADIUS_CELLS ? j - DRAWN_BLEND_RADIUS_CELLS : 0;
  const x1 = i + DRAWN_BLEND_RADIUS_CELLS < size ? i + DRAWN_BLEND_RADIUS_CELLS : size - 1;
  const y1 = j + DRAWN_BLEND_RADIUS_CELLS < size ? j + DRAWN_BLEND_RADIUS_CELLS : size - 1;
  let hi = mirror.map.cells[j * size + i]!;
  for (let y = y0; y <= y1; y++) {
    const row = y * size;
    for (let x = x0; x <= x1; x++) {
      const h = cells[row + x]!;
      if (h > hi) hi = h;
    }
  }
  return hi * HEIGHT_WORLD_SCALE;
}

function terrainHitInCell(
  mirror: TerrainMirror,
  ray: ScaledRay,
  i: number,
  j: number,
  origin: Vec3,
  direction: Vec3,
  tEnter: number,
  tExit: number,
): TerrainRayPick | null {
  if (!cellRevealed(mirror, i, j)) return null;

  const map = mirror.map;
  const oy = origin.y;
  const dy = direction.y;
  const cellEntryY = oy + tEnter * dy;
  const cellExitY = oy + tExit * dy;
  const cellLowY = cellEntryY < cellExitY ? cellEntryY : cellExitY;
  if (cellLowY > cellCeilingBound(mirror, i, j)) return null;

  const count = spanCount(map, i, j);
  let found: TerrainRayPick | null = null;
  let hitT = Infinity;
  let tIn = 0;
  let entryY = 0;
  let lowY = 0;
  let highY = 0;

  const consider = (
    cellX: number,
    cellY: number,
    spanIndex: number,
    capY: number,
    baseY: number,
  ): void => {
    if (lowY > capY || highY < baseY) return;
    const insideOnEntry = entryY <= capY && entryY >= baseY;
    const faceY = insideOnEntry ? entryY : entryY > capY ? capY : baseY;
    const t = insideOnEntry || dy === 0 ? tIn : tIn + (faceY - entryY) / dy;
    if (t >= hitT) return;
    hitT = t;
    found = {
      x: cellX,
      y: cellY,
      surfaceY: capY,
      spanIndex,
      hitRiser: insideOnEntry,
      hitY: faceY,
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
  };

  marchSubcells(ray, i, j, tEnter, tExit, (su, sv, tFrom, tTo) => {
    tIn = tFrom;
    entryY = oy + tFrom * dy;
    const exitY = oy + tTo * dy;
    lowY = entryY < exitY ? entryY : exitY;
    highY = entryY < exitY ? exitY : entryY;

    const drawnHeight = drawnGroundHeight(
      mirror.renderMap,
      subcellCentreCells(su),
      subcellCentreCells(sv),
    );
    const drawnBand = bandOf(drawnHeight);
    const drawnSpan = spanIndexCoveringBand(map, i, j, drawnBand);
    if (drawnSpan === null) {
      const owner = drawnBandOwner(mirror, i, j, su, sv, drawnBand);
      if (owner !== null) {
        consider(
          owner.x,
          owner.y,
          owner.spanIndex,
          drawnHeight * HEIGHT_WORLD_SCALE,
          owner.undersideY,
        );
      }
    }
    for (let k = count - 1; k >= 0; k--) {
      const span = spanAt(map, i, j, k);
      if (!isSpanDrawn(span)) continue;
      const capHeight = k === drawnSpan ? drawnHeight : spanCapHeight(span);
      consider(
        i,
        j,
        k,
        capHeight * HEIGHT_WORLD_SCALE,
        spanUndersideHeight(span) * HEIGHT_WORLD_SCALE,
      );
    }
    return found !== null;
  });
  return found;
}

export function pickTerrainCellByRay(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
): TerrainRayPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;
  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return null;

  let found: TerrainRayPick | null = null;
  marchCells(size, origin, direction, MAX_TERRAIN_WORLD_Y, (i, j, tEnter, tExit) => {
    found = terrainHitInCell(mirror, ray, i, j, origin, direction, tEnter, tExit);
    return found !== null;
  });
  return found;
}

export function carveReachCell(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
  band: number,
): { x: number; y: number } | null {
  const size = mirror.map.size;
  if (size <= 0) return null;

  let found: { x: number; y: number } | null = null;
  marchCells(size, origin, direction, MAX_TERRAIN_WORLD_Y, (i, j) => {
    if (!cellRevealed(mirror, i, j)) return true;
    if (spanIndexCoveringBand(mirror.map, i, j, band) === null) return false;
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
): TerrainRayPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  if (!cellRevealed(mirror, x, y)) return null;

  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return null;
  const clip = clipRayToBox(ray, x, x + 1, y, y + 1, MAX_TERRAIN_WORLD_Y);
  if (clip === null) return null;
  const { tEnter, tExit } = clip;

  const hit = terrainHitInCell(mirror, ray, x, y, origin, direction, tEnter, tExit);
  if (hit !== null) return hit;

  const entryY = ray.oy + tEnter * ray.dy;
  const exitY = ray.oy + tExit * ray.dy;
  const lowY = entryY < exitY ? entryY : exitY;
  const count = spanCount(mirror.map, x, y);
  const drawnHeight = drawnGroundHeight(mirror.renderMap, cellCentreCoord(x), cellCentreCoord(y));
  const drawnSpan = spanIndexCoveringBand(mirror.map, x, y, bandOf(drawnHeight));
  for (let k = count - 1; k >= 0; k--) {
    const span = spanAt(mirror.map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    const capY = (k === drawnSpan ? drawnHeight : spanCapHeight(span)) * HEIGHT_WORLD_SCALE;
    if (capY >= lowY) continue;
    const tMid = (tEnter + tExit) / 2;
    return {
      x,
      y,
      surfaceY: capY,
      spanIndex: k,
      hitRiser: false,
      hitY: capY,
      hitX: origin.x + tMid * direction.x,
      hitZ: origin.z + tMid * direction.z,
    };
  }
  return null;
}

export interface PointedCellPick {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export function pickPointedCellByRay(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
  occupants: readonly CellOccupancy[],
): PointedCellPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;

  const dirLength = Math.hypot(direction.x, direction.y, direction.z);
  if (!(dirLength > 0)) return null;
  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return null;

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

    const terrain = terrainHitInCell(mirror, ray, i, j, origin, direction, tEnter, tExit);
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
