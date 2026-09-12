import {
  CHUNK_SIZE,
  DRAWN_GROUND_BAND_BIAS,
  DRAWN_GROUND_COORD_DENOM,
  ISOLINE_SAMPLES_PER_CELL,
  MAX_BRUSH_RADIUS,
  drawnCrossingFraction,
  drawnIsolineAt,
} from '@terrace/shared';
import { sampleRenderHeight, type TerrainMirror } from './mirror.ts';

export const LATTICE_PER_CHUNK = CHUNK_SIZE + 1;

export const RECT_NONE = 0;
const RECT_WEST = 1;
const RECT_EAST = 2;
const RECT_NORTH = 4;
const RECT_SOUTH = 8;

export interface ContourPoint {
  x: number;
  z: number;
  rect: number;
}

export type ContourLoop = ContourPoint[];

export function isSeamSegment(a: ContourPoint, b: ContourPoint): boolean {
  return (a.rect & b.rect) !== 0;
}

export const MAX_LATTICE_SPAN = Math.max(CHUNK_SIZE, 2 * MAX_BRUSH_RADIUS + 2);
const MAX_LATTICE_PER_SPAN = MAX_LATTICE_SPAN + 1;

let activeSpan = CHUNK_SIZE;
let activeLattice = LATTICE_PER_CHUNK;

export const SAMPLE_COUNT = LATTICE_PER_CHUNK * LATTICE_PER_CHUNK;
const SAMPLE_CAPACITY = MAX_LATTICE_PER_SPAN * MAX_LATTICE_PER_SPAN;
export const samples = new Int32Array(SAMPLE_CAPACITY);

const H_EDGE_COUNT = MAX_LATTICE_SPAN * MAX_LATTICE_PER_SPAN;
const V_EDGE_COUNT = MAX_LATTICE_PER_SPAN * MAX_LATTICE_SPAN;
const EDGE_COUNT = H_EDGE_COUNT + V_EDGE_COUNT;
const MAX_SEGMENTS = 2 * MAX_LATTICE_SPAN * MAX_LATTICE_SPAN;

const edgeCrossed = new Uint8Array(EDGE_COUNT);
const edgeX = new Float64Array(EDGE_COUNT);
const edgeZ = new Float64Array(EDGE_COUNT);
const segmentFrom = new Int32Array(MAX_SEGMENTS);
const segmentTo = new Int32Array(MAX_SEGMENTS);
const segmentUsed = new Uint8Array(MAX_SEGMENTS);
const segmentLeaving = new Int32Array(EDGE_COUNT);
const edgeHasEntry = new Uint8Array(EDGE_COUNT);

const ISOLINE_POINTS_PER_SEGMENT = ISOLINE_SAMPLES_PER_CELL - 1;
const segmentIsoX = new Float64Array(MAX_SEGMENTS * ISOLINE_POINTS_PER_SEGMENT);
const segmentIsoZ = new Float64Array(MAX_SEGMENTS * ISOLINE_POINTS_PER_SEGMENT);
const segmentIsoCount = new Int32Array(MAX_SEGMENTS);

export function loadSamples(mirror: TerrainMirror, originX: number, originZ: number): void {
  activeSpan = CHUNK_SIZE;
  activeLattice = LATTICE_PER_CHUNK;
  for (let j = 0; j < activeLattice; j++) {
    for (let i = 0; i < activeLattice; i++) {
      samples[j * activeLattice + i] = sampleRenderHeight(
        mirror,
        originX + i,
        originZ + j,
      );
    }
  }
}

export function loadSampleField(
  fill: (i: number, j: number) => number,
  span: number = CHUNK_SIZE,
): void {
  if (span < 1 || span > MAX_LATTICE_SPAN) {
    throw new RangeError(`lattice span ${span} outside [1, ${MAX_LATTICE_SPAN}]`);
  }
  activeSpan = span;
  activeLattice = span + 1;
  for (let j = 0; j < activeLattice; j++) {
    for (let i = 0; i < activeLattice; i++) {
      samples[j * activeLattice + i] = fill(i, j);
    }
  }
}

const horizontalEdgeKey = (i: number, j: number): number => j * MAX_LATTICE_SPAN + i;
const verticalEdgeKey = (i: number, j: number): number =>
  H_EDGE_COUNT + j * MAX_LATTICE_PER_SPAN + i;

const SQUARE_EDGE_BOTTOM = 0;
const SQUARE_EDGE_RIGHT = 1;
const SQUARE_EDGE_TOP = 2;
const SQUARE_EDGE_LEFT = 3;

const B = SQUARE_EDGE_BOTTOM;
const R = SQUARE_EDGE_RIGHT;
const T = SQUARE_EDGE_TOP;
const L = SQUARE_EDGE_LEFT;
const MARCHING_CASES: readonly (readonly number[])[] = [
  [],
  [B, L],
  [R, B],
  [R, L],
  [T, R],
  [],
  [T, B],
  [T, L],
  [L, T],
  [B, T],
  [],
  [R, T],
  [L, R],
  [B, R],
  [L, B],
  [],
];
const MARCHING_SADDLE_5_JOINED: readonly number[] = [B, R, T, L];
const MARCHING_SADDLE_5_SPLIT: readonly number[] = [B, L, T, R];
const MARCHING_SADDLE_10_JOINED: readonly number[] = [L, B, R, T];
const MARCHING_SADDLE_10_SPLIT: readonly number[] = [R, B, L, T];

function crossingFraction(
  outsideHeight: number,
  insideHeight: number,
  threshold: number,
  override: number | null,
): number {
  if (override !== null) return override;
  return drawnCrossingFraction(outsideHeight, insideHeight, threshold);
}

export function levelBandBias(crossingOverride: number | null): number {
  return crossingOverride === null ? DRAWN_GROUND_BAND_BIAS : 0;
}

export function domainInside(threshold: number, crossingOverride: number | null): boolean {
  return samples[0] + levelBandBias(crossingOverride) >= threshold;
}

export function marchLevel(
  threshold: number,
  originX: number,
  originZ: number,
  crossingOverride: number | null,
): number {
  segmentLeaving.fill(-1);
  edgeHasEntry.fill(0);
  edgeCrossed.fill(0);

  const bias = levelBandBias(crossingOverride);
  const inside = (i: number, j: number): boolean =>
    samples[j * activeLattice + i] + bias >= threshold;
  const heightAt = (i: number, j: number): number =>
    samples[j * activeLattice + i];

  const traceIsoline = (
    segment: number,
    i: number,
    j: number,
    fromKey: number,
    toKey: number,
  ): void => {
    segmentIsoCount[segment] = 0;
    if (crossingOverride !== null) return;
    const ax = edgeX[fromKey] - originX - i;
    const az = edgeZ[fromKey] - originZ - j;
    const bx = edgeX[toKey] - originX - i;
    const bz = edgeZ[toKey] - originZ - j;
    const spanU = Math.abs(bx - ax);
    const spanV = Math.abs(bz - az);
    if (spanU + spanV < ISOLINE_SAMPLES_PER_CELL / DRAWN_GROUND_COORD_DENOM) return;
    const alongX = spanU >= spanV;
    const northWest = heightAt(i, j);
    const northEast = heightAt(i + 1, j);
    const southWest = heightAt(i, j + 1);
    const southEast = heightAt(i + 1, j + 1);
    const base = segment * ISOLINE_POINTS_PER_SEGMENT;
    const chordLengthSquared = (bx - ax) * (bx - ax) + (bz - az) * (bz - az);
    let written = 0;
    let advanced = 0;
    for (let k = 1; k < ISOLINE_SAMPLES_PER_CELL; k++) {
      const t = k / ISOLINE_SAMPLES_PER_CELL;
      const fixedUnits = clampUnits(
        Math.round(
          (alongX ? ax + (bx - ax) * t : az + (bz - az) * t) * DRAWN_GROUND_COORD_DENOM,
        ),
      );
      const solved = drawnIsolineAt(
        northWest,
        northEast,
        southWest,
        southEast,
        threshold,
        fixedUnits,
        alongX,
      );
      if (solved === null || solved <= 0 || solved >= 1) continue;
      const fixed = fixedUnits / DRAWN_GROUND_COORD_DENOM;
      const u = alongX ? fixed : solved;
      const v = alongX ? solved : fixed;
      const along = ((u - ax) * (bx - ax) + (v - az) * (bz - az)) / chordLengthSquared;
      if (!(along > advanced) || !(along < 1)) continue;
      advanced = along;
      segmentIsoX[base + written] = originX + i + u;
      segmentIsoZ[base + written] = originZ + j + v;
      written++;
    }
    segmentIsoCount[segment] = written;
  };

  for (let j = 0; j < activeLattice; j++) {
    for (let i = 0; i < activeSpan; i++) {
      const left = inside(i, j);
      const right = inside(i + 1, j);
      if (left === right) continue;
      const key = horizontalEdgeKey(i, j);
      const s = right
        ? crossingFraction(heightAt(i, j), heightAt(i + 1, j), threshold, crossingOverride)
        : crossingFraction(heightAt(i + 1, j), heightAt(i, j), threshold, crossingOverride);
      edgeCrossed[key] = 1;
      edgeX[key] = originX + (right ? i + s : i + 1 - s);
      edgeZ[key] = originZ + j;
    }
  }
  for (let j = 0; j < activeSpan; j++) {
    for (let i = 0; i < activeLattice; i++) {
      const near = inside(i, j);
      const far = inside(i, j + 1);
      if (near === far) continue;
      const key = verticalEdgeKey(i, j);
      const s = far
        ? crossingFraction(heightAt(i, j), heightAt(i, j + 1), threshold, crossingOverride)
        : crossingFraction(heightAt(i, j + 1), heightAt(i, j), threshold, crossingOverride);
      edgeCrossed[key] = 1;
      edgeX[key] = originX + i;
      edgeZ[key] = originZ + (far ? j + s : j + 1 - s);
    }
  }

  let count = 0;
  for (let j = 0; j < activeSpan; j++) {
    for (let i = 0; i < activeSpan; i++) {
      const a = inside(i, j) ? 1 : 0;
      const b = inside(i + 1, j) ? 2 : 0;
      const c = inside(i + 1, j + 1) ? 4 : 0;
      const d = inside(i, j + 1) ? 8 : 0;
      const caseIndex = a | b | c | d;
      let pairs: readonly number[] = MARCHING_CASES[caseIndex];
      if (caseIndex === 5 || caseIndex === 10) {
        const mean =
          (heightAt(i, j) +
            heightAt(i + 1, j) +
            heightAt(i + 1, j + 1) +
            heightAt(i, j + 1)) /
          4;
        const joined = mean + bias >= threshold;
        pairs =
          caseIndex === 5
            ? joined
              ? MARCHING_SADDLE_5_JOINED
              : MARCHING_SADDLE_5_SPLIT
            : joined
              ? MARCHING_SADDLE_10_JOINED
              : MARCHING_SADDLE_10_SPLIT;
      }
      for (let p = 0; p < pairs.length; p += 2) {
        const fromKey = squareEdgeKey(i, j, pairs[p]);
        const toKey = squareEdgeKey(i, j, pairs[p + 1]);
        segmentFrom[count] = fromKey;
        segmentTo[count] = toKey;
        segmentLeaving[fromKey] = count;
        edgeHasEntry[toKey] = 1;
        traceIsoline(count, i, j, fromKey, toKey);
        count++;
      }
    }
  }
  return count;
}

function clampUnits(units: number): number {
  if (!(units > 0)) return 0;
  return units > DRAWN_GROUND_COORD_DENOM ? DRAWN_GROUND_COORD_DENOM : units;
}

function squareEdgeKey(i: number, j: number, slot: number): number {
  switch (slot) {
    case SQUARE_EDGE_BOTTOM:
      return horizontalEdgeKey(i, j);
    case SQUARE_EDGE_RIGHT:
      return verticalEdgeKey(i + 1, j);
    case SQUARE_EDGE_TOP:
      return horizontalEdgeKey(i, j + 1);
    default:
      return verticalEdgeKey(i, j);
  }
}

function rectMaskOf(x: number, z: number, x0: number, z0: number): number {
  let mask = RECT_NONE;
  if (x === x0) mask |= RECT_WEST;
  if (x === x0 + activeSpan) mask |= RECT_EAST;
  if (z === z0) mask |= RECT_NORTH;
  if (z === z0 + activeSpan) mask |= RECT_SOUTH;
  return mask;
}

function perimeterOf(p: ContourPoint, x0: number, z0: number): number {
  const s = activeSpan;
  if ((p.rect & RECT_NORTH) !== 0 && (p.rect & RECT_EAST) === 0) return p.x - x0;
  if ((p.rect & RECT_EAST) !== 0 && (p.rect & RECT_SOUTH) === 0) return s + (p.z - z0);
  if ((p.rect & RECT_SOUTH) !== 0 && (p.rect & RECT_WEST) === 0) {
    return 2 * s + (x0 + s - p.x);
  }
  return 3 * s + (z0 + s - p.z);
}

function rectCorners(x0: number, z0: number): ContourPoint[] {
  const s = activeSpan;
  return [
    { x: x0, z: z0, rect: RECT_WEST | RECT_NORTH },
    { x: x0 + s, z: z0, rect: RECT_EAST | RECT_NORTH },
    { x: x0 + s, z: z0 + s, rect: RECT_EAST | RECT_SOUTH },
    { x: x0, z: z0 + s, rect: RECT_WEST | RECT_SOUTH },
  ];
}

function pointOfEdge(key: number, x0: number, z0: number): ContourPoint {
  const x = edgeX[key];
  const z = edgeZ[key];
  return { x, z, rect: rectMaskOf(x, z, x0, z0) };
}

function pushDistinct(points: ContourPoint[], point: ContourPoint): void {
  const last = points.length > 0 ? points[points.length - 1] : null;
  if (last !== null && samePoint(last, point)) return;
  points.push(point);
}

function pushIsoline(
  points: ContourPoint[],
  segment: number,
  x0: number,
  z0: number,
): void {
  const base = segment * ISOLINE_POINTS_PER_SEGMENT;
  for (let k = 0; k < segmentIsoCount[segment]; k++) {
    const x = segmentIsoX[base + k];
    const z = segmentIsoZ[base + k];
    if (rectMaskOf(x, z, x0, z0) !== RECT_NONE) continue;
    pushDistinct(points, { x, z, rect: RECT_NONE });
  }
}

export function assembleLoops(
  segmentCount: number,
  x0: number,
  z0: number,
  wholeDomainInside: boolean,
): ContourLoop[] {
  const loops: ContourLoop[] = [];
  if (segmentCount === 0) {
    if (wholeDomainInside) loops.push(rectCorners(x0, z0));
    return loops;
  }
  segmentUsed.fill(0, 0, segmentCount);

  interface OpenChain {
    points: ContourPoint[];
    startPerimeter: number;
    endPerimeter: number;
  }
  const chains: OpenChain[] = [];
  for (let s = 0; s < segmentCount; s++) {
    if (segmentUsed[s] === 1) continue;
    if (edgeHasEntry[segmentFrom[s]] === 1) continue;
    const points: ContourPoint[] = [pointOfEdge(segmentFrom[s], x0, z0)];
    let cursor = s;
    for (;;) {
      segmentUsed[cursor] = 1;
      pushIsoline(points, cursor, x0, z0);
      const toKey = segmentTo[cursor];
      pushDistinct(points, pointOfEdge(toKey, x0, z0));
      const next = segmentLeaving[toKey];
      if (next < 0 || segmentUsed[next] === 1) break;
      cursor = next;
    }
    chains.push({
      points,
      startPerimeter: perimeterOf(points[0], x0, z0),
      endPerimeter: perimeterOf(points[points.length - 1], x0, z0),
    });
  }

  for (let s = 0; s < segmentCount; s++) {
    if (segmentUsed[s] === 1) continue;
    const points: ContourPoint[] = [pointOfEdge(segmentFrom[s], x0, z0)];
    let cursor = s;
    for (;;) {
      segmentUsed[cursor] = 1;
      pushIsoline(points, cursor, x0, z0);
      const toKey = segmentTo[cursor];
      const next = segmentLeaving[toKey];
      if (next < 0 || segmentUsed[next] === 1) break;
      pushDistinct(points, pointOfEdge(toKey, x0, z0));
      cursor = next;
    }
    if (points.length >= 3) loops.push(points);
  }

  if (chains.length === 0) {
    if (wholeDomainInside) loops.push(rectCorners(x0, z0));
    return loops;
  }

  const corners = rectCorners(x0, z0);
  const cornerPerimeter = corners.map((c, index) => index * activeSpan);
  const byStart = chains.map((_, index) => index);
  byStart.sort((a, b) => chains[a].startPerimeter - chains[b].startPerimeter);

  const consumed = new Uint8Array(chains.length);
  for (const seed of byStart) {
    if (consumed[seed] === 1) continue;
    const loop: ContourPoint[] = [];
    let current = seed;
    for (;;) {
      consumed[current] = 1;
      const chain = chains[current];
      for (const p of chain.points) loop.push(p);

      let best = -1;
      let bestGap = Infinity;
      for (let k = 0; k < chains.length; k++) {
        const gap = cyclicGap(chain.endPerimeter, chains[k].startPerimeter);
        if (gap < bestGap) {
          bestGap = gap;
          best = k;
        }
      }
      if (best < 0) break;
      const passed: number[] = [];
      for (let c = 0; c < corners.length; c++) {
        if (cyclicGap(chain.endPerimeter, cornerPerimeter[c]) < bestGap) passed.push(c);
      }
      passed.sort(
        (a, b) =>
          cyclicGap(chain.endPerimeter, cornerPerimeter[a]) -
          cyclicGap(chain.endPerimeter, cornerPerimeter[b]),
      );
      for (const c of passed) loop.push(corners[c]);
      if (best === seed) break;
      if (consumed[best] === 1) break;
      current = best;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function cyclicGap(from: number, to: number): number {
  const perimeter = 4 * activeSpan;
  const gap = to - from;
  return gap > 0 ? gap : gap + perimeter;
}

export function samePoint(a: ContourPoint, b: ContourPoint): boolean {
  return a.x === b.x && a.z === b.z;
}
