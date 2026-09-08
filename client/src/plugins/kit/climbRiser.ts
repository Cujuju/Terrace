// Holding the drawn riser: the horizontal half of drawing a climber, as
// groundFollow.ts is the vertical half. The server owns the climb, the client
// where the body is drawn.

import {
  CLIMB_BODY_HALF_WIDTH_CELLS,
  WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND,
  cellsAcross,
} from '@terrace/shared';
import { BAND_GRID_CELLS } from '../../terrain/bandGrid.ts';
import type { ClientPluginCtx } from '../types.ts';

/**
 * How far the drawn body sits from where the wire put it, in cells. Mutable
 * view state, one per mover: the chase below is what fills it.
 */
export interface ClimbRiserShift {
  x: number;
  y: number;
}

/** The shift of a mover that has not been drawn yet, and of one on the ground. */
export function newClimbRiserShift(): ClimbRiserShift {
  return { x: 0, y: 0 };
}

/** Probes from the low cell's centre to the high one's, at the drawn ground's own pitch. */
const RISER_PROBE_STEPS = Math.round(1 / BAND_GRID_CELLS);

/** A riser lies between the two probes that straddle it, so its place is their midpoint. */
const RISER_PROBE_HALF_STEP = BAND_GRID_CELLS / 2;

/**
 * How fast the drawn body slides onto a riser and off it again, in cells per
 * second: its own walking speed, so a correction never outruns a walk.
 */
const RISER_SHIFT_CELLS_PER_SECOND = cellsAcross(WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND);

/** What this reads off a mover — every plugin's interpolated row carries it. */
export interface ClimbRiserMover {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly climbHeight: number | null;
}

/**
 * Where a body holding a wall belongs, in cells, or null when it holds none.
 * Only the climb's own axis is answered for; across it the wire stands.
 */
function riserStandOf(
  ctx: ClientPluginCtx,
  mover: ClimbRiserMover,
  feetY: number,
): { readonly x: number; readonly y: number } | null {
  // The face's outward normal: a climber faces the wall for the whole climb.
  const normalX = Math.round(Math.cos(mover.heading));
  const normalY = Math.round(Math.sin(mover.heading));
  // A climb faces one axis. A heading interpolated across a descender's turn
  // does not, and has no face to hold.
  if (Math.abs(normalX) + Math.abs(normalY) !== 1) return null;

  // The terrain draws a cell centred ON its integer coordinate, so the low cell
  // of the pair is drawn there and the high one a step along the normal.
  const lowX = Math.floor(mover.x);
  const lowY = Math.floor(mover.y);
  const groundAtFoot = ctx.drawnGroundYAt(lowX, lowY);
  // FEET BACK ON THE GROUND THE WALL RISES FROM: the body is coming over the
  // lip or stepping off at the bottom, not on the face.
  if (groundAtFoot === null || groundAtFoot >= feetY) return null;

  for (let step = 1; step <= RISER_PROBE_STEPS; step++) {
    const along = step * BAND_GRID_CELLS;
    const capY = ctx.drawnGroundYAt(lowX + normalX * along, lowY + normalY * along);
    // Nothing drawn to hold — an unbuilt chunk. The wire stands.
    if (capY === null) return null;
    if (capY <= feetY) continue;
    // The first drawn ground above the feet is the riser this body is against;
    // its front face touches it, so its centre stands its own half-depth back.
    const stand = along - RISER_PROBE_HALF_STEP - CLIMB_BODY_HALF_WIDTH_CELLS;
    return {
      x: normalX === 0 ? mover.x : lowX + normalX * stand,
      y: normalY === 0 ? mover.y : lowY + normalY * stand,
    };
  }
  // Nothing along the pair rises above the feet: the body has topped out.
  return null;
}

/** Moves `from` toward `to` by at most `budget`. */
function chase(from: number, to: number, budget: number): number {
  if (to - from > budget) return from + budget;
  if (to - from < -budget) return from - budget;
  return to;
}

/**
 * One frame of the chase: eases the body onto the riser it holds, or back onto
 * the wire position when it holds none. `feetY` is where the feet are drawn.
 */
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
