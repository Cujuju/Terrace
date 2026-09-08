import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

const DEEPSEA_SWAY_HZ = 0.7;
const DEEPSEA_SWAY_RADIANS = 0.22;
const DEEPSEA_LURE_BOB = 0.05;
const DEEPSEA_LURE_LAG_RADIANS = 1;
const DEEPSEA_LURE_REST_Y = 0.23;

const DEEPSEA_NOSE_X = 0.50;
const DEEPSEA_TAIL_TIP_X = -0.50;
const DEEPSEA_LENGTH = DEEPSEA_NOSE_X - DEEPSEA_TAIL_TIP_X;

export const DEEPSEA_ENVELOPE = {
  length: DEEPSEA_LENGTH,
  halfLength: DEEPSEA_LENGTH / 2,
  halfWidth: 0.275,
  crownY: 0.35,
  bellyY: -0.35,
} as const;

export const DEEPSEA_JOINTS: readonly string[] = ['rig', 'lure'];

export const DEEPSEA_ASSET: SpeciesAssetSpec = {
  species: 'deepsea',
  file: 'deepsea.glb',
  joints: DEEPSEA_JOINTS,
  envelope: DEEPSEA_ENVELOPE,
};

export const buildDeepsea = assetSpeciesBuilder(DEEPSEA_ASSET, (joints, seconds, phase) => {
  const beat = seconds * DEEPSEA_SWAY_HZ * TWO_PI + phase;
  joints.rig!.rotation.y = Math.sin(beat) * DEEPSEA_SWAY_RADIANS;
  joints.lure!.position.y = DEEPSEA_LURE_REST_Y + Math.sin(beat - DEEPSEA_LURE_LAG_RADIANS) * DEEPSEA_LURE_BOB;
});
