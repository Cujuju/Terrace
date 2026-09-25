import { MIN_BRUSH_RADIUS, STEPPED_RING_WIDTH_CELLS } from '../constants.ts';
import { bandLevelHeight, drawnBandOfSample } from '../bands.ts';
import { cellIndex, inBounds, type Heightmap } from '../grid.ts';
import { footprintRingQuarters, type EdgeShape } from './edges.ts';
import { anchoredTargetHeight, footprintRadiusSquared } from './footprint.ts';
import { clampHeight, graspedCeiling, graspedCeilingRange, graspedSpanIndex, writeGraspedCeiling } from './grasp.ts';
import type { SculptProfile } from './options.ts';

// A clicked stamp builds a mound a band per press: the disc is its top; the
// profile shapes the flanks (hard stacked, stepped pyramid, soft parabola).

/** Flank bands a mound shapes; a taller mound's flanks continue as a wall. */
export const MOUND_MAX_FLANK_BANDS = 8;

/** A parabola's first flank band sits this many cells out per two cells of radius, and at least a tread. */
const PARABOLA_RADIUS_DIVISOR = 2;

/** Quarter-cells² per cell², and fixed-point steps per cell for the parabola's square roots. */
const QUARTERS_PER_CELL_SQUARED = 4;
const RING_FIXED_POINT = 256;

function parabolaScaleCells(radius: number): number {
  return Math.max(STEPPED_RING_WIDTH_CELLS, Math.ceil(radius / PARABOLA_RADIUS_DIVISOR));
}

/**
 * Squared radii, in quarter cells², where the mound steps down a band: the
 * disc's edge, then one ring per flank band. Hard has no flank.
 */
export function moundRings(radius: number, profile: SculptProfile): number[] {
  const rings = [footprintRingQuarters(radius)];
  if (profile === 'hard') return rings;
  const discFixed = radius === MIN_BRUSH_RADIUS
    ? RING_FIXED_POINT / 2
    : Math.floor(Math.sqrt(footprintRadiusSquared(radius) * RING_FIXED_POINT * RING_FIXED_POINT));
  const scale = parabolaScaleCells(radius);
  for (let band = 1; band <= MOUND_MAX_FLANK_BANDS; band++) {
    const ring = profile === 'stepped'
      ? footprintRingQuarters(radius + band * STEPPED_RING_WIDTH_CELLS)
      : Math.floor(
          (QUARTERS_PER_CELL_SQUARED *
            (discFixed + Math.floor(Math.sqrt(band * scale * scale * RING_FIXED_POINT * RING_FIXED_POINT))) ** 2) /
            (RING_FIXED_POINT * RING_FIXED_POINT),
        );
    if (ring > rings[rings.length - 1]!) rings.push(ring);
  }
  return rings;
}

/** Cells past the brush radius a mound's flank reaches. */
export function moundFlankReachCells(radius: number, profile: SculptProfile): number {
  const rings = moundRings(radius, profile);
  const outer = Math.ceil(Math.sqrt(rings[rings.length - 1]!) / 2);
  return Math.max(0, outer - radius);
}

export function moundEdgeShape(
  cx: number,
  cy: number,
  radius: number,
  profile: SculptProfile,
  raising: boolean,
  spanBand: number | null,
): EdgeShape {
  return {
    centres: [[cx, cy]],
    rings: moundRings(radius, profile),
    raising,
    // A fill lands cells on band levels, several bands at once.
    keepsPriorEdges: false,
    spanOf: (map, i) => graspedSpanIndex(map, i, spanBand),
  };
}

export function applyMound(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  raising: boolean,
  profile: SculptProfile,
  spanBand: number | null,
  changed: Set<number>,
): void {
  const topBand = drawnBandOfSample(anchoredTargetHeight(map, cx, cy, raising, null, spanBand));
  const rings = moundRings(radius, profile);
  const outer = rings[rings.length - 1]!;
  const reach = radius + moundFlankReachCells(radius, profile);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const quarters = QUARTERS_PER_CELL_SQUARED * (dx * dx + dy * dy);
      if (quarters >= outer) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(map, x, y)) continue;
      let drop = 0;
      while (drop < rings.length && rings[drop]! <= quarters) drop++;
      const targetBand = raising ? topBand - drop : topBand + drop;
      const i = cellIndex(map, x, y);
      const k = graspedSpanIndex(map, i, spanBand);
      if (k === null) continue;
      const h = graspedCeiling(map, i, k);
      const band = drawnBandOfSample(h);
      if (raising ? band >= targetBand : band <= targetBand) continue;
      const { lo, hi } = graspedCeilingRange(map, i, k);
      let next = clampHeight(bandLevelHeight(targetBand));
      if (next > hi) next = hi;
      if (next < lo) next = lo;
      if (next === h || (raising ? next < h : next > h)) continue;
      writeGraspedCeiling(map, i, k, next);
      changed.add(i);
    }
  }
}
