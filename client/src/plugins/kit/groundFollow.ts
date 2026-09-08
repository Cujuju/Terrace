import {
  SHEER_RISE_TO_RUN,
  CELL_WORLD_SIZE,
  WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND,
} from '@terrace/shared';
import type { ClientPluginCtx } from '../types.ts';

export const TALLEST_WALKED_STEP_WORLD_UNITS = SHEER_RISE_TO_RUN * CELL_WORLD_SIZE;

const CELL_CROSSING_SECONDS = CELL_WORLD_SIZE / WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND;

export const GROUND_FOLLOW_WORLD_UNITS_PER_SECOND =
  TALLEST_WALKED_STEP_WORLD_UNITS / CELL_CROSSING_SECONDS;

export const GROUND_FOLLOW_SNAP_WORLD_UNITS = TALLEST_WALKED_STEP_WORLD_UNITS;

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

export type GroundSampler = (cellX: number, cellY: number) => number | null;

export function drawnGroundSampler(ctx: ClientPluginCtx): GroundSampler {
  return (cellX, cellY) => ctx.drawnGroundYAt(cellX, cellY);
}
