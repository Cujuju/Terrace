import type { SpeciesJoints } from './speciesModel.ts';
import { TWO_PI } from './speciesModel.ts';
import type { SpeciesEnvelope } from './assetSpecies.ts';
import { WHALE_ENVELOPE } from '../whaleSpecies.ts';

export const WHALE_JOINTS: readonly string[] = ['rig', 'flukes'];

export function whaleEnvelope(halfWidth: number): SpeciesEnvelope {
  return {
    length: WHALE_ENVELOPE.length,
    halfLength: WHALE_ENVELOPE.length / 2,
    halfWidth,
    crownY: WHALE_ENVELOPE.crownY,
    bellyY: WHALE_ENVELOPE.bellyY,
  };
}

export const WHALE_FLUKE_HZ = 0.45;
export const WHALE_FLUKE_SWING_RADIANS = 0.3;
export const WHALE_BODY_ROLL_FRACTION = 0.12;

export function animateWhale(joints: SpeciesJoints, seconds: number, phase: number): void {
  const swing = Math.sin(seconds * WHALE_FLUKE_HZ * TWO_PI + phase);
  joints.flukes!.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS;
  joints.rig!.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS * WHALE_BODY_ROLL_FRACTION;
}
