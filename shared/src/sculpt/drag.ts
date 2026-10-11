import { bandLevelHeight } from '../bands.ts';
import {
  BEDROCK_BAND,
  bandFloorHeight,
  carveBands,
  fillBandRun,
  highestCeilingBelow,
  isSpanDrawn,
  moveSpanCeiling,
  spanAt,
  spanCapBand,
  spanIndexBelowBand,
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
import { footprintRingQuarters, type EdgeShape } from './edges.ts';
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

/** The span a drag writes in a column: the one holding its band, else the highest beneath. */
function sampledSpanIndex(map: Heightmap, i: number, band: number): number | null {
  const x = cellX(map.size, i);
  const y = cellY(map.size, i);
  return spanIndexCoveringBand(map, x, y, band) ?? spanIndexBelowBand(map, x, y, band);
}

/** A drag leg's outline: its disc swept along the line, measured from the nearest line cell. */
export function dragEdgeShape(
  cx: number,
  cy: number,
  radius: number,
  raising: boolean,
  targetBand: number,
  sweepFrom: SweepOrigin | null,
): EdgeShape {
  const centres: (readonly [number, number])[] = [];
  if (sweepFrom === null) centres.push([cx, cy]);
  else forEachLineCell(sweepFrom.x, sweepFrom.y, cx, cy, (x, y) => centres.push([x, y]));
  return {
    centres,
    rings: [footprintRingQuarters(radius)],
    raising,
    // A drag lands cells on levels and neighbours' grounds, several bands at once.
    keepsPriorEdges: false,
    spanOf: (map, i) => sampledSpanIndex(map, i, targetBand),
  };
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
  dragAlt = false,
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
    // Alt: one band only. Carve it where a retreat exists; the edge gate
    // holds, no interior holes.
    if (dragAlt) {
      if (targetBand <= BEDROCK_BAND) return;
      settleEachCellOnce(disc, (i) => {
        const x = cellX(map.size, i);
        const y = cellY(map.size, i);
        if (spanIndexCoveringBand(map, x, y, targetBand) === null) return false;
        if (retreatHeightAt(map, x, y, targetBand) === null) return false;
        carveBands(map, x, y, targetBand, targetBand);
        changed.add(i);
        return true;
      });
      return;
    }
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
      if (k > 0 && !isSpanDrawn({ floorBand: span.floorBand, ceiling: exposed })) {
        // The grabbed band is this slab's floor, so the retreat leaves none of it.
        carveBands(map, x, y, span.floorBand, spanCapBand(span));
      } else {
        moveSpanCeiling(map, x, y, k, exposed);
      }
      changed.add(i);
      return true;
    });
    return;
  }

  // One slab per cell in a single sweep, no cascade. Alt narrows it to
  // the grabbed band.
  const floor = dragAlt ? targetBand : runFloorBand;
  for (const i of disc) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    if (fillBandRun(map, x, y, floor, targetBand, targetHeight)) changed.add(i);
  }
}
