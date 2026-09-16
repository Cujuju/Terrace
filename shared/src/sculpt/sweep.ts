import { CHUNK_SIZE } from '../constants.ts';
import { chunksPerEdge } from '../chunks.ts';
import { sculptOptionsOf } from '../protocol/sculpt.ts';
import type { SculptIntent } from '../protocol/sculpt.ts';
import { footprintRadiusSquared } from './footprint.ts';

/**
 * What one stroke sweeps: the brush disc of `radius` dragged from
 * (fromX, fromY) to (toX, toY) — a capsule. A stroke that goes nowhere is the
 * disc itself.
 */
export interface StrokeSweep {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly radius: number;
}

/** A sweep that adds nothing to the brush's own reach. */
export const NO_EXTRA_REACH = 0;

/** The disc at one cell: a sweep whose ends meet. */
export function sweepAt(x: number, y: number, radius: number): StrokeSweep {
  return { fromX: x, fromY: y, toX: x, toY: y, radius };
}

export function sweepBetween(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
): StrokeSweep {
  return { fromX, fromY, toX, toY, radius };
}

/** A drag leg sweeps a capsule; every other stroke sweeps its disc. */
export function strokeSweep(intent: SculptIntent): StrokeSweep {
  const from = sculptOptionsOf(intent).sweepFrom;
  return from === null
    ? sweepAt(intent.x, intent.y, intent.radius)
    : sweepBetween(from.x, from.y, intent.x, intent.y, intent.radius);
}

/**
 * How far a sweep reaches, squared. With nothing added it is the brush disc and
 * shares the footprint's threshold; added cells grow the brush radius itself.
 */
export function sweepReachSquared(radius: number, extraCells: number): number {
  if (extraCells === NO_EXTRA_REACH) return footprintRadiusSquared(radius);
  const reach = radius + extraCells;
  return reach * reach;
}

/** The furthest one axis strays from the segment: the enumeration's margin. */
function sweepMarginCells(radius: number, extraCells: number): number {
  const reachSquared = sweepReachSquared(radius, extraCells);
  let margin = 0;
  while ((margin + 1) * (margin + 1) < reachSquared) margin++;
  return margin;
}

/**
 * Is (px, py) inside the sweep grown by `extraCells`? Squared distances only,
 * the perpendicular case multiplied through by the segment length so nothing
 * divides and nothing takes a root.
 */
export function pointWithinSweep(
  sweep: StrokeSweep,
  px: number,
  py: number,
  extraCells: number = NO_EXTRA_REACH,
): boolean {
  const reachSquared = sweepReachSquared(sweep.radius, extraCells);
  const vx = sweep.toX - sweep.fromX;
  const vy = sweep.toY - sweep.fromY;
  const wx = px - sweep.fromX;
  const wy = py - sweep.fromY;
  const along = wx * vx + wy * vy;
  if (along <= 0) return wx * wx + wy * wy < reachSquared;

  const lengthSquared = vx * vx + vy * vy;
  if (along >= lengthSquared) {
    const ux = px - sweep.toX;
    const uy = py - sweep.toY;
    return ux * ux + uy * uy < reachSquared;
  }
  const cross = wx * vy - wy * vx;
  return cross * cross < reachSquared * lengthSquared;
}

/** Every cell the sweep covers, row-major over its bounding box. */
export function forEachSweptCell(
  sweep: StrokeSweep,
  visit: (x: number, y: number) => void,
): void {
  const margin = sweepMarginCells(sweep.radius, NO_EXTRA_REACH);
  const minX = (sweep.fromX < sweep.toX ? sweep.fromX : sweep.toX) - margin;
  const maxX = (sweep.fromX > sweep.toX ? sweep.fromX : sweep.toX) + margin;
  const minY = (sweep.fromY < sweep.toY ? sweep.fromY : sweep.toY) - margin;
  const maxY = (sweep.fromY > sweep.toY ? sweep.fromY : sweep.toY) + margin;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (pointWithinSweep(sweep, x, y)) visit(x, y);
    }
  }
}

/** How many cells the sweep covers, world edges ignored: a shape, not a region. */
export function sweptCellCount(sweep: StrokeSweep): number {
  let cells = 0;
  forEachSweptCell(sweep, () => {
    cells++;
  });
  return cells;
}

function pointToRectDistanceSquared(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  return dx * dx + dy * dy;
}

/** Separating axes for a segment against an axis-aligned box: x, y, the normal. */
function segmentCrossesRect(
  sweep: StrokeSweep,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if ((sweep.fromX > sweep.toX ? sweep.fromX : sweep.toX) < x0) return false;
  if ((sweep.fromX < sweep.toX ? sweep.fromX : sweep.toX) > x1) return false;
  if ((sweep.fromY > sweep.toY ? sweep.fromY : sweep.toY) < y0) return false;
  if ((sweep.fromY < sweep.toY ? sweep.fromY : sweep.toY) > y1) return false;

  const vx = sweep.toX - sweep.fromX;
  const vy = sweep.toY - sweep.fromY;
  const side = (px: number, py: number): number =>
    Math.sign((px - sweep.fromX) * vy - (py - sweep.fromY) * vx);
  const first = side(x0, y0);
  return (
    first === 0 ||
    first !== side(x1, y0) ||
    first !== side(x0, y1) ||
    first !== side(x1, y1)
  );
}

function rectWithinSweep(
  sweep: StrokeSweep,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  reachSquared: number,
): boolean {
  if (pointToRectDistanceSquared(sweep.fromX, sweep.fromY, x0, y0, x1, y1) <= reachSquared) {
    return true;
  }
  const vx = sweep.toX - sweep.fromX;
  const vy = sweep.toY - sweep.fromY;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) return false;
  if (pointToRectDistanceSquared(sweep.toX, sweep.toY, x0, y0, x1, y1) <= reachSquared) {
    return true;
  }
  if (segmentCrossesRect(sweep, x0, y0, x1, y1)) return true;

  // Nothing else is left but a corner over the segment's flank, scaled by the
  // segment length so nothing divides.
  const budget = reachSquared * lengthSquared;
  const cornerWithin = (px: number, py: number): boolean => {
    const wx = px - sweep.fromX;
    const wy = py - sweep.fromY;
    const along = wx * vx + wy * vy;
    if (along <= 0 || along >= lengthSquared) return false;
    const cross = wx * vy - wy * vx;
    return cross * cross <= budget;
  };
  return (
    cornerWithin(x0, y0) || cornerWithin(x1, y0) || cornerWithin(x0, y1) || cornerWithin(x1, y1)
  );
}

/**
 * Chunks whose cell rectangle lies within `reachCells` of the sweep's segment,
 * row-major, iterating only the chunks in the capsule's bounding box.
 */
export function chunksWithinSweep(
  worldSize: number,
  sweep: StrokeSweep,
  reachCells: number,
): number[] {
  const n = chunksPerEdge(worldSize);
  const reachSquared = reachCells * reachCells;
  const minX = (sweep.fromX < sweep.toX ? sweep.fromX : sweep.toX) - reachCells;
  const maxX = (sweep.fromX > sweep.toX ? sweep.fromX : sweep.toX) + reachCells;
  const minY = (sweep.fromY < sweep.toY ? sweep.fromY : sweep.toY) - reachCells;
  const maxY = (sweep.fromY > sweep.toY ? sweep.fromY : sweep.toY) + reachCells;
  const firstCol = Math.max(0, Math.floor(minX / CHUNK_SIZE));
  const lastCol = Math.min(n - 1, Math.floor(maxX / CHUNK_SIZE));
  const firstRow = Math.max(0, Math.floor(minY / CHUNK_SIZE));
  const lastRow = Math.min(n - 1, Math.floor(maxY / CHUNK_SIZE));

  const reached: number[] = [];
  for (let cy = firstRow; cy <= lastRow; cy++) {
    const y0 = cy * CHUNK_SIZE;
    const y1 = y0 + CHUNK_SIZE - 1;
    for (let cx = firstCol; cx <= lastCol; cx++) {
      const x0 = cx * CHUNK_SIZE;
      const x1 = x0 + CHUNK_SIZE - 1;
      if (rectWithinSweep(sweep, x0, y0, x1, y1, reachSquared)) reached.push(cy * n + cx);
    }
  }
  return reached;
}
