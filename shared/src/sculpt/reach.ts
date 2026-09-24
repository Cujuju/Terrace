import { SMOOTH_REACH_MARGIN_CELLS, SMOOTH_SPREAD_CELLS } from '../constants.ts';
import { EDGE_AWARE_TOOLS, EDGE_REGION_MARGIN_CELLS } from './edges.ts';
import { LIBRARY_SCULPT_TOOL } from './options.ts';
import type { SculptAnchor, SculptOperation, SculptProfile } from './options.ts';

/** How far past its footprint one player smooth may cascade. */
export function smoothCascadeReachCells(radius: number): number {
  return radius + SMOOTH_REACH_MARGIN_CELLS;
}

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
  if (tool === 'smooth') return radius + smoothCascadeReachCells(radius);
  if (tool === LIBRARY_SCULPT_TOOL) return radius + SMOOTH_SPREAD_CELLS;
  // An edge-aware brush re-encodes the cells just past its disc.
  return EDGE_AWARE_TOOLS.includes(tool) ? radius + EDGE_REGION_MARGIN_CELLS : radius;
}
