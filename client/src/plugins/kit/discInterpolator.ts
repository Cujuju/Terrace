import type { DiscSystemState } from '@terrace/shared';
import { PoseInterpolator, lerp, type PoseSegment } from './interpolator.ts';

export interface InterpolatedDisc {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
  readonly vx: number;
  readonly vy: number;
}

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 2;

export const DEFAULT_INTERPOLATION_SECONDS = 1;

interface DiscPose extends PoseSegment {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
}

interface DiscPoseRecord extends InterpolatedDisc {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  vx: number;
  vy: number;
}

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
