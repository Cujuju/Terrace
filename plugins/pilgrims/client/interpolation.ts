// Smoothing 5 Hz server truth into 60 Hz motion.
//
// The server broadcasts the full walker list every other tick (200 ms). Drawing
// those positions directly would tick a peep forward five times a second like a
// stop-motion film. The interpolator keeps the last rendered pose and the newest
// received one and walks between them.
//
// THE MACHINERY IS THE CLIENT KIT'S (client/src/plugins/kit/interpolator.ts):
// five plugins carried the same class over different payloads. What is left here
// is the part that is actually about walkers — this plugin's window bounds, and
// which fields walk, turn, or are carried through untouched.
//
// Pure logic: no three, no DOM, no clock. Time only enters through `advance(dt)`,
// which is what makes the whole thing testable in a node environment.

import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { PilgrimEntityState, SettlerRace, WalkerKind } from '../protocol.ts';

export { lerp, lerpAngle };

/** A walker's pose for one frame. */
export interface InterpolatedPilgrim {
  readonly id: number;
  readonly kind: WalkerKind;
  readonly race: SettlerRace;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  /**
   * Stored height while this walker is off the ground — climbing a wall or
   * falling off one (protocol.ts's PilgrimEntityState.climbHeight). Null while
   * it is standing on the ground, which is the ordinary case.
   *
   * INTERPOLATED LIKE x AND y, and for the same reason: it is a position the
   * server sends at 5 Hz and the client draws at 60. Left un-interpolated a
   * climb would rise in five visible steps a second, which is the stepping this
   * whole change exists to remove — on the one motion that is nothing but
   * vertical.
   */
  readonly climbHeight: number | null;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's tick rate or broadcast interval is retuned — but a measurement taken
 * across a stall must not become the window. The floor is one 60 Hz frame; the
 * ceiling is one second, past which a client is better off snapping to truth.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

/** Nominal window before any two messages have been seen (5 Hz = 200 ms). */
export const DEFAULT_INTERPOLATION_SECONDS = 0.2;

/** The pose a segment is walked from. */
interface Pose extends PoseSegment {
  climbHeight: number | null;
  x: number;
  y: number;
  heading: number;
}

/**
 * One walker's pose record. Mutable and PERSISTENT: the kit refills these in
 * place every frame instead of allocating a Map and an object per walker per
 * frame. Consumers see it through the readonly InterpolatedPilgrim face and must
 * not hold one across frames.
 */
interface PoseRecord extends InterpolatedPilgrim {
  x: number;
  y: number;
  heading: number;
  kind: InterpolatedPilgrim['kind'];
  race: InterpolatedPilgrim['race'];
  climbHeight: number | null;
}

/**
 * Two-pose interpolator, keyed by walker id.
 *
 * Walkers absent from the newest message are dropped immediately — an arrival or
 * a death is something the server has already decided.
 */
export class PilgrimInterpolator extends PoseInterpolator<
  PilgrimEntityState,
  Pose,
  PoseRecord
> {
  constructor() {
    super({
      minWindowSeconds: MIN_INTERPOLATION_SECONDS,
      maxWindowSeconds: MAX_INTERPOLATION_SECONDS,
      defaultWindowSeconds: DEFAULT_INTERPOLATION_SECONDS,
      createSegment: () => ({ x: 0, y: 0, heading: 0, climbHeight: null, generation: 0 }),
      freeze: (target, source) => {
        target.x = source.x;
        target.y = source.y;
        target.heading = source.heading;
        target.climbHeight = source.climbHeight;
      },
      createRecord: (pilgrim) => ({ ...pilgrim }),
      updateRecord: (record, pilgrim, segment, t) => {
        record.kind = pilgrim.kind;
        record.race = pilgrim.race;
        if (segment === undefined) {
          record.x = pilgrim.x;
          record.y = pilgrim.y;
          record.heading = pilgrim.heading;
          record.climbHeight = pilgrim.climbHeight;
          return;
        }
        // A climb that has just started or just ended has a height on one side
        // of the window only. There is nothing to interpolate BETWEEN there —
        // the other side is "on the ground", whose height this field does not
        // carry — so the newest truth is the answer and the ground follower
        // (client/src/plugins/kit/groundFollow.ts) eases the join.
        record.climbHeight =
          segment.climbHeight === null || pilgrim.climbHeight === null
            ? pilgrim.climbHeight
            : lerp(segment.climbHeight, pilgrim.climbHeight, t);
        record.x = lerp(segment.x, pilgrim.x, t);
        record.y = lerp(segment.y, pilgrim.y, t);
        // The short way round, so a walker turning through ±π spins 10° rather
        // than 350°.
        record.heading = lerpAngle(segment.heading, pilgrim.heading, t);
      },
    });
  }
}
