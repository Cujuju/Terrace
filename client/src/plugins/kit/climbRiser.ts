import {
  CLIMB_BODY_HALF_WIDTH_CELLS,
  WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND,
  cellsAcross,
} from '@terrace/shared';
import { BAND_GRID_CELLS } from '../../terrain/bandGrid.ts';
import type { ClientPluginCtx } from '../types.ts';

export interface ClimbRiserShift {
  x: number;
  y: number;
}

export function newClimbRiserShift(): ClimbRiserShift {
  return { x: 0, y: 0 };
}

const RISER_PROBE_STEPS = Math.round(1 / BAND_GRID_CELLS);

const RISER_PROBE_HALF_STEP = BAND_GRID_CELLS / 2;

const RISER_SHIFT_CELLS_PER_SECOND = cellsAcross(WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND);

export interface ClimbRiserMover {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly climbHeight: number | null;
}

function riserStandOf(
  ctx: ClientPluginCtx,
  mover: ClimbRiserMover,
  feetY: number,
): { readonly x: number; readonly y: number } | null {
  const normalX = Math.round(Math.cos(mover.heading));
  const normalY = Math.round(Math.sin(mover.heading));
  if (Math.abs(normalX) + Math.abs(normalY) !== 1) return null;

  const lowX = Math.floor(mover.x);
  const lowY = Math.floor(mover.y);
  const groundAtFoot = ctx.drawnGroundYAt(lowX, lowY);
  if (groundAtFoot === null || groundAtFoot >= feetY) return null;

  for (let step = 1; step <= RISER_PROBE_STEPS; step++) {
    const along = step * BAND_GRID_CELLS;
    const capY = ctx.drawnGroundYAt(lowX + normalX * along, lowY + normalY * along);
    if (capY === null) return null;
    if (capY <= feetY) continue;
    const stand = along - RISER_PROBE_HALF_STEP - CLIMB_BODY_HALF_WIDTH_CELLS;
    return {
      x: normalX === 0 ? mover.x : lowX + normalX * stand,
      y: normalY === 0 ? mover.y : lowY + normalY * stand,
    };
  }
  return null;
}

function chase(from: number, to: number, budget: number): number {
  if (to - from > budget) return from + budget;
  if (to - from < -budget) return from - budget;
  return to;
}

export function advanceClimbRiserShift(
  shift: ClimbRiserShift,
  ctx: ClientPluginCtx,
  mover: ClimbRiserMover,
  feetY: number,
  dt: number,
): void {
  const stand = mover.climbHeight === null ? null : riserStandOf(ctx, mover, feetY);
  const budget = RISER_SHIFT_CELLS_PER_SECOND * Math.max(0, dt);
  shift.x = chase(shift.x, stand === null ? 0 : stand.x - mover.x, budget);
  shift.y = chase(shift.y, stand === null ? 0 : stand.y - mover.y, budget);
}
