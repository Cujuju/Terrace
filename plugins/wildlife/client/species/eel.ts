import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

const HULL_LENGTH = 1.15;
const HULL_CENTRE_X = 0.02;
const NOSE_X = 0.595;
const MAX_HALF_WIDTH = 0.075;
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
const PADDLE_REACH = 0.14;

export const EEL_TAIL_HZ = 1.6;
const SPINE_AMPLITUDES = [0.05, 0.09, 0.13, 0.17, 0.21] as const;
const SPINE_LAG_RADIANS = 1.1;
export const EEL_TAIL_SWING_RADIANS = 0.40;
const RIG_SWAY_RADIANS = 0.03;
const RIG_SWAY_LEAD_RADIANS = 0.6;
const PECTORAL_DIHEDRAL_RADIANS = 0.5;
const PECTORAL_FLUTTER_RADIANS = 0.10;
const PECTORAL_LAG_RADIANS = 1.1;

const RIDGE_CROWN_Y = 0.07064932759133065;
const HULL_BELLY = MAX_HALF_WIDTH * 1.15;

export const EEL_ENVELOPE = {
  length: NOSE_X + -PEDUNCLE_X + PADDLE_REACH,
  halfLength: (NOSE_X + -PEDUNCLE_X + PADDLE_REACH) / 2,
  halfWidth: MAX_HALF_WIDTH,
  crownY: RIDGE_CROWN_Y,
  bellyY: -HULL_BELLY,
} as const;

const SPINE_JOINTS = ['spine0', 'spine1', 'spine2', 'spine3', 'spine4'] as const;

const EEL_JOINTS: readonly string[] = [
  'rig',
  ...SPINE_JOINTS,
  'tail',
  'pectoral_port',
  'pectoral_starboard',
];

export const EEL_ASSET: SpeciesAssetSpec = {
  species: 'eel',
  file: 'eel.glb',
  joints: EEL_JOINTS,
  envelope: EEL_ENVELOPE,
};

export const buildEel = assetSpeciesBuilder(EEL_ASSET, (joints, seconds, phase) => {
  const beat = seconds * EEL_TAIL_HZ * TWO_PI + phase;
  for (let i = 0; i < SPINE_JOINTS.length; i++) {
    joints[SPINE_JOINTS[i]!]!.rotation.y =
      Math.sin(beat - i * SPINE_LAG_RADIANS) * SPINE_AMPLITUDES[i]!;
  }
  joints.tail!.rotation.y =
    Math.sin(beat - SPINE_JOINTS.length * SPINE_LAG_RADIANS) * EEL_TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = Math.sin(beat + RIG_SWAY_LEAD_RADIANS) * RIG_SWAY_RADIANS;
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
