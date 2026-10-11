import { type ClimbPath, type MoverStance } from '@terrace/shared';

/** `descend`: climbing down facing the way it goes; wall-facers descend in `climb`. */
export type MoverGait = MoverStance | 'climb' | 'descend' | 'fall';

export const MOVER_GAITS: readonly MoverGait[] = ['walk', 'climb', 'fall', 'stand', 'sit', 'descend'];

export function moverGaitIndex(gait: MoverGait): number {
  return MOVER_GAITS.indexOf(gait);
}

export function moverGaitOf(
  climbHeight: number | null,
  falling: boolean,
  stance: MoverStance = 'walk',
  climbPath?: ClimbPath,
): MoverGait {
  if (climbHeight === null) return stance;
  if (falling) return 'fall';
  return climbPath !== undefined && descendsFacingTravel(climbPath) ? 'descend' : 'climb';
}

/** Down the step, heading along it (a wall-facer's heading points back up the face). */
function descendsFacingTravel(path: ClimbPath): boolean {
  if (path.toHeight >= path.fromHeight) return false;
  return Math.cos(path.heading) * (path.toX - path.fromX) + Math.sin(path.heading) * (path.toY - path.fromY) > 0;
}

/** Progress through a leap, 0 at take-off to 1 at landing; null off a leap. */
export function leapProgressOf(mover: {
  readonly x: number;
  readonly y: number;
  readonly climbPath?: ClimbPath;
}): number | null {
  const path = mover.climbPath;
  if (path === undefined || path.leg !== 'leap') return null;
  const dx = path.toX - path.fromX;
  const dy = path.toY - path.fromY;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return null;
  const along = ((mover.x - path.fromX) * dx + (mover.y - path.fromY) * dy) / lengthSquared;
  return Math.min(1, Math.max(0, along));
}
