import { SMOOTH_REACH_CELLS, SMOOTH_SPREAD_CELLS } from '../constants.ts';
import { LIBRARY_SCULPT_TOOL } from './options.ts';
import type { SculptAnchor, SculptOperation, SculptProfile } from './options.ts';
import { sculptSweepRadius } from './stamp.ts';

/**
 * Every cell one stroke can write, measured from its centre: the brush sweep,
 * plus the relaxation cascade for the two tools that relax.
 */
export function sculptReachCells(
  radius: number,
  profile: SculptProfile,
  tool: SculptOperation,
  anchor: SculptAnchor,
): number {
  if (tool === 'smooth') return radius + SMOOTH_REACH_CELLS;
  if (tool === LIBRARY_SCULPT_TOOL) return radius + SMOOTH_SPREAD_CELLS;
  return sculptSweepRadius(radius, profile, tool, anchor);
}
