// Body: ../assets/fish.glb (tools/blender/build_fish.py). FISH_ENVELOPE is the
// placement contract; the asset is asserted against it at install.
import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

export const FISH_TAIL_HZ = 3.2;
export const FISH_TAIL_SWING_RADIANS = 0.45;
/** Head yaws opposite the tail by this fraction of the swing. */
const BODY_COUNTER_YAW_FRACTION = 0.18;
/** Rest pose lives here: the hinges are identity in the file and `animate` assigns outright. */
const PECTORAL_DIHEDRAL_RADIANS = 0.55;
const PECTORAL_FLUTTER_RADIANS = 0.14;
const PECTORAL_LAG_RADIANS = 0.9;

/** Stations of the `nose` and `tail_tip` anchors at model scale 1. */
const FISH_NOSE_X = 0.30;
const FISH_TAIL_TIP_X = -0.42;
const FISH_LENGTH = FISH_NOSE_X - FISH_TAIL_TIP_X;

/** World units at model scale 1. placement.ts reads these; the asset must measure them. */
export const FISH_ENVELOPE = {
  length: FISH_LENGTH,
  halfLength: FISH_LENGTH / 2,
  /** The body's widest half-width; the pectorals reach further. */
  halfWidth: 0.08,
  crownY: 0.17,
  bellyY: -0.17,
} as const;

export const FISH_ASSET: SpeciesAssetSpec = {
  species: 'fish',
  file: 'fish.glb',
  joints: SWIMMER_JOINTS,
  envelope: FISH_ENVELOPE,
};

export const buildFish = assetSpeciesBuilder(FISH_ASSET, (joints, seconds, phase) => {
  const beat = seconds * FISH_TAIL_HZ * TWO_PI + phase;
  const swing = Math.sin(beat);
  joints.tail!.rotation.y = swing * FISH_TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * FISH_TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  // Opposite signs: a roll about +X drops one fin and lifts the other. Port is -Z.
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
