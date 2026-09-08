export const MAX_EXTRAPOLATION_SECONDS = 1;

export interface MovingPose {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

export function extrapolate(pose: MovingPose, ageSeconds: number): { x: number; y: number } {
  const age = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, ageSeconds));
  return { x: pose.x + pose.vx * age, y: pose.y + pose.vy * age };
}
