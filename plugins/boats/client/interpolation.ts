// Smoothing 2 Hz server truth into 60 Hz motion.
//
// The server broadcasts the full boat list twice a second. Drawing those
// positions directly would step a hull across the water like a stop-motion film.
// The interpolator keeps the last rendered pose and the newest received one and
// walks between them.
//
// THE MACHINERY IS THE CLIENT KIT'S (client/src/plugins/kit/interpolator.ts):
// five plugins carried the same class over different payloads. What is left
// here is the part that is actually about boats — this plugin's window bounds,
// and which fields walk, turn, or are carried through untouched.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { BoatState } from '../protocol.ts';

export { lerp, lerpAngle };

/** A boat's pose for one frame. */
export interface InterpolatedBoat {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly fighting: boolean;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's broadcast cadence is retuned — but a measurement taken across a stall
 * must not become the window. The floor is one 60 Hz frame (below it,
 * interpolation has nothing to do); the ceiling is one second, past which a
 * client is better off snapping to truth than gliding through stale
 * extrapolation.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

/** Nominal window before any two messages have been seen (2 Hz = 500 ms). */
export const DEFAULT_INTERPOLATION_SECONDS = 0.5;

/** The pose a segment is walked from. */
interface Pose extends PoseSegment {
  x: number;
  y: number;
  heading: number;
}

/**
 * One boat's pose record. Mutable and PERSISTENT: the kit refills these in place
 * every frame instead of allocating a Map and an object per boat per frame.
 * Consumers see it through the readonly InterpolatedBoat face and must not hold
 * one across frames.
 */
interface PoseRecord extends InterpolatedBoat {
  x: number;
  y: number;
  heading: number;
  fighting: InterpolatedBoat['fighting'];
}

/**
 * Two-pose interpolator, keyed by boat id.
 *
 * Boats absent from the newest message are dropped immediately — a sinking is
 * something the server has already decided.
 */
export class BoatInterpolator extends PoseInterpolator<BoatState, Pose, PoseRecord> {
  constructor() {
    super({
      minWindowSeconds: MIN_INTERPOLATION_SECONDS,
      maxWindowSeconds: MAX_INTERPOLATION_SECONDS,
      defaultWindowSeconds: DEFAULT_INTERPOLATION_SECONDS,
      createSegment: () => ({ x: 0, y: 0, heading: 0, generation: 0 }),
      freeze: (target, source) => {
        target.x = source.x;
        target.y = source.y;
        target.heading = source.heading;
      },
      createRecord: (boat) => ({ ...boat }),
      updateRecord: (record, boat, segment, t) => {
        record.fighting = boat.fighting;
        if (segment === undefined) {
          record.x = boat.x;
          record.y = boat.y;
          record.heading = boat.heading;
          return;
        }
        record.x = lerp(segment.x, boat.x, t);
        record.y = lerp(segment.y, boat.y, t);
        // The short way round, so a boat coming about spins 10° rather than 350°.
        record.heading = lerpAngle(segment.heading, boat.heading, t);
      },
    });
  }
}
