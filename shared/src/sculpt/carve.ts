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

/**
 * Cells a carve would actually cut. The preview and the applier both read this,
 * so the outline can never promise a cut the stroke will not make.
 */
export function carveAdmittedCells(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spanBand: number,
  depthBands: number,
): number[] {
  const admitted: number[] = [];
  if (!isValidCarveDepth(depthBands)) return admitted;
  const lowestOpenedBand = spanBand;
  const highestOpenedBand = spanBand + depthBands - 1;
  // Bedrock is the column's floor, not material: a stroke reaching it opens nothing.
  if (lowestOpenedBand < LOWEST_CARVEABLE_BAND) return admitted;

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
  return admitted;
}

export function applyCarve(
  map: Heightmap,
  cx: number,
  cy: number,
  radius: number,
  spanBand: number,
  depthBands: number,
  changed: Set<number>,
): void {
  for (const i of carveAdmittedCells(map, cx, cy, radius, spanBand, depthBands)) {
    carveBands(map, cellX(map.size, i), cellY(map.size, i), spanBand, spanBand + depthBands - 1);
    changed.add(i);
  }
}
