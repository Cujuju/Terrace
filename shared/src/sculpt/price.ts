import { BAND_HEIGHT, DEFAULT_SCULPT_AMOUNT } from '../constants.ts';
import { assertBrushRadius, brushDelta, forEachFootprintOffset } from './footprint.ts';
import { CARVE_BANDS_PER_STROKE } from './options.ts';
import type { SculptProfile, SculptTool } from './options.ts';

export function sculptDisplacementUnits(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile = 'hard',
): number {
  assertBrushRadius(radius);

  if (tool === 'carve') {
    let cells = 0;
    forEachFootprintOffset(radius, () => {
      cells++;
    });
    return cells * CARVE_BANDS_PER_STROKE * BAND_HEIGHT;
  }

  const perCell =
    DEFAULT_SCULPT_AMOUNT < 0 ? -DEFAULT_SCULPT_AMOUNT : DEFAULT_SCULPT_AMOUNT;
  // A soft clicked stamp moves the linear falloff, and smooth only melts
  // partial steps, so both pay the graduated volume instead of the fill.
  if ((tool === 'stamp' && profile === 'soft') || tool === 'smooth') {
    let total = 0;
    forEachFootprintOffset(radius, (_dx, _dy, dist) => {
      total += brushDelta(perCell, radius, dist, 'soft');
    });
    return total;
  }

  let cells = 0;
  forEachFootprintOffset(radius, () => {
    cells++;
  });
  return cells * perCell;
}
