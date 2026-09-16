import {
  canCarveBandAt,
  carveBands,
  spanAt,
  spanCapBand,
  spanCount,
} from '../columns.ts';
import { cellX, cellY, type Heightmap } from '../grid.ts';
import { forEachFootprintCell } from './footprint.ts';
import { isValidCarveDepth, LOWEST_CARVEABLE_BAND } from './options.ts';

export function applyCarve(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spanBand: number,
  depthBands: number,
  changed: Set<number>,
): void {
  if (!isValidCarveDepth(depthBands)) return;
  const lowestOpenedBand = spanBand;
  const highestOpenedBand = spanBand + depthBands - 1;
  // Bedrock is the column's floor, not material: a stroke reaching it opens nothing.
  if (lowestOpenedBand < LOWEST_CARVEABLE_BAND) return;

  const admitted: number[] = [];
  forEachFootprintCell(map, cx, cy, radius, (i) => {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    let overlaps = false;
    const count = spanCount(map, x, y);
    for (let k = 0; k < count; k++) {
      const span = spanAt(map, x, y, k);
      if (span.floorBand <= highestOpenedBand && lowestOpenedBand <= spanCapBand(span)) {
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
    carveBands(map, cellX(map.size, i), cellY(map.size, i), lowestOpenedBand, highestOpenedBand);
    changed.add(i);
  }
}
