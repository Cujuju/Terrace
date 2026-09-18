import { bandLevelHeight } from '../bands.ts';
import {
  bandFloorHeight,
  fillBandRun,
  highestCeilingBelow,
  isSpanDrawn,
  moveSpanCeiling,
  spanAt,
  spanIndexCoveringBand,
} from '../columns.ts';
import {
  cellIndex,
  cellX,
  cellY,
  forEachLineCell,
  inBounds,
  type Heightmap,
} from '../grid.ts';
import { clampHeight } from './grasp.ts';
import { forEachFootprintOffset } from './footprint.ts';
import { admitRimEnclaves, cellNoise, SOFT_DRAG_MIN_REACH } from './dragDisc.ts';
import type { SculptProfile, SweepOrigin } from './options.ts';

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
  runFloorBand: number,
  profile: SculptProfile,
  sweepFrom: SweepOrigin | null,
  changed: Set<number>,
): void {
  // Like anchoredTargetHeight: a drag-raise to the waterline breaks the surface.
  const targetHeight = clampHeight(bandLevelHeight(targetBand));
  const ragged = profile === 'soft';

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

  // The run is the whole write: one slab per cell, nothing cascades off a
  // neighbour and nothing descends in a second pass, so one plain sweep
  // settles the disc.
  for (const i of disc) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    if (fillBandRun(map, x, y, runFloorBand, targetBand, targetHeight)) changed.add(i);
  }
}
