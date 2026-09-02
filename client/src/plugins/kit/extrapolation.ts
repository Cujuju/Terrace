// WHERE A MOVING THING IS RIGHT NOW, from the last full-state push and the
// velocity that came with it.
//
// EXTRAPOLATION RATHER THAN INTERPOLATION BETWEEN TWO SAMPLES, and the
// difference is what is being smoothed. A large slow disc can be drawn a push
// BEHIND the server for free — a third of a second of latency costs nothing when
// the thing is fifty cells across (./discInterpolator.ts does exactly that). A
// small fast thing cannot: it covers a third of its own width between pushes, so
// rendering it a push behind would put it visibly off the ground the server says
// it is standing on.
//
// Two plugins draw such a thing, which is why this is here rather than in one of
// them.

/**
 * Seconds a last-known velocity may be extrapolated past the push that carried
 * it.
 *
 * ONE SECOND, five times the 200 ms broadcast interval of the senders that use
 * this, so a client rides out four consecutive dropped messages before the thing
 * visibly stalls. Past that it stops rather than sails on: a stale guess that
 * keeps accelerating away from the truth is worse than a thing that waits.
 */
export const MAX_EXTRAPOLATION_SECONDS = 1;

/** A pose with a velocity — as much of a wire state as this needs. */
export interface MovingPose {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * Where `pose` is `ageSeconds` after the push that carried it. The age is
 * clamped into [0, MAX_EXTRAPOLATION_SECONDS], so a caller may hand over a
 * negative clock skew or a minute of background tab without special-casing
 * either.
 */
export function extrapolate(pose: MovingPose, ageSeconds: number): { x: number; y: number } {
  const age = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, ageSeconds));
  return { x: pose.x + pose.vx * age, y: pose.y + pose.vy * age };
}
