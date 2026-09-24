import { BAND_HEIGHT, MIN_BRUSH_RADIUS } from '../constants.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { graspedCeiling, graspedCeilingRange, graspedSpanIndex, writeGraspedCeiling } from './grasp.ts';
import { footprintRadiusSquared, isFootprintOffset } from './footprint.ts';
import type { SculptProfile } from './options.ts';

/** Lift per press of the pinched disc; the edge profile names the strength. */
export const PINCH_LIFT_UNITS: Readonly<Record<SculptProfile, number>> = {
  soft: BAND_HEIGHT / 2,
  hard: BAND_HEIGHT,
  stepped: 2 * BAND_HEIGHT,
};

/** The sheet stretches this many cells past the disc per cell of radius, and at least one. */
const PINCH_SKIRT_CELLS_PER_RADIUS = 1;
const PINCH_MIN_SKIRT_CELLS = 1;

/** Fixed-point steps per cell for skirt distances; floor(sqrt) keeps them exact. */
const SKIRT_FIXED_POINT = 256;

export function pinchSkirtCells(radius: number): number {
  return Math.max(PINCH_MIN_SKIRT_CELLS, PINCH_SKIRT_CELLS_PER_RADIUS * radius);
}

function fixedDistance(squared: number): number {
  return Math.floor(Math.sqrt(squared * SKIRT_FIXED_POINT * SKIRT_FIXED_POINT));
}

/** num / den rounded half away from zero, den > 0. */
function roundedQuotient(num: number, den: number): number {
  return num >= 0 ? Math.trunc((2 * num + den) / (2 * den)) : -Math.trunc((-2 * num + den) / (2 * den));
}

/** A stamp pinches the ground like a sheet: the whole brush moves the full lift; the skirt follows on a smoothstep. */
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
  const lift = PINCH_LIFT_UNITS[profile];
  const skirt = pinchSkirtCells(radius);
  // A one-cell brush's disc edge sits halfway to its neighbours.
  const rimFixed = radius === MIN_BRUSH_RADIUS ? SKIRT_FIXED_POINT / 2 : fixedDistance(footprintRadiusSquared(radius));
  const skirtFixed = skirt * SKIRT_FIXED_POINT;
  const skirtCubed = skirtFixed * skirtFixed * skirtFixed;
  const reach = radius + skirt;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(map, x, y)) continue;
      let amount = lift;
      if (!isFootprintOffset(radius, dx, dy)) {
        const t = fixedDistance(dx * dx + dy * dy) - rimFixed;
        if (t >= skirtFixed) continue;
        const along = t < 0 ? 0 : t;
        // 1 - smoothstep: flat against the disc, flat where the sheet meets the ground.
        amount = roundedQuotient(lift * (skirtCubed - 3 * along * along * skirtFixed + 2 * along * along * along), skirtCubed);
        if (amount === 0) continue;
      }
      const i = cellIndex(map, x, y);
      const k = graspedSpanIndex(map, i, spanBand);
      if (k === null) continue;
      const h = graspedCeiling(map, i, k);
      const { lo, hi } = graspedCeilingRange(map, i, k);
      let next = raising ? h + amount : h - amount;
      if (next > hi) next = hi;
      if (next < lo) next = lo;
      if (next === h || (raising ? next < h : next > h)) continue;
      writeGraspedCeiling(map, i, k, next);
      changed.add(i);
    }
  }
}
