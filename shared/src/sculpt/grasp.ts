import { MAX_HEIGHT } from '../constants.ts';
import {
  bandFloorHeight,
  BEDROCK_REMNANT_CEILING,
  canSpreadBandToSpan,
  moveSpanCeiling,
  spanAt,
  spanCount,
  spanIndexCoveringBand,
} from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';

// A column always keeps one unit of bedrock, so BEDROCK_REMNANT_CEILING — not
// MIN_HEIGHT — is the lowest height a write can land on.
export function clampHeight(h: number): number {
  return h > MAX_HEIGHT
    ? MAX_HEIGHT
    : h < BEDROCK_REMNANT_CEILING
      ? BEDROCK_REMNANT_CEILING
      : h;
}

export function canSpreadBandTo(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): boolean {
  return canSpreadBandToSpan(map, cx, cy, band);
}

export function graspedSpanIndex(map: Heightmap, i: number, spanBand: number | null): number | null {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  if (spanBand === null) return spanCount(map, x, y) - 1;
  return spanIndexCoveringBand(map, x, y, spanBand);
}

export function layerSpanIndex(map: Heightmap, i: number, spanBand: number | null): number | null {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  const top = spanCount(map, x, y) - 1;
  if (spanBand === null) return top;
  const k = spanIndexCoveringBand(map, x, y, spanBand);
  if (k !== null) return k;
  return bandFloorHeight(spanBand) > spanAt(map, x, y, top).ceiling ? top : null;
}

export function graspedCeiling(map: Heightmap, i: number, k: number): number {
  return spanAt(map, cellX(map.size, i), cellY(map.size, i), k).ceiling;
}

export function writeGraspedCeiling(map: Heightmap, i: number, k: number, ceiling: number): void {
  moveSpanCeiling(map, cellX(map.size, i), cellY(map.size, i), k, ceiling);
}
