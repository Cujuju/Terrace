import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

const WING_FLAP_HZ = 0.6;
const WING_FLAP_RADIANS = 0.30;
const TAIL_WAVE_RADIANS = 0.12;
const TAIL_LAG_RADIANS = 1.2;

const MAX_HALF_HEIGHT = 0.05;
const EYE_DOME_ABOVE_DISC = 0.012;
const WING_ROOT_Z = 0.09;
const WING_SPAN = 0.50;
const WING_REACH = WING_ROOT_Z + WING_SPAN;

const RAY_NOSE_X = 0.33;
const RAY_TAIL_TIP_X = -0.76;
const RAY_LENGTH = RAY_NOSE_X - RAY_TAIL_TIP_X;

export const RAY_REST_ENVELOPE = {
  length: RAY_LENGTH,
  halfLength: RAY_LENGTH / 2,
  halfWidth: WING_REACH,
  crownY: MAX_HALF_HEIGHT + EYE_DOME_ABOVE_DISC,
  bellyY: -MAX_HALF_HEIGHT,
} as const;

export const RAY_ENVELOPE = {
  length: RAY_REST_ENVELOPE.length,
  halfLength: RAY_REST_ENVELOPE.halfLength,
  halfWidth: RAY_REST_ENVELOPE.halfWidth,
  crownY: WING_REACH * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT,
  bellyY: -(WING_REACH * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT),
} as const;

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
  joints.wing_starboard!.rotation.x = -flap;
  joints.wing_port!.rotation.x = flap;
  joints.tail!.rotation.y = Math.sin(beat - TAIL_LAG_RADIANS) * TAIL_WAVE_RADIANS;
});
