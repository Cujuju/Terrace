// Body: ../assets/eel.glb (build_eel.py). EEL_ENVELOPE is the placement contract.
// Five nested spine hinges carry the wave; a bent eel is shorter, so rest is conservative.
import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

/** Nose-to-stem hull length; the paddle adds to it behind. */
const HULL_LENGTH = 1.15;
const HULL_CENTRE_X = 0.02;
/** The `nose` anchor. */
const NOSE_X = 0.595;
/** The `flank` anchor. */
const MAX_HALF_WIDTH = 0.075;
/** Stem: the hinge the paddle waves from. */
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
/** Paddle reach behind the stem, to the `tail_tip` anchor. */
const PADDLE_REACH = 0.14;

export const EEL_TAIL_HZ = 1.6;
/** Head to stem; each joint lags the one before, so about one S fits the body. */
const SPINE_AMPLITUDES = [0.05, 0.09, 0.13, 0.17, 0.21] as const;
const SPINE_LAG_RADIANS = 1.1;
export const EEL_TAIL_SWING_RADIANS = 0.40;
const RIG_SWAY_RADIANS = 0.03;
const RIG_SWAY_LEAD_RADIANS = 0.6;
/** Rest pose lives here: the hinges are identity in the file and `animate` assigns outright. */
const PECTORAL_DIHEDRAL_RADIANS = 0.5;
const PECTORAL_FLUTTER_RADIANS = 0.10;
const PECTORAL_LAG_RADIANS = 1.1;

/**
 * Dorsal ridge crest: the `crown` anchor. Full precision because it is the
 * procedural hull's half-height at x=-0.30 (0.04564932759133065) - 0.025 + 0.05.
 */
const RIDGE_CROWN_Y = 0.07064932759133065;
const HULL_BELLY = MAX_HALF_WIDTH * 1.15;

/** World units at model scale 1. placement.ts reads these; the asset must measure them. */
export const EEL_ENVELOPE = {
  length: NOSE_X + -PEDUNCLE_X + PADDLE_REACH,
  halfLength: (NOSE_X + -PEDUNCLE_X + PADDLE_REACH) / 2,
  halfWidth: MAX_HALF_WIDTH,
  crownY: RIDGE_CROWN_Y,
  bellyY: -HULL_BELLY,
} as const;

const SPINE_JOINTS = ['spine0', 'spine1', 'spine2', 'spine3', 'spine4'] as const;

/** Not SWIMMER_JOINTS: spine hinges nest head to stem; `tail` hangs under spine4, pectorals under spine0. */
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
  // Child yaw composes onto the parent's: these are relative bends.
  for (let i = 0; i < SPINE_JOINTS.length; i++) {
    joints[SPINE_JOINTS[i]!]!.rotation.y =
      Math.sin(beat - i * SPINE_LAG_RADIANS) * SPINE_AMPLITUDES[i]!;
  }
  joints.tail!.rotation.y =
    Math.sin(beat - SPINE_JOINTS.length * SPINE_LAG_RADIANS) * EEL_TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = Math.sin(beat + RIG_SWAY_LEAD_RADIANS) * RIG_SWAY_RADIANS;
  // Opposite signs: a roll about +X drops one fin and lifts the other. Port is -Z.
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
