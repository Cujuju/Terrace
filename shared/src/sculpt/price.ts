import { BAND_HEIGHT, DEFAULT_SCULPT_AMOUNT } from '../constants.ts';
import { assertBrushRadius, brushDelta, forEachFootprintOffset } from './footprint.ts';
import type { SculptProfile, SculptTool } from './options.ts';

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
