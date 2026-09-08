import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { BoatState } from '../protocol.ts';

export { lerp, lerpAngle };

export interface InterpolatedBoat {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly fighting: boolean;
}

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

export const DEFAULT_INTERPOLATION_SECONDS = 0.5;

interface Pose extends PoseSegment {
  x: number;
  y: number;
  heading: number;
}

interface PoseRecord extends InterpolatedBoat {
  x: number;
  y: number;
  heading: number;
  fighting: InterpolatedBoat['fighting'];
}

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
        record.heading = lerpAngle(segment.heading, boat.heading, t);
      },
    });
  }
}
