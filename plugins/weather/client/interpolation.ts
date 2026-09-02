// Smoothing 1 Hz server truth into 60 Hz motion.
//
// The server broadcasts the full system list once a second. Drawing those
// centres directly would step a rain front across the map like a stop-motion
// film — two cells at a time at the wind's ceiling. The interpolator keeps the
// last rendered pose and the newest received one and walks between them.
//
// THE MACHINERY IS THE CLIENT KIT'S (client/src/plugins/kit/interpolator.ts):
// five plugins carried the same class over different payloads. What is left here
// is the part that is actually about weather — this plugin's window bounds, and
// which fields walk or are carried through untouched.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

import {
  PoseInterpolator,
  lerp,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { WeatherKind, WeatherSystemState } from '../protocol.ts';

export { lerp };

/** A system's pose for one frame. */
export interface InterpolatedSystem {
  readonly id: number;
  /**
   * Carried through untouched: a system's kind cannot change, so there is
   * nothing to interpolate and the rig it owns never has to be rebuilt.
   */
  readonly kind: WeatherKind;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's tick rate or BROADCAST_TICK_INTERVAL is retuned — but a measurement
 * taken across a stall must not become the window. The floor is one 60 Hz frame
 * (below it, interpolation has nothing to do); the ceiling is two seconds,
 * sized to ride out exactly one dropped message at the shipped 1 Hz cadence,
 * past which a client is better off holding at truth than gliding through a
 * stale extrapolation. That 2 s ceiling is also what makes 1 Hz the FLOOR for
 * the broadcast interval — see the cadence note in server/index.ts.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 2;

/** Nominal window before any two messages have been seen (1 Hz = 1 s). */
export const DEFAULT_INTERPOLATION_SECONDS = 1;

/** The values that are walked between broadcasts. Radius is here for a reason. */
interface Pose extends PoseSegment {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
}

/**
 * One system's pose record. Mutable and PERSISTENT: the kit refills these in
 * place every frame rather than allocating a Map and an object per system per
 * frame. Consumers see it through the readonly InterpolatedSystem face and must
 * not hold one across frames.
 */
interface PoseRecord extends InterpolatedSystem {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
  kind: InterpolatedSystem['kind'];
}

/**
 * Two-pose interpolator, keyed by system id.
 *
 * RADIUS AND VELOCITY ARE INTERPOLATED TOO even though the sim holds both
 * constant for a system's life (systems.ts: "a system's shape is fixed"; one
 * shared wind). Interpolating them costs four multiplies a frame and means this
 * stays correct if either ever starts moving — where special-casing them as
 * constants would be an assumption about another module's internals that nothing
 * would fail loudly about.
 *
 * INTENSITY IS INTERPOLATED, AND THAT IS THE ONLY FADE ANYWHERE ON THIS SIDE.
 * The server ramps a system in and out over SYSTEM_FADE_SECONDS, so a system
 * enters the list at ~0 and leaves it at ~0; systems absent from the newest
 * message are therefore dropped immediately, exactly like a wildlife despawn,
 * with no client-side fade-out to invent. The one case that shows a step is a
 * client JOINING into weather already at full strength, which is the same
 * "everything appears at once on join" every plugin here has.
 */
export class WeatherInterpolator extends PoseInterpolator<
  WeatherSystemState,
  Pose,
  PoseRecord
> {
  constructor() {
    super({
      minWindowSeconds: MIN_INTERPOLATION_SECONDS,
      maxWindowSeconds: MAX_INTERPOLATION_SECONDS,
      defaultWindowSeconds: DEFAULT_INTERPOLATION_SECONDS,
      createSegment: () => ({
        x: 0,
        y: 0,
        radius: 0,
        intensity: 0,
        vx: 0,
        vy: 0,
        generation: 0,
      }),
      freeze: (target, source) => {
        target.x = source.x;
        target.y = source.y;
        target.radius = source.radius;
        target.intensity = source.intensity;
        target.vx = source.vx;
        target.vy = source.vy;
      },
      createRecord: (system) => ({ ...system }),
      updateRecord: (record, system, segment, t) => {
        record.kind = system.kind;
        if (segment === undefined) {
          record.x = system.x;
          record.y = system.y;
          record.radius = system.radius;
          record.intensity = system.intensity;
          record.vx = system.vx;
          record.vy = system.vy;
          return;
        }
        record.x = lerp(segment.x, system.x, t);
        record.y = lerp(segment.y, system.y, t);
        record.radius = lerp(segment.radius, system.radius, t);
        record.intensity = lerp(segment.intensity, system.intensity, t);
        record.vx = lerp(segment.vx, system.vx, t);
        record.vy = lerp(segment.vy, system.vy, t);
      },
    });
  }
}
