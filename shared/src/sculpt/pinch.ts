import { MAX_HEIGHT, MAX_STEP } from '../constants.ts';
import { bandFloorHeight } from '../bands.ts';
import { BEDROCK_FLOOR, highestCeilingUnderSpan, spanAt, spanCount } from '../columns.ts';
import { cellIndex, cellX, cellY, inBounds, type Heightmap } from '../grid.ts';
import { graspedCeiling, graspedSpanIndex, writeGraspedCeiling } from './grasp.ts';
import { footprintRadiusSquared, forEachFootprintOffset } from './footprint.ts';
import type { SculptProfile } from './options.ts';

/** Centre lift per press per cell of radius, so a pinch keeps its shape at any size. The edge profile names the strength. */
export const PINCH_LIFT_PER_RADIUS_CELL: Readonly<Record<SculptProfile, number>> = {
  soft: MAX_STEP / 4,
  hard: MAX_STEP / 2,
  stepped: MAX_STEP,
};

/** Every cell under the brush moves at least this much, so the pinch fills the footprint it shows. */
const PINCH_MIN_UNITS = 1;

/** The height `i`'s grasped span may reach: under the span above it, and never below its own floor band. */
function spanRange(map: Heightmap, i: number, k: number): { lo: number; hi: number } {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  const top = spanCount(map, x, y) - 1;
  return {
    lo: k === 0 ? BEDROCK_FLOOR : bandFloorHeight(spanAt(map, x, y, k).floorBand),
    hi: k === top ? MAX_HEIGHT : highestCeilingUnderSpan(spanAt(map, x, y, k + 1)),
  };
}

/**
 * A stamp pinches the ground like a sheet: the centre moves in proportion to the radius,
 * falling off as (1 - d²/R²)² to nothing at the footprint's edge.
 */
export function applyPinch(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  raising: boolean,
  profile: SculptProfile,
  spanBand: number | null,
  changed: Set<number>,
): void {
  const peak = PINCH_LIFT_PER_RADIUS_CELL[profile] * radius;
  const rimSquared = footprintRadiusSquared(radius);
  const denominator = rimSquared * rimSquared;
  forEachFootprintOffset(radius, (dx, dy) => {
    const x = cx + dx;
    const y = cy + dy;
    if (!inBounds(map, x, y)) return;
    const i = cellIndex(map, x, y);
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const fall = rimSquared - (dx * dx + dy * dy);
    const lift = Math.max(PINCH_MIN_UNITS, Math.trunc((peak * fall * fall) / denominator));
    const h = graspedCeiling(map, i, k);
    const { lo, hi } = spanRange(map, i, k);
    let next = raising ? h + lift : h - lift;
    if (next > hi) next = hi;
    if (next < lo) next = lo;
    if ((raising && next <= h) || (!raising && next >= h)) return;
    writeGraspedCeiling(map, i, k, next);
    changed.add(i);
  });
}
