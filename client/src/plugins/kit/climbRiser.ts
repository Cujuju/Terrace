import {
  CLIMB_BODY_HALF_WIDTH_CELLS,
  CELL_CENTRE_OFFSET,
  WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND,
  cellsAcross,
  type ClimbPath,
} from '@terrace/shared';
import { BAND_GRID_CELLS } from '../../terrain/bandGrid.ts';
import { renderedCellOf } from './groundFollow.ts';
import type { ClientPluginCtx } from '../types.ts';

export interface ClimbRiserShift {
  x: number;
  y: number;
  endProgress: number;
}

export function newClimbRiserShift(): ClimbRiserShift {
  return { x: 0, y: 0, endProgress: 0 };
}

const RISER_PROBE_STEPS = Math.round(1 / BAND_GRID_CELLS);

const RISER_PROBE_HALF_STEP = BAND_GRID_CELLS / 2;

const RISER_SHIFT_CELLS_PER_SECOND = cellsAcross(WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND);

export interface ClimbRiserMover {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly climbHeight: number | null;
  readonly climbPath?: ClimbPath;
  readonly falling?: boolean;
  readonly climbEndProgress?: number;
}

function riserStandOf(
  ctx: Pick<ClientPluginCtx, 'drawnGroundYAt'>,
  mover: ClimbRiserMover,
  feetY: number,
  bodyReachCells?: number,
): { readonly x: number; readonly y: number; readonly normalX: number; readonly normalY: number } | null {
  const path = mover.climbPath;
  if (path !== undefined && path.leg !== 'face' && !mover.falling) return null;
  const descending = path !== undefined && path.fromHeight > path.toHeight;
  const lowX = Math.floor(path === undefined ? mover.x : descending ? path.toX : path.fromX);
  const lowY = Math.floor(path === undefined ? mover.y : descending ? path.toY : path.fromY);
  // Low cell toward high cell; the heading may face either way.
  const normalX = path === undefined
    ? Math.round(Math.cos(mover.heading))
    : Math.sign(Math.floor(descending ? path.fromX : path.toX) - lowX);
  const normalY = path === undefined
    ? Math.round(Math.sin(mover.heading))
    : Math.sign(Math.floor(descending ? path.fromY : path.toY) - lowY);
  if (bodyReachCells === undefined && Math.abs(normalX) + Math.abs(normalY) !== 1) return null;
  if (normalX === 0 && normalY === 0) return null;
  const normalLength = Math.hypot(normalX, normalY);
  // A server cell index is its rendered centre.
  const groundAtFoot = ctx.drawnGroundYAt(lowX, lowY);
  if (groundAtFoot === null || groundAtFoot >= feetY) return null;

  for (let step = 1; step <= RISER_PROBE_STEPS; step++) {
    const along = step * BAND_GRID_CELLS;
    const capY = ctx.drawnGroundYAt(
      lowX + normalX * along,
      lowY + normalY * along,
    );
    if (capY === null) return null;
    if (capY <= feetY) continue;
    const halfWidth = bodyReachCells ?? (path === undefined ? CLIMB_BODY_HALF_WIDTH_CELLS : CELL_CENTRE_OFFSET -
      ((path.footX - lowX - CELL_CENTRE_OFFSET) * normalX +
       (path.footY - lowY - CELL_CENTRE_OFFSET) * normalY));
    const stand = along - RISER_PROBE_HALF_STEP - halfWidth / normalLength;
    return {
      x: normalX === 0 ? renderedCellOf(mover.x) : lowX + normalX * stand,
      y: normalY === 0 ? renderedCellOf(mover.y) : lowY + normalY * stand,
      normalX: normalX / normalLength,
      normalY: normalY / normalLength,
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
  ctx: Pick<ClientPluginCtx, 'drawnGroundYAt'>,
  mover: ClimbRiserMover,
  feetY: number,
  dt: number,
  bodyReachCells?: number,
): void {
  if (mover.climbEndProgress !== undefined) {
    const remaining = 1 - shift.endProgress;
    const fraction = remaining > 0 ? (1 - mover.climbEndProgress) / remaining : 0;
    shift.x *= fraction;
    shift.y *= fraction;
    shift.endProgress = mover.climbEndProgress;
    return;
  }
  shift.endProgress = 0;
  const stand = mover.climbHeight === null ? null : riserStandOf(ctx, mover, feetY, bodyReachCells);
  const budget = RISER_SHIFT_CELLS_PER_SECOND * Math.max(0, dt);
  const moverCellX = renderedCellOf(mover.x);
  const moverCellY = renderedCellOf(mover.y);
  shift.x = chase(shift.x, stand === null ? 0 : stand.x - moverCellX, budget);
  shift.y = chase(shift.y, stand === null ? 0 : stand.y - moverCellY, budget);
  if (stand !== null && bodyReachCells !== undefined) {
    // Contact clearance is a constraint; easing outward would leave the head inside the face.
    const penetration = (moverCellX + shift.x - stand.x) * stand.normalX +
      (moverCellY + shift.y - stand.y) * stand.normalY;
    if (penetration > 0) {
      shift.x -= stand.normalX * penetration;
      shift.y -= stand.normalY * penetration;
    }
  }
}
