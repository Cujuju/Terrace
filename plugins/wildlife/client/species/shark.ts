import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

const TAIL_HZ = 1.1;
const TAIL_SWING_RADIANS = 0.30;
const BODY_COUNTER_YAW_FRACTION = 0.28;

const SHARK_NOSE_X = 0.70;
const SHARK_TAIL_TIP_X = -1.02;
const SHARK_LENGTH = SHARK_NOSE_X - SHARK_TAIL_TIP_X;

export const SHARK_ENVELOPE = {
  length: SHARK_LENGTH,
  halfLength: SHARK_LENGTH / 2,
  halfWidth: 0.42,
  crownY: 0.40,
  bellyY: -0.26,
} as const;

export const SHARK_ASSET: SpeciesAssetSpec = {
  species: 'shark',
  file: 'shark.glb',
  joints: SWIMMER_JOINTS,
  envelope: SHARK_ENVELOPE,
};

export const buildShark = assetSpeciesBuilder(SHARK_ASSET, (joints, seconds, phase) => {
  const swing = Math.sin(seconds * TAIL_HZ * TWO_PI + phase);
  joints.tail!.rotation.y = swing * TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
});
