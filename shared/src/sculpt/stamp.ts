import {
  SOFT_APRON_MAX_BANDS,
  SOFT_APRON_MAX_REACH_CELLS,
  SOFT_APRON_REACH_PER_RADIUS,
  STEPPED_MAX_RINGS,
  STEPPED_RING_WIDTH_CELLS,
} from '../constants.ts';
import { bandLevelHeight, drawnBandOfSample } from '../bands.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';
import {
  canSpreadBandTo,
  clampHeight,
  graspedCeiling,
  graspedSpanIndex,
  writeGraspedCeiling,
} from './grasp.ts';
import {
  anchoredTargetHeight,
  assertBrushArgs,
  brushDelta,
  forEachFootprintCell,
  isFootprintOffset,
  pressDelta,
  spreadableFootprintCells,
} from './footprint.ts';
import { footprintRingQuarters, type EdgeShape } from './edges.ts';
import { LIBRARY_DEFAULT_SCULPT_OPTIONS } from './options.ts';
import type { SculptAnchor, SculptProfile, SculptTool } from './options.ts';

export function applyBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  profile: SculptProfile = LIBRARY_DEFAULT_SCULPT_OPTIONS.profile,
  anchor: SculptAnchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor,
  targetBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);

  let spreadable: ReadonlySet<number> | null = null;
  if (anchor === 'band') {
    if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
    spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
  }

  const raising = amount > 0;
  const anchored = anchor !== 'free' && amount !== 0;
  const target = anchored ? anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand) : 0;

  forEachFootprintCell(map, cx, cy, radius, (i, dist) => {
    if (spreadable !== null && !spreadable.has(i)) return;
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const before = graspedCeiling(map, i, k);
    if (anchored && hasReachedBand(before, target, raising)) return;
    const delta = brushDelta(pressDelta(amount, before, anchored), radius, dist, profile);
    if (delta === 0) return;
    let moved = before + delta;
    if (anchored) {
      moved = raising
        ? moved > target ? target : moved
        : moved < target ? target : moved;
    }
    const h = clampHeight(moved);
    if (h !== before) {
      writeGraspedCeiling(map, i, k, h);
      changed.add(i);
    }
  });
}

/** A cell whose drawn band already reached the target's is done: its in-band height is its edge. */
function hasReachedBand(height: number, target: number, raising: boolean): boolean {
  const band = drawnBandOfSample(height);
  const targetBand = drawnBandOfSample(target);
  return raising ? band >= targetBand : band <= targetBand;
}

export function applyLevelFillBrush(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  anchor: SculptAnchor = LIBRARY_DEFAULT_SCULPT_OPTIONS.anchor,
  targetBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.targetBand,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
): void {
  assertBrushArgs(map, cx, cy, radius, amount);
  if (amount === 0) return;

  let spreadable: ReadonlySet<number> | null = null;
  if (anchor === 'band') {
    if (targetBand === null || !canSpreadBandTo(map, cx, cy, targetBand)) return;
    spreadable = spreadableFootprintCells(map, cx, cy, radius, targetBand);
  }

  const raising = amount > 0;

  if (anchor !== 'free') {
    const targetHeight = anchoredTargetHeight(map, cx, cy, raising, targetBand, spanBand);
    fillTowardTarget(
      map, cx, cy, radius, amount, changed, raising, targetHeight, true, spanBand, spreadable,
    );
    return;
  }

  let extremeBand = 0;
  {
    let surveyed = false;
    forEachFootprintCell(map, cx, cy, radius, (i) => {
      const k = graspedSpanIndex(map, i, spanBand);
      if (k === null) return;
      const band = drawnBandOfSample(graspedCeiling(map, i, k));
      if (!surveyed) {
        extremeBand = band;
        surveyed = true;
        return;
      }
      if (raising ? band < extremeBand : band > extremeBand) extremeBand = band;
    });
    if (!surveyed) return;
  }

  const targetHeight = clampHeight(bandLevelHeight(extremeBand + (raising ? 1 : -1)));
  fillTowardTarget(map, cx, cy, radius, amount, changed, raising, targetHeight, false, spanBand);
}

export function sculptSweepRadius(
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
  anchor: SculptAnchor,
): number {
  return tool === 'stamp' && anchor === 'clicked' ? radius + stampSkirtReachCells(radius, profile) : radius;
}

/** How far past its core a clicked stamp hangs lower treads: soft's apron, stepped's rings. */
export function stampSkirtReachCells(radius: number, profile: SculptProfile): number {
  if (profile === 'soft') return softApronReachCells(radius);
  if (profile === 'stepped') return STEPPED_MAX_RINGS * STEPPED_RING_WIDTH_CELLS;
  return 0;
}

/** Bands a skirt cell `distPastCore` rings out sits below the core. */
export function stampSkirtBandDrop(distPastCore: number, profile: SculptProfile): number {
  return profile === 'stepped' ? steppedBandDrop(distPastCore) : softApronBandDrop(distPastCore);
}

/** Each band below the core reaches one tread further: ceil(d / width). */
export function steppedBandDrop(distPastCore: number): number {
  if (distPastCore < 1) return 0;
  return Math.floor((distPastCore + STEPPED_RING_WIDTH_CELLS - 1) / STEPPED_RING_WIDTH_CELLS);
}

export function softApronReachCells(radius: number): number {
  const reach = SOFT_APRON_REACH_PER_RADIUS * radius;
  return reach < SOFT_APRON_MAX_REACH_CELLS ? reach : SOFT_APRON_MAX_REACH_CELLS;
}

/** Math.clz32 counts a 32-bit word's leading zeros, so this reads floor(log2 d) + 1. */
const INT32_BITS = 32;

/** The sheet drops a band per cell at the pinch, then doubles its tread: 1, 2, 4, 8 cells. */
export function softApronBandDrop(distPastCore: number): number {
  if (distPastCore < 1) return 0;
  const band = INT32_BITS - Math.clz32(distPastCore);
  return band < SOFT_APRON_MAX_BANDS ? band : SOFT_APRON_MAX_BANDS;
}

/** A stamp's outline: its core disc, then each skirt ring where the drop steps. */
export function stampEdgeShape(
  cx: number,
  cy: number,
  radius: number,
  skirt: SculptProfile | null,
  raising: boolean,
  spanBand: number | null,
): EdgeShape {
  const rings = [footprintRingQuarters(radius)];
  if (skirt !== null) {
    const reach = stampSkirtReachCells(radius, skirt);
    for (let d = 1; d < reach; d++) {
      if (stampSkirtBandDrop(d, skirt) !== stampSkirtBandDrop(d + 1, skirt)) {
        rings.push(footprintRingQuarters(radius + d));
      }
    }
    rings.push(footprintRingQuarters(radius + reach));
  }
  return {
    centres: [[cx, cy]],
    rings,
    raising,
    // A level fill moves cells one band at a time, their edges with them.
    keepsPriorEdges: true,
    spanOf: (map, i) => graspedSpanIndex(map, i, spanBand),
  };
}

/** A skirt only exists under a clicked stamp, which is an anchored stroke. */
const SKIRT_IS_ANCHORED = true;

export function applyStampSkirt(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  profile: SculptProfile,
  amount: number,
  coreTarget: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  if (amount === 0) return;
  const raising = amount > 0;
  const reach = stampSkirtReachCells(radius, profile);
  const coreBand = drawnBandOfSample(coreTarget);
  forEachFootprintCell(map, cx, cy, sculptSweepRadius(radius, profile, 'stamp', 'clicked'), (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const dx = x - cx;
    const dy = y - cy;
    if (isFootprintOffset(radius, dx, dy)) return;
    let dist = reach;
    for (let d = 1; d < reach; d++) {
      if (isFootprintOffset(radius + d, dx, dy)) {
        dist = d;
        break;
      }
    }
    const drop = stampSkirtBandDrop(dist, profile);
    const target = clampHeight(bandLevelHeight(coreBand + (raising ? -drop : drop)));
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const before = graspedCeiling(map, i, k);
    if (hasReachedBand(before, target, raising)) return;
    const moved = before + pressDelta(amount, before, SKIRT_IS_ANCHORED);
    const h = clampHeight(raising ? (moved > target ? target : moved) : (moved < target ? target : moved));
    if (h !== before) {
      writeGraspedCeiling(map, i, k, h);
      changed.add(i);
    }
  });
}

function fillTowardTarget(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  changed: Set<number>,
  raising: boolean,
  targetHeight: number,
  anchored: boolean,
  spanBand: number | null = LIBRARY_DEFAULT_SCULPT_OPTIONS.spanBand,
  spreadable: ReadonlySet<number> | null = null,
): void {
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    if (spreadable !== null && !spreadable.has(i)) return;
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const h = graspedCeiling(map, i, k);
    if (hasReachedBand(h, targetHeight, raising)) return;
    const moved = h + pressDelta(amount, h, anchored);
    const next = raising
      ? moved > targetHeight ? targetHeight : moved
      : moved < targetHeight ? targetHeight : moved;
    const clamped = clampHeight(next);
    if (clamped !== h) {
      writeGraspedCeiling(map, i, k, clamped);
      changed.add(i);
    }
  });
}
