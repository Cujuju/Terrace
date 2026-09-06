// Body: ../assets/deepsea.glb (build_deepsea.py). crownY/bellyY feed BODY_COLUMNS.deepsea.
// The lure is unlit IN THE FILE (KHR_materials_unlit): two baked surfaces (TWO_SURFACE_SPECIES).
import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

const DEEPSEA_SWAY_HZ = 0.7;
const DEEPSEA_SWAY_RADIANS = 0.22;
const DEEPSEA_LURE_BOB = 0.05;
const DEEPSEA_LURE_LAG_RADIANS = 1;
/** The `lure` Empty's y in the file (build_deepsea.py LURE_REST); the bob is absolute about it. */
const DEEPSEA_LURE_REST_Y = 0.23;

/** Stations of the `nose` (jaw tip) and `tail_tip` anchors at model scale 1. */
const DEEPSEA_NOSE_X = 0.50;
const DEEPSEA_TAIL_TIP_X = -0.50;
const DEEPSEA_LENGTH = DEEPSEA_NOSE_X - DEEPSEA_TAIL_TIP_X;

/** World units at model scale 1; the asset must measure these. */
export const DEEPSEA_ENVELOPE = {
  length: DEEPSEA_LENGTH,
  halfLength: DEEPSEA_LENGTH / 2,
  /** The hull's width plateau; the drooping pectorals reach further. */
  halfWidth: 0.275,
  /** Dorsal tip. */
  crownY: 0.35,
  /** Throat plateau under the mouth. */
  bellyY: -0.35,
} as const;

/** `lure` is driven in position, the one such joint in this directory. */
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
