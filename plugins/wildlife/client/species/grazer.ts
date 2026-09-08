import { poseSit, poseStand, poseWalk } from './quadruped.ts';
import {
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
  type SpeciesEnvelope,
} from './assetSpecies.ts';

export const GRAZER_SCALE = 0.4;

export const GRAZER_DRAW_SCALE = 0.9;

const REPLACED_FIGURE_HEIGHT = 1.16;

const GRAZER_HEIGHT_WORLD_UNITS = REPLACED_FIGURE_HEIGHT * GRAZER_SCALE;

const GRAZER_ASSET_ENVELOPE: SpeciesEnvelope = {
  length: 0.4774,
  halfLength: 0.2387,
  halfWidth: 0.0792,
  crownY: GRAZER_HEIGHT_WORLD_UNITS,
  bellyY: 0,
};

export const GRAZER_ENVELOPE = {
  length: GRAZER_ASSET_ENVELOPE.length,
  bodyHalfLength: GRAZER_ASSET_ENVELOPE.halfLength,
  height: GRAZER_ASSET_ENVELOPE.crownY,
} as const;

const GRAZER_JOINTS = ['rig', 'foreLeft', 'foreRight', 'hindLeft', 'hindRight', 'head'];

const GRAZER_ADOPTIONS = [
  { node: 'IKFrontLegL', under: 'foreLeft' },
  { node: 'IKFrontLegR', under: 'foreRight' },
  { node: 'IKBackLegL', under: 'hindLeft' },
  { node: 'IKBackLegR', under: 'hindRight' },
];

export const GRAZER_ASSET: SpeciesAssetSpec = {
  species: 'grazer',
  file: 'grazer-deer.glb',
  joints: GRAZER_JOINTS,
  envelope: GRAZER_ASSET_ENVELOPE,
  rigidified: true,
  adopt: GRAZER_ADOPTIONS,
};

export const GRAZER_STRIDE_WORLD_UNITS = 0.4;
const LEG_SWING_RADIANS = 0.32;
const WALK_BOB_WORLD_UNITS = 0.012;
const HEAD_NOD_RADIANS = 0.05;

export const buildGrazer = assetSpeciesBuilder(
  GRAZER_ASSET,
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
