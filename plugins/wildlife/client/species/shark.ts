import { TWO_PI } from './speciesModel.ts';
import { SWIM_PACE_SCALE } from '../../protocol.ts';
import { SHARK_AUTHORED_BOUNDS } from '../../swimmerBounds.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

const TAIL_HZ = 1.1 * SWIM_PACE_SCALE;
const TAIL_SWING_RADIANS = 0.30;
const BODY_COUNTER_YAW_FRACTION = 0.28;

const SHARK_LENGTH = SHARK_AUTHORED_BOUNDS.noseX - SHARK_AUTHORED_BOUNDS.tailX;

export const SHARK_ENVELOPE = {
  length: SHARK_LENGTH,
  halfLength: SHARK_LENGTH / 2,
  halfWidth: SHARK_AUTHORED_BOUNDS.halfWidth,
  crownY: SHARK_AUTHORED_BOUNDS.crownY,
  bellyY: SHARK_AUTHORED_BOUNDS.bellyY,
} as const;

export const SHARK_ASSET: SpeciesAssetSpec = {
  species: 'shark',
  file: 'shark.glb',
  joints: SWIMMER_JOINTS,
  envelope: SHARK_ENVELOPE,
  bounds: SHARK_AUTHORED_BOUNDS,
};

export const buildShark = assetSpeciesBuilder(SHARK_ASSET, (joints, seconds, phase) => {
  const swing = Math.sin(seconds * TAIL_HZ * TWO_PI + phase);
  joints.tail!.rotation.y = swing * TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
});
