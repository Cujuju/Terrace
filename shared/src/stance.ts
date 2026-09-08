import { cellsAcross } from './constants.ts';
import type { ClimbState } from './climb.ts';

export type MoverStance = 'walk' | 'stand' | 'sit';

export const MOVER_STANCES: readonly MoverStance[] = ['walk', 'stand', 'sit'];

export const STANCE_WALKING_WORLD_UNITS_PER_SECOND = 0.01;

export const STANCE_WALKING_CELLS_PER_SECOND = cellsAcross(
  STANCE_WALKING_WORLD_UNITS_PER_SECOND,
);

export const STILL_SECONDS_BEFORE_STAND = 0.4;

export const STILL_SECONDS_BEFORE_SIT = 8;

export const STAND_UP_SECONDS = 0.6;

export const STANDING_UP_STILL_SECONDS = STILL_SECONDS_BEFORE_STAND + STAND_UP_SECONDS;

export interface StillMover {
  x: number;
  y: number;
  climb: ClimbState | null;
  stillSeconds: number;
  stillX: number;
  stillY: number;
}

export function newStillness(x: number, y: number): {
  stillSeconds: number;
  stillX: number;
  stillY: number;
} {
  return { stillSeconds: 0, stillX: x, stillY: y };
}

export function advanceStillness(mover: StillMover, dt: number): void {
  const step = Math.max(0, dt);
  if (mover.climb !== null) {
    mover.stillSeconds = 0;
    mover.stillX = mover.x;
    mover.stillY = mover.y;
    return;
  }

  const dx = mover.x - mover.stillX;
  const dy = mover.y - mover.stillY;
  mover.stillX = mover.x;
  mover.stillY = mover.y;

  const floor = STANCE_WALKING_CELLS_PER_SECOND * step;
  if (dx * dx + dy * dy >= floor * floor) {
    mover.stillSeconds = Math.max(
      0,
      Math.min(mover.stillSeconds, STANDING_UP_STILL_SECONDS) - step,
    );
    return;
  }
  mover.stillSeconds += step;
}

export function moverStanceOf(mover: StillMover): MoverStance {
  if (mover.stillSeconds >= STILL_SECONDS_BEFORE_SIT) return 'sit';
  if (mover.stillSeconds >= STILL_SECONDS_BEFORE_STAND) return 'stand';
  return 'walk';
}

export interface StanceWire {
  readonly stance: number | null;
}

const WALKING: StanceWire = Object.freeze({ stance: null });

export function stanceWireOf(mover: StillMover): StanceWire {
  const stance = moverStanceOf(mover);
  if (stance === 'walk') return WALKING;
  return { stance: MOVER_STANCES.indexOf(stance) };
}

export function moverStanceFromWire(stance: unknown): MoverStance {
  if (typeof stance !== 'number') return 'walk';
  return MOVER_STANCES[stance] ?? 'walk';
}
