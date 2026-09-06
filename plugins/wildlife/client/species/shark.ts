// Body: ../assets/shark.glb (build_shark.py). SHARK_ENVELOPE is the placement contract.
// The pectoral anhedral is baked in the mesh: a fin tip IS bellyY/halfWidth, measured at rest.
import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

const TAIL_HZ = 1.1;
const TAIL_SWING_RADIANS = 0.30;
/** Head yaws opposite the tail by this fraction of the swing. */
const BODY_COUNTER_YAW_FRACTION = 0.28;

/** Stations of the `nose` and `tail_tip` anchors at model scale 1. */
const SHARK_NOSE_X = 0.70;
const SHARK_TAIL_TIP_X = -1.02;
const SHARK_LENGTH = SHARK_NOSE_X - SHARK_TAIL_TIP_X;

/** World units at model scale 1. placement.ts reads these; the asset must measure them. */
export const SHARK_ENVELOPE = {
  length: SHARK_LENGTH,
  halfLength: SHARK_LENGTH / 2,
  /** To a pectoral tip, not the body: placement fits the swim column to the fins. */
  halfWidth: 0.42,
  /** First dorsal tip. */
  crownY: 0.40,
  /** A pectoral tip, angled down. */
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
  // Pectoral hinges are left untouched: their rest pose is the file's.
  joints.tail!.rotation.y = swing * TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
});
