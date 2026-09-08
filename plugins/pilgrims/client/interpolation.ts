import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { PilgrimEntityState, SettlerRace, WalkerKind } from '../protocol.ts';

export { lerp, lerpAngle };

export interface InterpolatedPilgrim {
  readonly id: number;
  readonly kind: WalkerKind;
  readonly race: SettlerRace;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly climbHeight: number | null;
  readonly falling: boolean;
  readonly stance: number | null;
}

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

export const DEFAULT_INTERPOLATION_SECONDS = 0.2;

interface Pose extends PoseSegment {
  climbHeight: number | null;
  x: number;
  y: number;
  heading: number;
}

interface PoseRecord extends InterpolatedPilgrim {
  x: number;
  y: number;
  heading: number;
  kind: InterpolatedPilgrim['kind'];
  race: InterpolatedPilgrim['race'];
  climbHeight: number | null;
  falling: boolean;
  stance: number | null;
}

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
        record.falling = pilgrim.falling;
        record.stance = pilgrim.stance;
        if (segment === undefined) {
          record.x = pilgrim.x;
          record.y = pilgrim.y;
          record.heading = pilgrim.heading;
          record.climbHeight = pilgrim.climbHeight;
          return;
        }
        record.climbHeight =
          segment.climbHeight === null || pilgrim.climbHeight === null
            ? pilgrim.climbHeight
            : lerp(segment.climbHeight, pilgrim.climbHeight, t);
        record.x = lerp(segment.x, pilgrim.x, t);
        record.y = lerp(segment.y, pilgrim.y, t);
        record.heading = lerpAngle(segment.heading, pilgrim.heading, t);
      },
    });
  }
}
