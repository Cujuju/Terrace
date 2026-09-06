// Body: ../assets/ray.glb (tools/blender/build_ray.py). Two envelopes: the file is
// checked at rest (wings flat); placement reads the swept one (wing tips at the
// top and bottom of the beat).
import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

const WING_FLAP_HZ = 0.6;
const WING_FLAP_RADIANS = 0.30;
const TAIL_WAVE_RADIANS = 0.12;
const TAIL_LAG_RADIANS = 1.2;

/** Disc half-height at its thickest station: the rest belly, and the swept envelope's disc term. */
const MAX_HALF_HEIGHT = 0.05;
/** Eye domes stand this far above the disc's back: the rest crown. */
const EYE_DOME_ABOVE_DISC = 0.012;
/** Wing hinge offset plus span: the half-wingspan and the radius a tip sweeps. */
const WING_ROOT_Z = 0.09;
const WING_SPAN = 0.50;
const WING_REACH = WING_ROOT_Z + WING_SPAN;

/** Stations of the `nose` (cephalic lobes) and `tail_tip` (whip) anchors at model scale 1. */
const RAY_NOSE_X = 0.33;
const RAY_TAIL_TIP_X = -0.76;
const RAY_LENGTH = RAY_NOSE_X - RAY_TAIL_TIP_X;

/** What the file measures with the wings flat; asserted at install. placement.ts does not read it. */
export const RAY_REST_ENVELOPE = {
  length: RAY_LENGTH,
  halfLength: RAY_LENGTH / 2,
  halfWidth: WING_REACH,
  crownY: MAX_HALF_HEIGHT + EYE_DOME_ABOVE_DISC,
  bellyY: -MAX_HALF_HEIGHT,
} as const;

/** What placement.ts reads: rest disc plus the flap's vertical reach. */
export const RAY_ENVELOPE = {
  length: RAY_REST_ENVELOPE.length,
  halfLength: RAY_REST_ENVELOPE.halfLength,
  halfWidth: RAY_REST_ENVELOPE.halfWidth,
  crownY: WING_REACH * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT,
  bellyY: -(WING_REACH * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT),
} as const;

/** Not SWIMMER_JOINTS: the pectorals are wings flapping about X; `tail` is the whip's root. */
const RAY_JOINTS: readonly string[] = ['rig', 'wing_port', 'wing_starboard', 'tail'];

export const RAY_ASSET: SpeciesAssetSpec = {
  species: 'ray',
  file: 'ray.glb',
  joints: RAY_JOINTS,
  envelope: RAY_REST_ENVELOPE,
};

export const buildRay = assetSpeciesBuilder(RAY_ASSET, (joints, seconds, phase) => {
  const beat = seconds * WING_FLAP_HZ * TWO_PI + phase;
  const flap = Math.sin(beat) * WING_FLAP_RADIANS;
  // Rotation about +X sends the +Z tip down, so starboard (+Z) takes -flap and both tips rise together.
  joints.wing_starboard!.rotation.x = -flap;
  joints.wing_port!.rotation.x = flap;
  joints.tail!.rotation.y = Math.sin(beat - TAIL_LAG_RADIANS) * TAIL_WAVE_RADIANS;
});
