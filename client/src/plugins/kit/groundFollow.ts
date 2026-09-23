import {
  SHEER_RISE_TO_RUN,
  CELL_WORLD_SIZE,
  WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND,
  DRAWN_FILTER_REACH,
  type ClimbPath,
} from '@terrace/shared';
import type { ClientPluginCtx } from '../types.ts';
import { HEIGHT_WORLD_SCALE } from '../../worldScale.ts';
import { lerp } from './interpolator.ts';

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

// Fractional rendered world cells; field conversion and availability share the terrain boundary.
export type GroundSampler = (cellX: number, cellY: number) => number | null;

export function drawnGroundSampler(ctx: ClientPluginCtx): GroundSampler {
  return (cellX, cellY) => ctx.drawnGroundYAt(cellX, cellY);
}

export interface ClimbPose {
  climbHeight?: number | null;
  climbPath?: ClimbPath;
  falling?: boolean;
  climbEndProgress?: number;
}

/** Keep entry and arrival inside the same interpolation window as horizontal motion. */
export function interpolateClimbPose(
  record: ClimbPose,
  from: ClimbPose,
  to: ClimbPose,
  t: number,
): void {
  const start = from.climbHeight ?? null;
  const end = to.climbHeight ?? null;
  if (end === null && start !== null) record.climbEndProgress = lerp(from.climbEndProgress ?? 0, 1, t);
  else delete record.climbEndProgress;
  const path = to.climbPath ?? (t < 1 && end === null ? from.climbPath : undefined);
  if (path === undefined) delete record.climbPath;
  else record.climbPath = path;
  record.falling = end === null && t < 1 && start !== null ? from.falling === true : to.falling === true;
  if (path === undefined) {
    record.climbHeight = start === null || end === null ? end : lerp(start, end, t);
    return;
  }
  const sameClimb = from.climbPath?.id === path.id;
  const fromHeight = start !== null && sameClimb ? start : path.fromHeight;
  const toHeight = end ?? (from.falling ? Math.min(path.fromHeight, path.toHeight) : path.toHeight);
  record.climbHeight = lerp(fromHeight, toHeight, t);
}

export interface ClimbGroundState {
  pathId: number | null;
  revision: number;
  fromY: number;
  toY: number;
  footY: number;
  correction: number;
  falling: boolean;
  releaseHeight: number;
  releaseY: number;
  settling: boolean;
}

export function newClimbGroundState(): ClimbGroundState {
  return {
    pathId: null, revision: -1, fromY: 0, toY: 0, footY: 0,
    correction: 0, falling: false, releaseHeight: 0, releaseY: 0, settling: false,
  };
}

function supportRevision(ctx: Pick<ClientPluginCtx, 'terrainRevisionAt'>, x: number, y: number): number {
  const west = Math.floor(x) - DRAWN_FILTER_REACH;
  const north = Math.floor(y) - DRAWN_FILTER_REACH;
  const east = Math.floor(x) + 1 + DRAWN_FILTER_REACH;
  const south = Math.floor(y) + 1 + DRAWN_FILTER_REACH;
  return ctx.terrainRevisionAt(west, north) + ctx.terrainRevisionAt(east, north) +
    ctx.terrainRevisionAt(west, south) + ctx.terrainRevisionAt(east, south);
}

/** Continuous server progress between drawn anchors; support revisions rebase from the displayed pose. */
export function followClimbGroundY(
  state: ClimbGroundState,
  ctx: Pick<ClientPluginCtx, 'drawnGroundYAt' | 'terrainRevisionAt'>,
  mover: ClimbPose,
  previousY: number | null,
  groundY: number,
  dt: number,
): number | null {
  const height = mover.climbHeight ?? null;
  if (height === null) {
    state.settling ||= state.pathId !== null;
    state.pathId = null;
    state.falling = false;
    const y = followGroundY(previousY, groundY, dt, GROUND_FOLLOW_WORLD_UNITS_PER_SECOND,
      state.settling ? Infinity : GROUND_FOLLOW_SNAP_WORLD_UNITS);
    if (y === groundY) state.settling = false;
    return y;
  }
  const path = mover.climbPath;
  if (path === undefined) {
    // Older servers lack endpoint metadata; retain continuous height and ease the eventual support handoff.
    state.settling = true;
    return followGroundY(previousY, height * HEIGHT_WORLD_SCALE, dt,
      GROUND_FOLLOW_WORLD_UNITS_PER_SECOND, Infinity);
  }
  const revision = supportRevision(ctx, path.fromX, path.fromY) +
    supportRevision(ctx, path.toX, path.toY) + supportRevision(ctx, path.footX, path.footY);
  const entered = state.pathId !== path.id;
  const changed = entered || state.revision !== revision;
  if (changed) {
    const fromY = ctx.drawnGroundYAt(path.fromX, path.fromY);
    const toY = ctx.drawnGroundYAt(path.toX, path.toY);
    const footY = ctx.drawnGroundYAt(path.footX, path.footY);
    if (fromY === null || toY === null || footY === null) return null;
    state.fromY = fromY;
    state.toY = toY;
    state.footY = footY;
    state.pathId = path.id;
    state.revision = revision;
    if (entered) state.falling = false;
  }
  const progress = Math.max(0, Math.min(1, (height - path.fromHeight) / (path.toHeight - path.fromHeight)));
  let targetY = lerp(state.fromY, state.toY, progress);
  if (mover.falling) {
    if (!state.falling) {
      state.releaseHeight = height;
      state.releaseY = previousY ?? targetY;
      state.falling = true;
      state.correction = 0;
    }
    const drop = state.releaseHeight - Math.min(path.fromHeight, path.toHeight);
    const fallen = drop > 0 ? Math.max(0, Math.min(1, (state.releaseHeight - height) / drop)) : 1;
    targetY = lerp(state.releaseY, state.footY, fallen);
  }
  if (changed) state.correction = previousY === null ? 0 : previousY - targetY;
  state.correction = followGroundY(state.correction, 0, dt, GROUND_FOLLOW_WORLD_UNITS_PER_SECOND, Infinity);
  return targetY + state.correction;
}
