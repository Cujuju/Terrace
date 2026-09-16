import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  SOFT_EDGE_STRENGTH_DENOMINATOR,
  SOFT_EDGE_STRENGTH_NUMERATOR,
} from '../constants.ts';
import { bandLevelHeight, stepTowardBand } from '../bands.ts';
import { cellIndex, cellX, cellY, inBounds, type Heightmap } from '../grid.ts';
import {
  canSpreadBandTo,
  clampHeight,
  graspedCeiling,
  graspedSpanIndex,
} from './grasp.ts';
import type { SculptProfile } from './options.ts';

export function forEachFootprintOffset(
  radius: number,
  visit: (dx: number, dy: number, dist: number) => void,
): void {
  if (radius === 1) {
    visit(0, 0, 0);
    return;
  }
  for (let dy = -(radius - 1); dy <= radius - 1; dy++) {
    for (let dx = -(radius - 1); dx <= radius - 1; dx++) {
      if (!isFootprintOffset(radius, dx, dy)) continue;
      visit(dx, dy, Math.floor(Math.sqrt(dx * dx + dy * dy)));
    }
  }
}

/** Only the centre offset is inside a one-cell brush. */
const SINGLE_CELL_RADIUS_SQUARED = 1;

/** The one disc threshold: `dx² + dy²` below it is inside a brush of `radius`. */
export function footprintRadiusSquared(radius: number): number {
  return radius === MIN_BRUSH_RADIUS ? SINGLE_CELL_RADIUS_SQUARED : radius * (radius - 1);
}

export function isFootprintOffset(radius: number, dx: number, dy: number): boolean {
  return dx * dx + dy * dy < footprintRadiusSquared(radius);
}

export function forEachFootprintCell(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  visit: (i: number, dist: number) => void,
): void {
  forEachFootprintOffset(radius, (dx, dy, dist) => {
    const x = cx + dx;
    const y = cy + dy;
    if (!inBounds(map, x, y)) return;
    visit(cellIndex(map, x, y), dist);
  });
}

/**
 * One stroke's step for one cell: an anchored press lands on the canonical
 * level of the drawn band it crosses into, never short of it; a free press
 * moves `amount`.
 */
export function pressDelta(amount: number, from: number, anchored: boolean): number {
  if (!anchored) return amount;
  const raising = amount > 0;
  const magnitude = amount < 0 ? -amount : amount;
  const level = stepTowardBand(from, raising);
  const crossing = raising ? level - from : from - level;
  const step = crossing > magnitude ? crossing : magnitude;
  return raising ? step : -step;
}

export function brushDelta(
  amount: number,
  radius: number,
  dist: number,
  profile: SculptProfile,
): number {
  if (profile === 'hard') return amount;
  // Linear ramp from the centre to the outermost ring (dist = radius - 1),
  // which keeps the edge fraction instead of fading to nothing.
  const span = radius - 1;
  if (span === 0) return amount;
  const weight =
    SOFT_EDGE_STRENGTH_NUMERATOR * span +
    (SOFT_EDGE_STRENGTH_DENOMINATOR - SOFT_EDGE_STRENGTH_NUMERATOR) * (span - dist);
  return Math.trunc((amount * weight) / (SOFT_EDGE_STRENGTH_DENOMINATOR * span));
}

export function spreadableFootprintCells(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  band: number,
): ReadonlySet<number> {
  const spreadable = new Set<number>();
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    if (canSpreadBandTo(map, cellX(map.size, i), cellY(map.size, i), band)) spreadable.add(i);
  });
  return spreadable;
}

export function assertBrushRadius(radius: number): void {
  if (
    !Number.isInteger(radius) ||
    radius < MIN_BRUSH_RADIUS ||
    radius > MAX_BRUSH_RADIUS
  ) {
    throw new RangeError(`brush radius ${radius} outside [${MIN_BRUSH_RADIUS}, ${MAX_BRUSH_RADIUS}]`);
  }
}

export function assertBrushArgs(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
): void {
  if (!inBounds(map, cx, cy)) {
    throw new RangeError(`brush center (${cx},${cy}) out of bounds`);
  }
  assertBrushRadius(radius);
  if (!Number.isInteger(amount)) {
    throw new RangeError(`brush amount must be an integer, got ${amount}`);
  }
}

export function anchoredTargetHeight(
  map: Heightmap,
  cx: number,
  cy: number,
  raising: boolean,
  targetBand: number | null = null,
  spanBand: number | null = null,
): number {
  if (targetBand !== null) return clampHeight(bandLevelHeight(targetBand));
  const centre = cellIndex(map, cx, cy);
  const k = graspedSpanIndex(map, centre, spanBand);
  const here = k === null ? map.cells[centre]! : graspedCeiling(map, centre, k);
  // A raise out of the sea must break the surface: SEA_LEVEL still draws as
  // sea, and stepTowardBand crosses at least one drawn band per press.
  return clampHeight(stepTowardBand(here, raising));
}
