import { SOFT_APRON_MAX_BANDS, SOFT_APRON_TREAD_CELLS } from '../constants.ts';
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
    if (anchored && (raising ? before >= target : before <= target)) return;
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
  return profile === 'soft' && tool === 'stamp' && anchor === 'clicked'
    ? radius + softApronReachCells(radius)
    : radius;
}

export function softApronReachCells(radius: number): number {
  const capped = SOFT_APRON_MAX_BANDS * SOFT_APRON_TREAD_CELLS;
  const reach = 2 * radius;
  return reach < capped ? reach : capped;
}

export function softApronBandDrop(distPastCore: number): number {
  const band = Math.floor((distPastCore + SOFT_APRON_TREAD_CELLS - 1) / SOFT_APRON_TREAD_CELLS);
  return band < SOFT_APRON_MAX_BANDS ? band : SOFT_APRON_MAX_BANDS;
}

/** The apron only exists under a soft clicked stamp, which is an anchored stroke. */
const APRON_IS_ANCHORED = true;

export function applySoftApron(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  amount: number,
  coreTarget: number,
  spanBand: number | null,
  changed: Set<number>,
): void {
  if (amount === 0) return;
  const raising = amount > 0;
  const reach = softApronReachCells(radius);
  const coreBand = drawnBandOfSample(coreTarget);
  forEachFootprintCell(map, cx, cy, sculptSweepRadius(radius, 'soft', 'stamp', 'clicked'), (i) => {
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
    const target = clampHeight(
      bandLevelHeight(coreBand + (raising ? -softApronBandDrop(dist) : softApronBandDrop(dist))),
    );
    const k = graspedSpanIndex(map, i, spanBand);
    if (k === null) return;
    const before = graspedCeiling(map, i, k);
    if (raising ? before >= target : before <= target) return;
    const moved = before + pressDelta(amount, before, APRON_IS_ANCHORED);
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
    if (raising ? h >= targetHeight : h <= targetHeight) return;
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
