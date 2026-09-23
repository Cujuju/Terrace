import { SMOOTH_REACH_MARGIN_CELLS, SMOOTH_SPREAD_CELLS } from '../constants.ts';
import { EDGE_REGION_MARGIN_CELLS } from './edges.ts';
import { LIBRARY_SCULPT_TOOL } from './options.ts';
import type { SculptAnchor, SculptOperation, SculptProfile } from './options.ts';
import { sculptSweepRadius } from './stamp.ts';

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
  const sweep = sculptSweepRadius(radius, profile, tool, anchor);
  // An edge-aware stamp re-encodes the cells just past its outermost ring.
  return tool === 'stamp' ? sweep + EDGE_REGION_MARGIN_CELLS : sweep;
}
