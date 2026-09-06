// Body: ../assets/angelfish.glb (build_angelfish.py). ANGELFISH_ENVELOPE is the placement
// contract. The bars are geometry, not paint: halfWidth is a bar's face, checked by `flank`.
import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

/** Nose-to-peduncle hull length; the caudal fin adds to it behind. */
const HULL_LENGTH = 0.50;
const HULL_CENTRE_X = 0.0;
/** The `nose` anchor. */
const NOSE_X = 0.25;
/** Peduncle: the hinge the tail swings from. */
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
/** Caudal reach behind the peduncle, to the `tail_tip` anchor. */
const CAUDAL_REACH = 0.13;
/** A bar's outer face: the `flank` anchor. The hull itself is 0.07 across. */
const BAR_HALF_THICKNESS = 0.085;

export const ANGELFISH_TAIL_HZ = 2.2;
export const ANGELFISH_TAIL_SWING_RADIANS = 0.35;
/** Head yaws opposite the tail by this fraction of the swing. */
const BODY_COUNTER_YAW_FRACTION = 0.18;
/** Rest pose lives here: the hinges are identity in the file and `animate` assigns outright. */
const PECTORAL_DIHEDRAL_RADIANS = 0.55;
const PECTORAL_FLUTTER_RADIANS = 0.14;
const PECTORAL_LAG_RADIANS = 0.9;

/**
 * Dorsal tip: the `crown` anchor. Full precision because it is the procedural
 * hull's half-height at x=-0.06 (0.12377411123027341) - 0.035 + 0.24.
 */
const DORSAL_CROWN_Y = 0.3287741112302734;
/** Anal tip: the `belly` anchor. -(half-height at x=-0.05, 0.13027641296386721) + 0.035 - 0.22. */
const ANAL_BELLY_Y = -0.3152764129638672;

/** World units at model scale 1. placement.ts reads these; the asset must measure them. */
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
  // Opposite signs: a roll about +X drops one fin and lifts the other. Port is -Z.
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
