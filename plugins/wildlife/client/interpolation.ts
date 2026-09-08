import {
  PoseInterpolator,
  lerp,
  lerpAngle,
  type PoseSegment,
} from '../../../client/src/plugins/kit/interpolator.ts';
import type { WildlifeEntityState, WildlifeSpecies } from '../protocol.ts';

export { lerp, lerpAngle };

export interface InterpolatedEntity {
  readonly id: number;
  readonly species: WildlifeSpecies;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly size: number;
  readonly climbHeight: number | null;
  readonly falling: boolean;
  readonly stance: number | null;
}

export const MIN_INTERPOLATION_SECONDS = 1 / 60;
export const MAX_INTERPOLATION_SECONDS = 1;

export const DEFAULT_INTERPOLATION_SECONDS = 0.2;

interface Pose extends PoseSegment {
  x: number;
  y: number;
  heading: number;
  climbHeight: number | null;
}

interface PoseRecord extends InterpolatedEntity {
  x: number;
  y: number;
  heading: number;
  species: InterpolatedEntity['species'];
  size: InterpolatedEntity['size'];
  climbHeight: number | null;
  falling: boolean;
  stance: number | null;
}

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
      createSegment: () => ({ x: 0, y: 0, heading: 0, climbHeight: null, generation: 0 }),
      freeze: (target, source) => {
        target.x = source.x;
        target.y = source.y;
        target.heading = source.heading;
        target.climbHeight = source.climbHeight;
      },
      createRecord: (entity) => ({ ...entity }),
      updateRecord: (record, entity, segment, t) => {
        record.species = entity.species;
        record.size = entity.size;
        record.falling = entity.falling;
        record.stance = entity.stance;
        if (segment === undefined) {
          record.x = entity.x;
          record.y = entity.y;
          record.heading = entity.heading;
          record.climbHeight = entity.climbHeight;
          return;
        }
        record.x = lerp(segment.x, entity.x, t);
        record.y = lerp(segment.y, entity.y, t);
        record.heading = lerpAngle(segment.heading, entity.heading, t);
        record.climbHeight =
          segment.climbHeight === null || entity.climbHeight === null
            ? entity.climbHeight
            : lerp(segment.climbHeight, entity.climbHeight, t);
      },
    });
  }
}
