import { SMOOTH_REACH_MARGIN_CELLS, SMOOTH_SPREAD_CELLS } from '../constants.ts';
import { EDGE_AWARE_TOOLS, EDGE_REGION_MARGIN_CELLS } from './edges.ts';
import { NUDGE_READ_MARGIN_CELLS } from './nudge.ts';
import { LIBRARY_SCULPT_TOOL } from './options.ts';
import { OUTLINE_SMOOTH_READ_MARGIN_CELLS } from './outlineSmooth.ts';
import { sculptSweepRadius } from './stamp.ts';
import type { SculptAnchor, SculptOperation, SculptProfile } from './options.ts';

/** How far past its footprint one player smooth may cascade. */
export function smoothCascadeReachCells(radius: number): number {
  return radius + SMOOTH_REACH_MARGIN_CELLS;
}

/**
 * Every cell one stroke can read or write, measured from its centre: the brush
 * sweep, a read margin for smooth and nudge, the cascade for settle.
 */
export function sculptReachCells(
  radius: number,
  profile: SculptProfile,
  tool: SculptOperation,
  anchor: SculptAnchor,
): number {
  // Smooth and nudge write only their disc but read a margin past it.
  if (tool === 'smooth') return radius + OUTLINE_SMOOTH_READ_MARGIN_CELLS;
  if (tool === 'nudge') return radius + NUDGE_READ_MARGIN_CELLS;
  if (tool === LIBRARY_SCULPT_TOOL) return radius + SMOOTH_SPREAD_CELLS;
  const sweep = sculptSweepRadius(radius, profile, tool, anchor);
  // An edge-aware brush re-encodes the cells just past its disc.
  return EDGE_AWARE_TOOLS.includes(tool) ? sweep + EDGE_REGION_MARGIN_CELLS : sweep;
}
