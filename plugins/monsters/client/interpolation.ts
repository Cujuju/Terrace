import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { MonsterKind, MonsterState, YetiVariant } from '../protocol.ts';

export { lerp, lerpAngle };

export interface InterpolatedMonster {
  readonly id: number;
  readonly kind: MonsterKind;
  readonly variant?: YetiVariant;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly climbHeight: number | null;
  readonly falling: boolean;
  readonly stance: number | null;
}

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 2;

export const DEFAULT_INTERPOLATION_SECONDS = 1;

interface Pose extends PoseSegment {
  x: number;
  y: number;
  heading: number;
  climbHeight: number | null;
}

interface PoseRecord extends InterpolatedMonster {
  x: number;
  y: number;
  heading: number;
  kind: InterpolatedMonster['kind'];
  variant?: YetiVariant;
  climbHeight: number | null;
  falling: boolean;
  stance: number | null;
}

export class MonsterInterpolator extends PoseInterpolator<MonsterState, Pose, PoseRecord> {
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
        target.climbHeight = source.climbHeight ?? null;
      },
      createRecord: (monster) => ({
        ...monster,
        climbHeight: monster.climbHeight ?? null,
        falling: monster.falling === true,
        stance: monster.stance ?? null,
      }),
      updateRecord: (record, monster, segment, t) => {
        record.kind = monster.kind;
        record.falling = monster.falling === true;
        record.stance = monster.stance ?? null;
        if (monster.variant === undefined) delete record.variant;
        else record.variant = monster.variant;
        const climbHeight = monster.climbHeight ?? null;
        if (segment === undefined) {
          record.x = monster.x;
          record.y = monster.y;
          record.heading = monster.heading;
          record.climbHeight = climbHeight;
          return;
        }
        record.x = lerp(segment.x, monster.x, t);
        record.y = lerp(segment.y, monster.y, t);
        record.climbHeight =
          segment.climbHeight === null || climbHeight === null
            ? climbHeight
            : lerp(segment.climbHeight, climbHeight, t);
        record.heading = lerpAngle(segment.heading, monster.heading, t);
      },
    });
  }
}
