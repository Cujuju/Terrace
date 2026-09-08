import { poseSit, poseStand, poseWalk } from './quadruped.ts';
import {
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
  type SpeciesEnvelope,
} from './assetSpecies.ts';

const GRAZER_CROWN_HEIGHT_WORLD_UNITS = 0.464;

const WOLF_TO_GRAZER_CROWN_RATIO = 0.75;

const WOLF_HEIGHT_WORLD_UNITS = GRAZER_CROWN_HEIGHT_WORLD_UNITS * WOLF_TO_GRAZER_CROWN_RATIO;

const WOLF_ASSET_ENVELOPE: SpeciesEnvelope = {
  length: 0.7208,
  halfLength: 0.3604,
  halfWidth: 0.0691,
  crownY: WOLF_HEIGHT_WORLD_UNITS,
  bellyY: 0,
};

const WOLF_STANCE_FRACTION_OF_HALF_LENGTH = 0.6;

export const WOLF_ENVELOPE = {
  length: WOLF_ASSET_ENVELOPE.length,
  bodyHalfLength: WOLF_ASSET_ENVELOPE.halfLength * WOLF_STANCE_FRACTION_OF_HALF_LENGTH,
  height: WOLF_ASSET_ENVELOPE.crownY,
} as const;

const WOLF_JOINTS = ['rig', 'foreLeft', 'foreRight', 'hindLeft', 'hindRight', 'head'];

const WOLF_ADOPTIONS = [
  { node: 'IKFrontLegL', under: 'foreLeft' },
  { node: 'IKFrontLegR', under: 'foreRight' },
  { node: 'IKBackLegL', under: 'hindLeft' },
  { node: 'IKBackLegR', under: 'hindRight' },
];

export const WOLF_ASSET: SpeciesAssetSpec = {
  species: 'wolf',
  file: 'wolf.glb',
  joints: WOLF_JOINTS,
  envelope: WOLF_ASSET_ENVELOPE,
  rigidified: true,
  adopt: WOLF_ADOPTIONS,
};

const WOLF_PAW_SPAN_WORLD_UNITS = 0.314;

export const WOLF_STRIDE_WORLD_UNITS = WOLF_PAW_SPAN_WORLD_UNITS;
const LEG_SWING_RADIANS = 0.32;
const WALK_BOB_WORLD_UNITS = 0.012 * WOLF_TO_GRAZER_CROWN_RATIO;
const HEAD_NOD_RADIANS = 0.05 * WOLF_TO_GRAZER_CROWN_RATIO;

export const buildWolf = assetSpeciesBuilder(
  WOLF_ASSET,
  (joints, seconds, phase, gait) => {
    if (gait === 'stand' || gait === 'sit') {
      if (gait === 'stand') poseStand(joints, seconds, phase, WALK_BOB_WORLD_UNITS);
      else poseSit(joints, seconds, phase, WALK_BOB_WORLD_UNITS);
      joints.head!.rotation.z = 0;
      return;
    }
    const beat = phase;
    poseWalk(joints, beat, LEG_SWING_RADIANS, WALK_BOB_WORLD_UNITS);
    joints.head!.rotation.z = Math.sin(beat * 2) * HEAD_NOD_RADIANS;
  },
  true,
);
