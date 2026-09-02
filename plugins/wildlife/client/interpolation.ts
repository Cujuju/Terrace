// Smoothing 5 Hz server truth into 60 Hz motion.
//
// The server broadcasts the full entity list every other tick (200 ms). Drawing
// those positions directly would tick creatures forward five times a second like
// a stop-motion film. The interpolator keeps the last rendered pose and the
// newest received one and walks between them.
//
// THE MACHINERY IS THE CLIENT KIT'S (client/src/plugins/kit/interpolator.ts):
// five plugins carried the same class over different payloads — the same window
// measurement, the same "freeze the rendered pose first" order, the same
// generation-stamped prune, the same recycled records. What is left here is the
// part that is actually about creatures: this plugin's window bounds, and which
// fields walk, turn, or are carried through untouched.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { WildlifeEntityState, WildlifeSpecies } from '../protocol.ts';

export { lerp, lerpAngle };

/** A creature's pose for one frame. */
export interface InterpolatedEntity {
  readonly id: number;
  readonly species: WildlifeSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  /**
   * Size-class index, carried through untouched. It is not interpolated because
   * it cannot change: the server draws a creature's size once, at spawn.
   */
  readonly size: number;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's tick rate or BROADCAST_TICK_INTERVAL is retuned — but a measurement
 * taken across a stall must not become the window. The floor is one 60 Hz frame
 * (below it, interpolation has nothing to do); the ceiling is one second, past
 * which a client is better off snapping to truth than gliding through a second
 * of stale extrapolation.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

/** Nominal window before any two messages have been seen (5 Hz = 200 ms). */
export const DEFAULT_INTERPOLATION_SECONDS = 0.2;

/** The pose a segment is walked from. */
interface Pose extends PoseSegment {
  x: number;
  y: number;
  heading: number;
}

/**
 * One creature's pose record. Mutable and PERSISTENT: the kit refills these in
 * place every frame instead of allocating a Map and an object per creature per
 * frame (perf review 2026-08-29, A5). Consumers see it through the readonly
 * InterpolatedEntity face and must not hold one across frames.
 */
interface PoseRecord extends InterpolatedEntity {
  x: number;
  y: number;
  heading: number;
  species: InterpolatedEntity['species'];
  size: InterpolatedEntity['size'];
}

/**
 * Two-pose interpolator, keyed by entity id.
 *
 * Entities absent from the newest message are dropped immediately — a despawn is
 * something the server has already decided, and easing a creature out would mean
 * inventing a position no one authorised.
 */
export class WildlifeInterpolator extends PoseInterpolator<
  WildlifeEntityState,
  Pose,
  PoseRecord
> {
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
      createRecord: (entity) => ({ ...entity }),
      updateRecord: (record, entity, segment, t) => {
        record.species = entity.species;
        record.size = entity.size;
        if (segment === undefined) {
          record.x = entity.x;
          record.y = entity.y;
          record.heading = entity.heading;
          return;
        }
        record.x = lerp(segment.x, entity.x, t);
        record.y = lerp(segment.y, entity.y, t);
        // The short way round, so a creature turning through ±π spins 10°
        // rather than 350°.
        record.heading = lerpAngle(segment.heading, entity.heading, t);
      },
    });
  }
}
