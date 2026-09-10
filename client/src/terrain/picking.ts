import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  ISOLINE_SAMPLES_PER_CELL,
  MAX_HEIGHT,
  MIN_HEIGHT,
  bandOf,
  cellIndex,
  chunkIndex,
  drawnBandAt,
  drawnBandOfSample,
  drawnSpanCapHeight,
  isSpanDrawn,
  spanAt,
  spanUndersideHeight,
  spanCount,
  spanIndexCoveringBand,
  type Span,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { blockyCellCapY, drawnBandCapY } from './capEmission.ts';
import { crossRayWithWallPlan } from './drawnFace.ts';
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

const CELL_CENTRE_OFFSET = 0.5;

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
  const ox = origin.x / CELL_WORLD_SIZE + CELL_CENTRE_OFFSET;
  const oz = origin.z / CELL_WORLD_SIZE + CELL_CENTRE_OFFSET;
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
    if (tNextU < tNextV) {
      i += stepI;
      tEnter = tNextU;
      tNextU += tDeltaU;
    } else {
      j += stepJ;
      tEnter = tNextV;
      tNextV += tDeltaV;
    }
  }
}

export interface DrawnRisers {
  segmentsOf(chunkIdx: number, band: number): Float32Array | undefined;
}

const FLOATS_PER_DRAWN_SEGMENT = 4;

const DRAWN_FACE_MARGIN_CELLS = 0.5;

function forEachDrawnSegment(
  risers: DrawnRisers,
  size: number,
  chunksPerEdge: number,
  chunkX: number,
  chunkY: number,
  band: number,
  visit: (ax: number, az: number, bx: number, bz: number) => void,
): void {
  for (let dy = -1; dy <= 1; dy++) {
    const cy = chunkY + dy;
    if (cy < 0 || cy >= chunksPerEdge) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = chunkX + dx;
      if (cx < 0 || cx >= chunksPerEdge) continue;
      const flat = risers.segmentsOf(chunkIndex(size, cx, cy), band);
      if (flat === undefined) continue;
      for (
        let s = 0;
        s + FLOATS_PER_DRAWN_SEGMENT - 1 < flat.length;
        s += FLOATS_PER_DRAWN_SEGMENT
      ) {
        visit(flat[s]!, flat[s + 1]!, flat[s + 2]!, flat[s + 3]!);
      }
    }
  }
}

function orient(
  px: number, pz: number, qx: number, qz: number, rx: number, rz: number,
): number {
  return (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
}

function probeCrossesSegment(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const cSide = orient(ax, az, bx, bz, cx, cz) > 0;
  const dSide = orient(ax, az, bx, bz, dx, dz) > 0;
  if (cSide === dSide) return false;
  const d3 = orient(cx, cz, dx, dz, ax, az);
  const d4 = orient(cx, cz, dx, dz, bx, bz);
  return (d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0);
}

function capPointIsOverStrip(
  risers: DrawnRisers,
  size: number,
  chunksPerEdge: number,
  chunkX: number,
  chunkY: number,
  band: number,
  i: number,
  j: number,
  hitX: number,
  hitZ: number,
): boolean {
  const centreX = i * CELL_WORLD_SIZE;
  const centreZ = j * CELL_WORLD_SIZE;
  let crossings = 0;
  forEachDrawnSegment(risers, size, chunksPerEdge, chunkX, chunkY, band, (ax, az, bx, bz) => {
    if (probeCrossesSegment(centreX, centreZ, hitX, hitZ, ax, az, bx, bz)) crossings++;
  });
  return (crossings & 1) === 1;
}

function refineRiserToDrawnFace(
  mirror: TerrainMirror,
  i: number,
  j: number,
  origin: Vec3,
  direction: Vec3,
  tEnter: number,
  tExit: number,
  hit: TerrainRayPick,
  span: Span,
  risers: DrawnRisers,
): TerrainRayPick {
  const size = mirror.map.size;
  const chunksPerEdge = Math.ceil(size / CHUNK_SIZE);
  const chunkX = Math.floor(i / CHUNK_SIZE);
  const chunkY = Math.floor(j / CHUNK_SIZE);
  const lowestBand = bandOf(spanUndersideHeight(span)) + 1;
  const highestBand = drawnBandOfSample(span.ceiling);

  const ray = scaleRayToCellSpace(origin, direction);
  const window = ray === null ? null : clipRayToBox(
    ray,
    i - DRAWN_FACE_MARGIN_CELLS,
    i + 1 + DRAWN_FACE_MARGIN_CELLS,
    j - DRAWN_FACE_MARGIN_CELLS,
    j + 1 + DRAWN_FACE_MARGIN_CELLS,
    MAX_TERRAIN_WORLD_Y,
  );
  const fromT = window === null ? tEnter : window.tEnter;
  const toT = window === null ? tExit : window.tExit;

  const yA = origin.y + fromT * direction.y;
  const yB = origin.y + toT * direction.y;
  const yMin = yA < yB ? yA : yB;
  const yMax = yA < yB ? yB : yA;
  const bandSlab = BAND_HEIGHT * HEIGHT_WORLD_SCALE;
  const firstBand = Math.max(lowestBand, Math.ceil(yMin / bandSlab));
  const lastBand = Math.min(highestBand, Math.floor(yMax / bandSlab) + 1);

  if (lastBand < firstBand) return hit;

  if (!hit.hitRiser && !capPointIsOverStrip(
    risers, size, chunksPerEdge, chunkX, chunkY, highestBand, i, j, hit.hitX, hit.hitZ,
  )) {
    return hit;
  }

  const contourT = new Float64Array(lastBand - firstBand + 1).fill(Infinity);
  for (let band = firstBand; band <= lastBand; band++) {
    forEachDrawnSegment(risers, size, chunksPerEdge, chunkX, chunkY, band, (ax, az, bx, bz) => {
      const t = crossRayWithWallPlan(origin, direction, ax, az, bx, bz);
      if (t === null || t < fromT || t > toT) return;
      if (t < contourT[band - firstBand]!) contourT[band - firstBand] = t;
    });
  }

  let footT = Infinity;
  for (let band = firstBand; band <= lastBand; band++) {
    const t = contourT[band - firstBand]!;
    if (t < footT) footT = t;
  }
  if (footT === Infinity) return hit;

  let bestT = Infinity;
  let bestLedgeBand: number | null = null;
  for (let band = firstBand; band <= lastBand; band++) {
    const tc = contourT[band - firstBand]!;
    if (tc === Infinity) continue;
    const yHi = band * bandSlab;
    const yLo = (band - 1) * bandSlab;
    const yAt = origin.y + tc * direction.y;
    if (yAt >= yLo && yAt <= yHi && tc < bestT) {
      bestT = tc;
      bestLedgeBand = null;
    }
    if (band >= highestBand || direction.y === 0) continue;
    const tPlane = (yHi - origin.y) / direction.y;
    if (!(tPlane > tc) || tPlane < fromT || tPlane > toT || tPlane >= bestT) continue;
    const above = band + 1 <= lastBand ? contourT[band + 1 - firstBand]! : Infinity;
    if (tPlane >= above) continue;
    bestT = tPlane;
    bestLedgeBand = band;
  }

  if (bestT < Infinity) {
    return {
      ...hit,
      hitRiser: true,
      hitY: bestLedgeBand === null ? origin.y + bestT * direction.y : bestLedgeBand * bandSlab,
      hitX: origin.x + bestT * direction.x,
      hitZ: origin.z + bestT * direction.z,
    };
  }
  return treadOfEnteredNeighbour(
    mirror, i, j, origin, direction, tEnter, tExit, footT, hit.surfaceY,
  ) ?? hit;
}

function treadOfEnteredNeighbour(
  mirror: TerrainMirror,
  i: number,
  j: number,
  origin: Vec3,
  direction: Vec3,
  tEnter: number,
  tExit: number,
  footContourT: number,
  ownCapY: number,
): TerrainRayPick | null {
  const dy = direction.y;
  if (!(dy < 0)) return null;
  const ray = scaleRayToCellSpace(origin, direction);
  if (ray === null) return null;

  const tx = ray.dx === 0 ? -Infinity : ((ray.dx > 0 ? i : i + 1) - ray.ox) / ray.dx;
  const tz = ray.dz === 0 ? -Infinity : ((ray.dz > 0 ? j : j + 1) - ray.oz) / ray.dz;
  if (tx <= 0 && tz <= 0) return null;
  const ni = tx > tz ? i - Math.sign(ray.dx) : i;
  const nj = tx > tz ? j : j - Math.sign(ray.dz);
  const size = mirror.map.size;
  if (ni < 0 || nj < 0 || ni >= size || nj >= size) return null;
  if (!cellRevealed(mirror, ni, nj)) return null;

  const entryY = origin.y + tEnter * dy;
  const treadCeilingY = entryY < ownCapY ? entryY : ownCapY;
  const count = spanCount(mirror.map, ni, nj);
  for (let k = count - 1; k >= 0; k--) {
    const nSpan = spanAt(mirror.map, ni, nj, k);
    if (!isSpanDrawn(nSpan)) continue;
    const capY = drawnSpanCapHeight(nSpan) * HEIGHT_WORLD_SCALE;
    if (!(capY < treadCeilingY)) continue;
    const t = tEnter + (capY - entryY) / dy;
    if (t > tExit || !(t < footContourT)) return null;
    return {
      x: ni,
      y: nj,
      surfaceY: capY,
      spanIndex: k,
      hitRiser: false,
      hitY: capY,
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
  }
  return null;
}

const DRAWN_CAP_SAMPLES_PER_CELL = 2 * ISOLINE_SAMPLES_PER_CELL;

interface DrawnCap {
  readonly t: number;
  readonly capY: number;
  readonly drawnY: number;
}

function nearestCellHeight(mirror: TerrainMirror, u: number, v: number): number {
  const map = mirror.map;
  const last = map.size - 1;
  const clamp = (n: number): number => (n < 0 ? 0 : n > last ? last : n);
  return map.cells[cellIndex(map, clamp(Math.floor(u)), clamp(Math.floor(v)))]!;
}

function drawnCapMet(
  mirror: TerrainMirror,
  ray: ScaledRay,
  tEnter: number,
  tExit: number,
): DrawnCap | null {
  const reach = tExit - tEnter;
  for (let s = 0; s <= DRAWN_CAP_SAMPLES_PER_CELL; s++) {
    const t = tEnter + (reach * s) / DRAWN_CAP_SAMPLES_PER_CELL;
    const u = ray.ox + t * ray.dx;
    const v = ray.oz + t * ray.dz;
    const band = drawnBandAt(mirror.map, u, v);
    const drawnY = drawnBandCapY(band, nearestCellHeight(mirror, u, v));
    if (ray.oy + t * ray.dy <= drawnY) return { t, capY: band * BAND_WORLD_HEIGHT, drawnY };
  }
  return null;
}

function terrainHitInCell(
  mirror: TerrainMirror,
  i: number,
  j: number,
  origin: Vec3,
  direction: Vec3,
  tEnter: number,
  tExit: number,
  risers: DrawnRisers | null,
): TerrainRayPick | null {
  if (!cellRevealed(mirror, i, j)) return null;

  const oy = origin.y;
  const dy = direction.y;
  const entryY = oy + tEnter * dy;
  const exitY = oy + tExit * dy;
  const count = spanCount(mirror.map, i, j);
  const ray = scaleRayToCellSpace(origin, direction);
  let hit: TerrainRayPick | null = null;
  let hitT = Infinity;
  let hitSpan: Span | null = null;
  for (let k = count - 1; k >= 0; k--) {
    const span = spanAt(mirror.map, i, j, k);
    if (!isSpanDrawn(span)) continue;
    const met =
      k === count - 1 && ray !== null ? drawnCapMet(mirror, ray, tEnter, tExit) : null;
    if (k === count - 1 && ray !== null && met === null) continue;
    const capY = met === null ? drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE : met.capY;
    const drawnY = met === null ? blockyCellCapY(span.ceiling) : met.drawnY;
    const baseY = spanUndersideHeight(span) * HEIGHT_WORLD_SCALE;
    const lowY = entryY < exitY ? entryY : exitY;
    const highY = entryY < exitY ? exitY : entryY;
    if (lowY > drawnY || highY < baseY) continue;
    const insideOnEntry = entryY <= drawnY && entryY >= baseY;
    const faceY = insideOnEntry ? entryY : entryY > drawnY ? capY : baseY;
    const metY = insideOnEntry ? entryY : entryY > drawnY ? drawnY : baseY;
    const planeT = insideOnEntry || dy === 0 ? tEnter : tEnter + (metY - entryY) / dy;
    const t = met !== null && insideOnEntry && planeT < met.t ? met.t : planeT;
    if (t >= hitT) continue;
    hitT = t;
    hit = {
      x: i,
      y: j,
      surfaceY: capY,
      spanIndex: k,
      hitRiser: insideOnEntry,
      hitY: faceY,
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
    hitSpan = span;
  }
  const refinable = hit !== null && (hit.hitRiser || hit.hitY === hit.surfaceY);
  if (hit === null || !refinable || risers === null || hitSpan === null) return hit;
  return refineRiserToDrawnFace(
    mirror, i, j, origin, direction, tEnter, tExit, hit, hitSpan, risers,
  );
}

export function pickTerrainCellByRay(
  mirror: TerrainMirror,
  origin: Vec3,
  direction: Vec3,
  risers: DrawnRisers | null = null,
): TerrainRayPick | null {
  const size = mirror.map.size;
  if (size <= 0) return null;

  let found: TerrainRayPick | null = null;
  marchCells(size, origin, direction, MAX_TERRAIN_WORLD_Y, (i, j, tEnter, tExit) => {
    found = terrainHitInCell(mirror, i, j, origin, direction, tEnter, tExit, risers);
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
  risers: DrawnRisers | null = null,
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

  const hit = terrainHitInCell(mirror, x, y, origin, direction, tEnter, tExit, risers);
  if (hit !== null) return hit;

  const entryY = ray.oy + tEnter * ray.dy;
  const exitY = ray.oy + tExit * ray.dy;
  const lowY = entryY < exitY ? entryY : exitY;
  const count = spanCount(mirror.map, x, y);
  for (let k = count - 1; k >= 0; k--) {
    const span = spanAt(mirror.map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    const capY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
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
