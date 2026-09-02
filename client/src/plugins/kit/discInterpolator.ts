// Smoothing 1 Hz server truth about a DRIFTING DISC into 60 Hz motion.
//
// A server broadcasts the full list of masses once a second. Drawing those
// centres directly would step a front across the map like a stop-motion film —
// two cells at a time at the wind's ceiling. This keeps the last rendered pose
// and the newest received one and walks between them.
//
// THE MACHINERY IS ./interpolator.ts's, which five plugins already share. What
// is here is the part that is about a DISC: which fields walk, and the window
// bounds that go with a 1 Hz cadence. Four plugins broadcast this exact payload
// (shared/src/discWire.ts) and a plugin may not import another plugin, so the
// alternative to this file is four byte-identical copies of it.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

import type { DiscSystemState } from '@terrace/shared';
import { PoseInterpolator, lerp, type PoseSegment } from './interpolator.ts';

/** A mass's pose for one frame. */
export interface InterpolatedDisc {
  readonly id: number;
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
 * The window is measured rather than assumed, so this keeps working if a
 * server's tick rate or broadcast interval is retuned — but a measurement taken
 * across a stall must not become the window. The floor is one 60 Hz frame (below
 * it, interpolation has nothing to do); the ceiling is two seconds, sized to ride
 * out exactly one dropped message at the shipped 1 Hz cadence, past which a
 * client is better off holding at truth than gliding through a stale
 * extrapolation. That 2 s ceiling is also what makes 1 Hz the FLOOR for a
 * broadcast interval — see the cadence note in each sender's server/index.ts.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 2;

/** Nominal window before any two messages have been seen (1 Hz = 1 s). */
export const DEFAULT_INTERPOLATION_SECONDS = 1;

/** The values that are walked between broadcasts. Radius is here for a reason. */
interface DiscPose extends PoseSegment {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
}

/**
 * One mass's pose record. Mutable and PERSISTENT: the kit refills these in place
 * every frame rather than allocating a Map and an object per mass per frame.
 * Consumers see it through the readonly InterpolatedDisc face and must not hold
 * one across frames.
 */
interface DiscPoseRecord extends InterpolatedDisc {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
}

/**
 * Two-pose interpolator, keyed by system id.
 *
 * RADIUS AND VELOCITY ARE INTERPOLATED TOO even though today's sim holds both
 * constant for a mass's life (one shared wind, a fixed shape). Interpolating them
 * costs four multiplies a frame and means this stays correct if either ever
 * starts moving — where special-casing them as constants would be an assumption
 * about another module's internals that nothing would fail loudly about.
 *
 * INTENSITY IS INTERPOLATED, AND THAT IS THE ONLY FADE ANYWHERE ON THIS SIDE.
 * A server ramps a mass in and out over its fade seconds, so one enters the list
 * at ~0 and leaves it at ~0; masses absent from the newest message are therefore
 * dropped immediately, with no client-side fade-out to invent. The one case that
 * shows a step is a client JOINING into weather already at full strength, which
 * is the same "everything appears at once on join" every plugin here has.
 */
export class DiscInterpolator extends PoseInterpolator<
  DiscSystemState,
  DiscPose,
  DiscPoseRecord
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
