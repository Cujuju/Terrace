import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

const HULL_LENGTH = 0.50;
const HULL_CENTRE_X = 0.0;
const NOSE_X = 0.25;
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
const CAUDAL_REACH = 0.13;
const BAR_HALF_THICKNESS = 0.085;

export const ANGELFISH_TAIL_HZ = 2.2;
export const ANGELFISH_TAIL_SWING_RADIANS = 0.35;
const BODY_COUNTER_YAW_FRACTION = 0.18;
const PECTORAL_DIHEDRAL_RADIANS = 0.55;
const PECTORAL_FLUTTER_RADIANS = 0.14;
const PECTORAL_LAG_RADIANS = 0.9;

const DORSAL_CROWN_Y = 0.3287741112302734;
const ANAL_BELLY_Y = -0.3152764129638672;

export const ANGELFISH_ENVELOPE = {
  length: NOSE_X + -PEDUNCLE_X + CAUDAL_REACH,
  halfLength: (NOSE_X + -PEDUNCLE_X + CAUDAL_REACH) / 2,
  halfWidth: BAR_HALF_THICKNESS,
  crownY: DORSAL_CROWN_Y,
  bellyY: ANAL_BELLY_Y,
} as const;

export const ANGELFISH_ASSET: SpeciesAssetSpec = {
  species: 'angelfish',
  file: 'angelfish.glb',
  joints: SWIMMER_JOINTS,
  envelope: ANGELFISH_ENVELOPE,
};

export const buildAngelfish = assetSpeciesBuilder(ANGELFISH_ASSET, (joints, seconds, phase) => {
  const beat = seconds * ANGELFISH_TAIL_HZ * TWO_PI + phase;
  const swing = Math.sin(beat);
  joints.tail!.rotation.y = swing * ANGELFISH_TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * ANGELFISH_TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
