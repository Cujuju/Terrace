import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { SaucerPhase, SaucerState } from '../protocol.ts';

export { lerp, lerpAngle };

export interface InterpolatedSaucer {
  readonly id: number;
  readonly variant: number;
  readonly x: number;
  readonly y: number;
  readonly alt: number;
  readonly heading: number;
  readonly speed: number;
  readonly phase: SaucerPhase;
  readonly hp: number;
}

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 0.25;

export const DEFAULT_INTERPOLATION_SECONDS = 0.1;

interface Pose extends PoseSegment {
  x: number;
  y: number;
  alt: number;
  heading: number;
}

interface PoseRecord extends InterpolatedSaucer {
  variant: number;
  x: number;
  y: number;
  alt: number;
  heading: number;
  speed: number;
  phase: SaucerPhase;
  hp: number;
}

export class SaucerInterpolator extends PoseInterpolator<SaucerState, Pose, PoseRecord> {
  constructor() {
    super({
      minWindowSeconds: MIN_INTERPOLATION_SECONDS,
      maxWindowSeconds: MAX_INTERPOLATION_SECONDS,
      defaultWindowSeconds: DEFAULT_INTERPOLATION_SECONDS,
      createSegment: () => ({ x: 0, y: 0, alt: 0, heading: 0, generation: 0 }),
      freeze: (target, source) => {
        target.x = source.x;
        target.y = source.y;
        target.alt = source.alt;
        target.heading = source.heading;
      },
      createRecord: (saucer) => ({ ...saucer }),
      updateRecord: (record, saucer, segment, t) => {
        record.variant = saucer.variant;
        record.speed = saucer.speed;
        record.phase = saucer.phase;
        record.hp = saucer.hp;
        if (segment === undefined) {
          record.x = saucer.x;
          record.y = saucer.y;
          record.alt = saucer.alt;
          record.heading = saucer.heading;
          return;
        }
        record.x = lerp(segment.x, saucer.x, t);
        record.y = lerp(segment.y, saucer.y, t);
        record.alt = lerp(segment.alt, saucer.alt, t);
        record.heading = lerpAngle(segment.heading, saucer.heading, t);
      },
    });
  }
}
