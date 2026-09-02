// Smoothing 1 Hz server truth into 60 Hz motion.
//
// The server broadcasts the full monster list once a second. Drawing those
// positions directly would step a swimmer across the sea like a stop-motion
// film. The interpolator keeps the last rendered pose and the newest received
// one and walks between them.
//
// THE MACHINERY IS THE CLIENT KIT'S (client/src/plugins/kit/interpolator.ts):
// five plugins carried the same class over different payloads. What is left here
// is the part that is actually about monsters — this plugin's window bounds, and
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
import type { MonsterKind, MonsterState, YetiVariant } from '../protocol.ts';

export { lerp, lerpAngle };

/** A monster's pose for one frame. */
export interface InterpolatedMonster {
  readonly id: number;
  readonly kind: MonsterKind;
  readonly variant?: YetiVariant;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/**
 * Bounds on the measured inter-message gap used as the interpolation window.
 *
 * The window is measured rather than assumed, so this keeps working if the
 * server's tick rate or broadcast interval is retuned — but a measurement taken
 * across a stall must not become the window. The floor is one 60 Hz frame; the
 * ceiling is two seconds, sized to ride out exactly one dropped message at the
 * shipped 1 Hz cadence.
 */
export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 2;

/** Nominal window before any two messages have been seen (1 Hz = 1 s). */
export const DEFAULT_INTERPOLATION_SECONDS = 1;

/** The pose a segment is walked from. */
interface Pose extends PoseSegment {
  x: number;
  y: number;
  heading: number;
}

/**
 * One monster's pose record. Mutable and PERSISTENT: the kit refills these in
 * place every frame instead of allocating a Map and an object per monster per
 * frame. Consumers see it through the readonly InterpolatedMonster face and must
 * not hold one across frames.
 */
interface PoseRecord extends InterpolatedMonster {
  x: number;
  y: number;
  heading: number;
  kind: InterpolatedMonster['kind'];
  variant?: YetiVariant;
}

/**
 * Two-pose interpolator, keyed by monster id.
 *
 * Monsters absent from the newest message are dropped immediately — a departure
 * is something the server has already decided.
 */
export class MonsterInterpolator extends PoseInterpolator<MonsterState, Pose, PoseRecord> {
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
      createRecord: (monster) => ({ ...monster }),
      updateRecord: (record, monster, segment, t) => {
        record.kind = monster.kind;
        // DELETED rather than set to undefined when the payload has none, so a
        // record that once carried a variant does not keep the key around and
        // read as a yeti that lost its body.
        if (monster.variant === undefined) delete record.variant;
        else record.variant = monster.variant;
        if (segment === undefined) {
          record.x = monster.x;
          record.y = monster.y;
          record.heading = monster.heading;
          return;
        }
        record.x = lerp(segment.x, monster.x, t);
        record.y = lerp(segment.y, monster.y, t);
        // The short way round, so a swimmer turning through ±π spins 10° rather
        // than 350°.
        record.heading = lerpAngle(segment.heading, monster.heading, t);
      },
    });
  }
}
