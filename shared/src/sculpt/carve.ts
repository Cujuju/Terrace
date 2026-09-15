import {
  bandFloorHeight,
  BEDROCK_FLOOR,
  canCarveBandAt,
  carveRange,
  spanAt,
  spanCount,
} from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';
import { forEachFootprintCell } from './footprint.ts';
import { CARVE_BANDS_PER_STROKE } from './options.ts';

export function applyCarve(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spanBand: number,
  changed: Set<number>,
): void {
  const lowestOpenedBand = spanBand;
  const highestOpenedBand = spanBand + CARVE_BANDS_PER_STROKE - 2;
  // Cut a band below the lowest band opened: a remnant capped inside that band
  // still covers the one above it.
  const lo = bandFloorHeight(lowestOpenedBand - 1);
  const hi = bandFloorHeight(highestOpenedBand + 1);

  if (lo <= BEDROCK_FLOOR) return;

  const admitted: number[] = [];
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    let overlaps = false;
    const count = spanCount(map, x, y);
    for (let k = 0; k < count; k++) {
      const span = spanAt(map, x, y, k);
      if (span.floor < hi && lo < span.ceiling) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) return;
    for (let band = lowestOpenedBand; band <= highestOpenedBand; band++) {
      if (!canCarveBandAt(map, x, y, band)) return;
    }
    admitted.push(i);
  });

  for (const i of admitted) {
    carveRange(map, cellX(map.size, i), cellY(map.size, i), lo, hi);
    changed.add(i);
  }
}
