import { bandLevelHeight } from '../bands.ts';
import {
  applyBandFill,
  bandFillAt,
  bandFloorHeight,
  columnCoversBand,
  highestCeilingBelow,
  isHeightInBand,
  isSpanDrawn,
  moveSpanCeiling,
  readSpans,
  spanAt,
  spanCount,
  spanIndexCoveringBand,
  spansHaveCapAtBand,
  type Span,
} from '../columns.ts';
import {
  cellIndex,
  cellX,
  cellY,
  forEachLineCell,
  inBounds,
  type Heightmap,
} from '../grid.ts';
import { canSpreadBandTo, clampHeight } from './grasp.ts';
import { forEachFootprintOffset } from './footprint.ts';
import { admitRimEnclaves, cellNoise, SOFT_DRAG_MIN_REACH } from './dragDisc.ts';
import { MIN_BAND } from './options.ts';
import type { SculptProfile, SweepOrigin } from './options.ts';

const DRAG_TREAD_TOLERANCE_CELLS = 1;

/**
 * A drag settles each cell once; the repeat only lets a settled cell's
 * neighbours cascade. One act per cell bounds the sweep however
 * canonicalisation rewrites the column.
 */
function settleEachCellOnce(cells: readonly number[], act: (index: number) => boolean): void {
  const settled = new Set<number>();
  for (let quiet = false; !quiet; ) {
    quiet = true;
    for (const i of cells) {
      if (settled.has(i)) continue;
      if (!act(i)) continue;
      settled.add(i);
      quiet = false;
    }
  }
}

function pushLowerLayers(
  map: Heightmap,
  raisedAtBand: number[],
  topBand: number,
  hadCapAtBandBefore: (index: number, band: number) => boolean,
  record: (index: number) => void,
  changed: Set<number>,
): void {
  const treadWasNear = (cx: number, cy: number, band: number): boolean => {
    for (let dy = -DRAG_TREAD_TOLERANCE_CELLS; dy <= DRAG_TREAD_TOLERANCE_CELLS; dy++) {
      for (let dx = -DRAG_TREAD_TOLERANCE_CELLS; dx <= DRAG_TREAD_TOLERANCE_CELLS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(map, x, y)) continue;
        if (hadCapAtBandBefore(cellIndex(map, x, y), band)) return true;
      }
    }
    return false;
  };

  const band = topBand - 1;
  if (band <= MIN_BAND || raisedAtBand.length === 0) return;
  const level = clampHeight(bandLevelHeight(band));

  const candidates: number[] = [];
  const seen = new Set<number>();
  for (const seed of raisedAtBand) {
    const sx = cellX(map.size, seed);
    const sy = cellY(map.size, seed);
    for (let dy = -DRAG_TREAD_TOLERANCE_CELLS; dy <= DRAG_TREAD_TOLERANCE_CELLS; dy++) {
      for (let dx = -DRAG_TREAD_TOLERANCE_CELLS; dx <= DRAG_TREAD_TOLERANCE_CELLS; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!inBounds(map, x, y)) continue;
        const i = cellIndex(map, x, y);
        if (seen.has(i)) continue;
        seen.add(i);
        if (columnCoversBand(map, x, y, band)) continue;
        if (!treadWasNear(x, y, band)) continue;
        candidates.push(i);
      }
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => a - b);

  settleEachCellOnce(candidates, (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const fill = bandFillAt(map, x, y, band);
    if (fill === null || fill.kind !== 'extend') return false;
    if (!canSpreadBandTo(map, x, y, band)) return false;
    record(i);
    applyBandFill(map, x, y, fill, level);
    changed.add(i);
    return true;
  });
}

function retreatHeightAt(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): number | null {
  const floor = bandFloorHeight(band);
  let best: number | null = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      const h = highestCeilingBelow(map, nx, ny, floor);
      if (h === null) continue;
      if (best === null || h > best) best = h;
    }
  }
  return best;
}

export function applyDragRegion(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  raising: boolean,
  targetBand: number,
  profile: SculptProfile,
  sweepFrom: SweepOrigin | null,
  changed: Set<number>,
): void {
  // Like anchoredTargetHeight: a drag-raise to the waterline breaks the surface.
  const targetHeight = clampHeight(bandLevelHeight(targetBand));
  const ragged = profile === 'soft';

  const priorSpans = new Map<number, readonly Span[]>();
  const record = (i: number): void => {
    if (!priorSpans.has(i)) priorSpans.set(i, readSpans(map, cellX(map.size, i), cellY(map.size, i)));
  };
  const hadCapAtBandBefore = (i: number, band: number): boolean => {
    const prior = priorSpans.get(i);
    if (prior !== undefined) return spansHaveCapAtBand(prior, band);
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const count = spanCount(map, x, y);
    for (let k = 0; k < count; k++) {
      if (isHeightInBand(spanAt(map, x, y, k).ceiling, band)) return true;
    }
    return false;
  };

  const disc: number[] = [];
  const inDisc = new Set<number>();
  const refused = new Set<number>();
  const sweepDisc = (sx: number, sy: number): void => {
    forEachFootprintOffset(radius, (dx, dy, dist) => {
      const x = sx + dx;
      const y = sy + dy;
      if (!inBounds(map, x, y)) return;
      const i = cellIndex(map, x, y);
      if (inDisc.has(i)) return;
      if (ragged && dist >= radius * (SOFT_DRAG_MIN_REACH + (1 - SOFT_DRAG_MIN_REACH) * cellNoise(x, y))) {
        refused.add(i);
        return;
      }
      refused.delete(i);
      inDisc.add(i);
      disc.push(i);
    });
  };
  if (sweepFrom === null) sweepDisc(cx, cy);
  else forEachLineCell(sweepFrom.x, sweepFrom.y, cx, cy, sweepDisc);
  if (refused.size > 0) admitRimEnclaves(map, targetBand, refused, inDisc, disc);

  if (!raising) {
    settleEachCellOnce(disc, (i) => {
      const x = cellX(map.size, i);
      const y = cellY(map.size, i);
      const k = spanIndexCoveringBand(map, x, y, targetBand);
      if (k === null) return false;
      const span = spanAt(map, x, y, k);
      if (span.ceiling < bandFloorHeight(targetBand)) return false;
      const ground = retreatHeightAt(map, x, y, targetBand);
      if (ground === null) return false;
      // The retreat is a write like any other: it lands no lower than the
      // bedrock remnant a column always keeps, and only ever cuts downward.
      const exposed = clampHeight(Math.max(ground, bandLevelHeight(targetBand - 1)));
      if (exposed >= span.ceiling) return false;
      if (k > 0 && !isSpanDrawn({ floorBand: span.floorBand, ceiling: exposed })) return false;
      moveSpanCeiling(map, x, y, k, exposed);
      changed.add(i);
      return true;
    });
    return;
  }

  const raised: number[] = [];
  settleEachCellOnce(disc, (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const fill = bandFillAt(map, x, y, targetBand);
    if (fill === null) return false;
    if (!canSpreadBandTo(map, x, y, targetBand)) return false;
    record(i);
    applyBandFill(map, x, y, fill, targetHeight);
    changed.add(i);
    if (fill.kind === 'extend') raised.push(i);
    return true;
  });

  if (raised.length > 0) pushLowerLayers(map, raised, targetBand, hadCapAtBandBefore, record, changed);
}
