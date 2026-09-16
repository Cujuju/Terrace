import { BAND_HEIGHT, DEFAULT_SCULPT_AMOUNT } from '../constants.ts';
import { spanAt, spanCount, spanUndersideLevel } from '../columns.ts';
import { cellIndex, type Heightmap } from '../grid.ts';
import { assertBrushRadius, brushDelta, forEachFootprintOffset } from './footprint.ts';
import type { CellDiff } from './diff.ts';
import type { SculptProfile, SculptTool } from './options.ts';

/**
 * Solid material standing in one column, in height units. Each span counts from
 * its own underside, so a cave's roof is material and the air below it is not.
 */
export function columnSolidUnits(map: Heightmap, x: number, y: number): number {
  let units = 0;
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    units += span.ceiling - spanUndersideLevel(span);
  }
  return units;
}

/** What every column in a rectangle held, for the before half of a displacement. */
export function snapshotSolidUnits(
  map: Heightmap,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Map<number, number> {
  const before = new Map<number, number>();
  const lastX = maxX > map.size - 1 ? map.size - 1 : maxX;
  const lastY = maxY > map.size - 1 ? map.size - 1 : maxY;
  for (let y = minY < 0 ? 0 : minY; y <= lastY; y++) {
    for (let x = minX < 0 ? 0 : minX; x <= lastX; x++) {
      before.set(cellIndex(map, x, y), columnSolidUnits(map, x, y));
    }
  }
  return before;
}

/**
 * The material a stroke actually moved: what each changed column gained or
 * lost. A changed cell the snapshot does not hold is not charged for.
 */
export function displacementOf(
  before: ReadonlyMap<number, number>,
  after: Heightmap,
  changed: readonly CellDiff[],
): number {
  let units = 0;
  for (const cell of changed) {
    const was = before.get(cellIndex(after, cell.x, cell.y));
    if (was === undefined) continue;
    const now = columnSolidUnits(after, cell.x, cell.y);
    units += now > was ? now - was : was - now;
  }
  return units;
}

/** What one press moves at one cell, whichever way the stroke goes. */
export const SCULPT_PRESS_UNITS_PER_CELL =
  DEFAULT_SCULPT_AMOUNT < 0 ? -DEFAULT_SCULPT_AMOUNT : DEFAULT_SCULPT_AMOUNT;

/** A stroke that fills pays one press for every cell it covers. */
export function pressDisplacementUnits(cells: number): number {
  return cells * SCULPT_PRESS_UNITS_PER_CELL;
}

export function sculptDisplacementUnits(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile,
  depthBands: number,
): number {
  assertBrushRadius(radius);

  if (tool === 'carve') {
    let cells = 0;
    forEachFootprintOffset(radius, () => {
      cells++;
    });
    return cells * depthBands * BAND_HEIGHT;
  }

  // A soft clicked stamp moves the linear falloff, and smooth only melts
  // partial steps, so both pay the graduated volume instead of the fill.
  if ((tool === 'stamp' && profile === 'soft') || tool === 'smooth') {
    let total = 0;
    forEachFootprintOffset(radius, (_dx, _dy, dist) => {
      total += brushDelta(SCULPT_PRESS_UNITS_PER_CELL, radius, dist, 'soft');
    });
    return total;
  }

  let cells = 0;
  forEachFootprintOffset(radius, () => {
    cells++;
  });
  return pressDisplacementUnits(cells);
}
