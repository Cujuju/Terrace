import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DRAWN_GROUND_BAND_BIAS,
  ISOLINE_SAMPLES_PER_CELL,
  MAX_HEIGHT,
  MIN_HEIGHT,
  chunkIndex,
  drawnBandAt,
  drawnBandOfSample,
  drawnLevelThreshold,
  drawnSpanCapHeight,
  drawnSpanIndexCoveringBand,
  isSpanDrawn,
  spanAt,
  spanCount,
  spanUndersideHeight,
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

export type PickFace = 'riser' | 'tread' | 'underside';

export interface TerrainRayPick {
  readonly x: number;
  readonly y: number;
  readonly surfaceY: number;
  readonly spanIndex: number;
  readonly face: PickFace;
  readonly hitY: number;
  readonly hitX: number;
  readonly hitZ: number;
}

const MAX_TERRAIN_WORLD_Y = MAX_HEIGHT * HEIGHT_WORLD_SCALE;
const MIN_TERRAIN_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE;

/** Clears the top drawn cap, so a ray is never clipped to start ON a cap plane. */
const MARCH_CEILING_WORLD_Y = MAX_TERRAIN_WORLD_Y + BAND_WORLD_HEIGHT;

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
  // F7: both riser-window bounds come from the drawn banding (bias + shore),
  // not the blocky quantize, so the window matches the emitted skirts.
  const lowestBand = drawnBandOfSample(spanUndersideHeight(span)) + 1;
  const highestBand = drawnBandOfSample(span.ceiling);

  const ray = scaleRayToCellSpace(origin, direction);
  const window = ray === null ? null : clipRayToBox(
    ray,
    i - DRAWN_FACE_MARGIN_CELLS,
    i + 1 + DRAWN_FACE_MARGIN_CELLS,
    j - DRAWN_FACE_MARGIN_CELLS,
    j + 1 + DRAWN_FACE_MARGIN_CELLS,
    MARCH_CEILING_WORLD_Y,
  );
  const fromT = window === null ? tEnter : window.tEnter;
  const toT = window === null ? tExit : window.tExit;

  const yA = origin.y + fromT * direction.y;
  const yB = origin.y + toT * direction.y;
  const yMin = yA < yB ? yA : yB;
  const yMax = yA < yB ? yB : yA;
  const bandSlab = BAND_HEIGHT * HEIGHT_WORLD_SCALE;
  // F7: the ray-Y window is also drawn-banded (bias + shore), via
  // drawnBandOfSample, so a bias-shifted ceiling does not open a phantom band.
  const drawnFirst = drawnBandOfSample(yMin / HEIGHT_WORLD_SCALE);
  const drawnLast = drawnBandOfSample(yMax / HEIGHT_WORLD_SCALE) + 1;
  const firstBand = Math.max(lowestBand, drawnFirst);
  const lastBand = Math.min(highestBand, drawnLast);

  if (lastBand < firstBand) return hit;

  if (hit.face !== 'riser' && !capPointIsOverStrip(
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
    // Owner rule: the nearer surface wins, period. A drawn wall crossing
    // strictly before the cap strike means the cursor is on a sheer face, so
    // it reports riser even over the cap strip (smoothing can inset drawn
    // walls up to half a cell from the blocky wall). Only a level-face-first
    // strike stays tread. (The old capPointIsOverStrip veto is gone: it kept
    // wall-first hits tread and made sheer faces unselectable.)
    if (hit.face !== 'riser') {
      const tHit = direction.y === 0
        ? tEnter
        : tEnter + (hit.hitY - (origin.y + tEnter * direction.y)) / direction.y;
      const wallFirst = footT < tHit;
      if (!wallFirst) {
        return treadOfEnteredNeighbour(
          mirror, i, j, origin, direction, tEnter, tExit, footT, hit.surfaceY,
        ) ?? hit;
      }
    }
    return {
      ...hit,
      face: 'riser',
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
  // F6: horizontal rays run parallel to treads, so the rim is unreachable;
  // upward rays can never strike a tread from above. Both miss explicitly.
  if (dy === 0) return null;
  if (dy > 0) return null;
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
      face: 'tread',
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
  readonly band: number;
  readonly capY: number;
  readonly drawnY: number;
  readonly u: number;
  readonly v: number;
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
    const drawnY = drawnBandCapY(band);
    if (ray.oy + t * ray.dy <= drawnY) {
      return { t, band, capY: band * BAND_WORLD_HEIGHT, drawnY, u, v };
    }
  }
  return null;
}

// F2: the drawn contour can sit diagonally across the cell, so the owner
// search covers all 8 neighbours by centre distance.
const NEIGHBOUR_STEPS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

interface BandOwner {
  readonly x: number;
  readonly y: number;
  readonly spanIndex: number;
}

function spanStruckAt(
  mirror: TerrainMirror,
  x: number,
  y: number,
  band: number,
  faceY: number,
): number | null {
  // F3: drawn thresholds — the biased shoreline threshold in raw-height form,
  // the drawn cap above. The cue floor stays the blocky underside so a wall
  // whose foot was carved keeps owning its upper bands (agreement sweep).
  const threshold = drawnLevelThreshold(band) - DRAWN_GROUND_BAND_BIAS;
  const count = spanCount(mirror.map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(mirror.map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    if (span.floor > threshold || threshold > drawnSpanCapHeight(span)) continue;
    const drawnCapWorld = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
    if (faceY < spanUndersideHeight(span) * HEIGHT_WORLD_SCALE) continue;
    if (faceY > drawnCapWorld) continue;
    return k;
  }
  return null;
}

export function columnOwningBand(
  mirror: TerrainMirror,
  i: number,
  j: number,
  u: number,
  v: number,
  band: number,
  faceY: number,
): BandOwner | null {
  const last = mirror.map.size - 1;
  let owner: BandOwner | null = null;
  let nearest = Infinity;
  for (const [dx, dz] of NEIGHBOUR_STEPS) {
    const x = i + dx;
    const y = j + dz;
    if (x < 0 || y < 0 || x > last || y > last) continue;
    const spanIndex = spanStruckAt(mirror, x, y, band, faceY);
    if (spanIndex === null) continue;
    const offX = x + CELL_CENTRE_OFFSET - u;
    const offZ = y + CELL_CENTRE_OFFSET - v;
    const distance = offX * offX + offZ * offZ;
    if (distance >= nearest) continue;
    nearest = distance;
    owner = { x, y, spanIndex };
  }
  return owner;
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
  let hitMet: DrawnCap | null = null;
  for (let k = count - 1; k >= 0; k--) {
    const span = spanAt(mirror.map, i, j, k);
    if (!isSpanDrawn(span)) continue;
    // F1: test the wall crossing BEFORE the drawnCapMet gate. A grazing ray
    // can enter the cell through its side wall inside [baseY, drawnTop] while
    // never dipping below the drawn cap along its chord; the gate is then only
    // the fast path for rays that miss both cap and wall.
    let met: DrawnCap | null = null;
    if (k === count - 1 && ray !== null) {
      met = drawnCapMet(mirror, ray, tEnter, tExit);
      if (met === null) {
        const drawnTopY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
        // Drawn wall foot, not the blocky underside: a carved gap must read
        // as open so the ray passes to the cell beyond.
        const wallBaseY = drawnBandOfSample(span.floor) * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
        const horizontal = ray.dx !== 0 || ray.dz !== 0;
        const entersThroughWall = horizontal && entryY <= drawnTopY && entryY >= wallBaseY;
        if (!entersThroughWall) continue;
      }
    }
    const capY = met === null ? drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE : met.capY;
    const drawnY = met === null ? blockyCellCapY(span.ceiling) : met.drawnY;
    const baseY = spanUndersideHeight(span) * HEIGHT_WORLD_SCALE;
    const lowY = entryY < exitY ? entryY : exitY;
    const highY = entryY < exitY ? exitY : entryY;
    if (lowY > drawnY || highY < baseY) continue;
    // F4: snap underside cues to the drawn ceiling. The mesh draws the gap
    // floor as a ceiling polygon at the drawn cap, so reporting the drawn cap
    // matches the polygon refinement without walking any polygons.
    const drawnCeilingY = drawnSpanCapHeight(span) * HEIGHT_WORLD_SCALE;
    // F8: an entry exactly ON the column's own drawn cap is a level face. A
    // flat cap picks as tread whatever its height.
    const onOwnCap = entryY === drawnY && drawnY === drawnCeilingY;
    const insideOnEntry = !onOwnCap && entryY <= drawnY && entryY >= baseY;
    const onOrAboveCap = !insideOnEntry && entryY >= drawnY;
    const faceY = insideOnEntry ? entryY : onOrAboveCap ? capY : drawnCeilingY;
    const metY = insideOnEntry ? entryY : onOrAboveCap ? drawnY : drawnCeilingY;
    const planeT = insideOnEntry || dy === 0 ? tEnter : tEnter + (metY - entryY) / dy;
    const t = met !== null && insideOnEntry && planeT < met.t ? met.t : planeT;
    if (t >= hitT) continue;
    hitT = t;
    hit = {
      x: i,
      y: j,
      surfaceY: capY,
      spanIndex: k,
      face: insideOnEntry ? 'riser' : onOrAboveCap ? 'tread' : 'underside',
      hitY: faceY,
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
    hitSpan = span;
    hitMet = met;
  }
  if (hit !== null && hitMet !== null && hit.spanIndex === count - 1) {
    // F2: never-null fallback for cap strikes from above. drawnBandAt produced
    // this hit, so when no neighbour owns the band the hit stays on the
    // entered cell's top span instead of vanishing. Horizontal grazing rays
    // keep the old miss (null) so a carved gap still reads as open passage.
    if (drawnSpanIndexCoveringBand(mirror.map, i, j, hitMet.band) !== null) {
      hitSpan = spanAt(mirror.map, i, j, hit.spanIndex);
      hit = { ...hit, surfaceY: drawnSpanCapHeight(hitSpan) * HEIGHT_WORLD_SCALE };
    } else if (direction.y < 0) {
      const found = columnOwningBand(mirror, i, j, hitMet.u, hitMet.v, hitMet.band, hit.hitY) ?? {
        x: i,
        y: j,
        spanIndex: count - 1,
      };
      hitSpan = spanAt(mirror.map, found.x, found.y, found.spanIndex);
      hit = {
        ...hit,
        x: found.x,
        y: found.y,
        spanIndex: found.spanIndex,
        surfaceY: drawnSpanCapHeight(hitSpan) * HEIGHT_WORLD_SCALE,
      };
    } else {
      return null;
    }
  }
  const refinable = hit !== null && hit.face !== 'underside';
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
  marchCells(size, origin, direction, MARCH_CEILING_WORLD_Y, (i, j, tEnter, tExit) => {
    found = terrainHitInCell(mirror, i, j, origin, direction, tEnter, tExit, risers);
    return found !== null;
  });
  return found;
}

/** Where along the ray a world point sits. Read on the ray's longest axis. */
function rayParameterAt(origin: Vec3, direction: Vec3, x: number, y: number, z: number): number {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  if (ax >= ay && ax >= az) return (x - origin.x) / direction.x;
  if (ay >= az) return (y - origin.y) / direction.y;
  return (z - origin.z) / direction.z;
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
  const strikeT = rayParameterAt(origin, direction, aim.hitX, aim.hitY, aim.hitZ);
  let reached = false;
  let found: { x: number; y: number } | null = null;
  marchCells(size, origin, direction, MARCH_CEILING_WORLD_Y, (i, j, _tEnter, tExit) => {
    if (!reached) {
      if (tExit < strikeT) return false;
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

  // F5 (chosen): a pinned-column miss returns null. Falling back to the tread
  // below the ray would name a cell the march never struck, so sculpt would
  // cut a band the cursor is not on.
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
