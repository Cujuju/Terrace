import { MAX_HEIGHT } from '../constants.ts';
import {
  bandFloorHeight,
  BEDROCK_FLOOR,
  canSpreadBandToSpan,
  highestCeilingUnderSpan,
  moveSpanCeiling,
  spanAt,
  spanCount,
  spanIndexCoveringBand,
} from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';

// A column always keeps its bedrock band, whose ceiling is BEDROCK_FLOOR: the
// lowest height a write can land on.
export function clampHeight(h: number): number {
  return h > MAX_HEIGHT ? MAX_HEIGHT : h < BEDROCK_FLOOR ? BEDROCK_FLOOR : h;
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

/** Where span `k`'s ceiling may move: under the span above it, and never below its own floor band. */
export function graspedCeilingRange(map: Heightmap, i: number, k: number): { lo: number; hi: number } {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  const top = spanCount(map, x, y) - 1;
  return {
    lo: k === 0 ? BEDROCK_FLOOR : bandFloorHeight(spanAt(map, x, y, k).floorBand),
    hi: k === top ? MAX_HEIGHT : highestCeilingUnderSpan(spanAt(map, x, y, k + 1)),
  };
}
