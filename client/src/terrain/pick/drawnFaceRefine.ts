import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  chunkIndex,
  drawnBandOfSample,
  drawnSpanCapHeight,
  isSpanDrawn,
  spanAt,
  spanCapBand,
  spanCount,
  type Span,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../../config.ts';
import { drawnBandAtY } from '../capEmission.ts';
import { crossRayWithWallPlan } from '../drawnFace.ts';
import type { TerrainMirror } from '../mirror.ts';
import {
  MARCH_CEILING_WORLD_Y,
  cellRevealed,
  clipRayToBox,
  scaleRayToCellSpace,
} from './rayMarch.ts';
import type { DrawnRisers, TerrainRayPick, Vec3 } from './types.ts';

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

export function refineRiserToDrawnFace(
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
  // F7: the riser window is the span's own drawn band range, so it matches
  // the emitted skirts exactly.
  const lowestBand = span.floorBand;
  const highestBand = spanCapBand(span);

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
    // Owner rule: the nearer surface wins. A drawn wall crossing strictly
    // before the cap strike reports riser even over the cap strip; only a
    // level-face-first strike stays tread.
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
    const riserY = bestLedgeBand === null
      ? origin.y + bestT * direction.y
      : bestLedgeBand * bandSlab;
    return {
      ...hit,
      face: 'riser',
      band: drawnBandAtY(riserY),
      hitY: riserY,
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
      band: drawnBandAtY(capY),
      hitY: capY,
      hitX: origin.x + t * direction.x,
      hitZ: origin.z + t * direction.z,
    };
  }
  return null;
}
