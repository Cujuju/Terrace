// The vertical half of drawing a mover: its drawn height CHASES what it stands
// on, so crossing a band is a step, not a jump. No three, no DOM.

import {
  SHEER_RISE_TO_RUN,
  CELL_WORLD_SIZE,
  WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND,
} from '@terrace/shared';
import type { ClientPluginCtx } from '../types.ts';

/**
 * The tallest step a walker may take without it being a climb, in world units.
 * Anything taller is a climb, drawn from the server's `climbHeight`.
 */
export const TALLEST_WALKED_STEP_WORLD_UNITS = SHEER_RISE_TO_RUN * CELL_WORLD_SIZE;

/** Seconds a walker spends crossing one cell, at the repo's reference walking speed. */
const CELL_CROSSING_SECONDS = CELL_WORLD_SIZE / WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND;

/**
 * How fast a drawn mover chases the ground, in world units per second. Derived,
 * not tuned: level again before the walker leaves the cell it stepped into.
 */
export const GROUND_FOLLOW_WORLD_UNITS_PER_SECOND =
  TALLEST_WALKED_STEP_WORLD_UNITS / CELL_CROSSING_SECONDS;

/**
 * A gap BIGGER than this is not a step and is not eased. What exceeds it is a
 * spawn, a teleport, a chunk arriving, or a sculpt.
 */
export const GROUND_FOLLOW_SNAP_WORLD_UNITS = TALLEST_WALKED_STEP_WORLD_UNITS;

/**
 * One frame of vertical chase. `previousY` is last frame's drawn height, null
 * on the first frame. A caller with its own vertical motion passes its rate.
 */
export function followGroundY(
  previousY: number | null,
  targetY: number,
  dt: number,
  ratePerSecond: number = GROUND_FOLLOW_WORLD_UNITS_PER_SECOND,
  snapGap: number = GROUND_FOLLOW_SNAP_WORLD_UNITS,
): number {
  if (previousY === null) return targetY;
  const gap = targetY - previousY;
  if (Math.abs(gap) > snapGap) return targetY;
  const budget = ratePerSecond * Math.max(0, dt);
  return previousY + Math.max(-budget, Math.min(budget, gap));
}

/** The drawn cap under a mover at a fractional cell coordinate; null while that chunk is unbuilt. */
export type GroundSampler = (cellX: number, cellY: number) => number | null;

/**
 * Where a ground mover's foot goes: the cap the terrain really drew, never the
 * lattice band, which disagrees by a whole band across a contour.
 */
export function drawnGroundSampler(ctx: ClientPluginCtx): GroundSampler {
  return (cellX, cellY) => ctx.drawnGroundYAt(cellX, cellY);
}
