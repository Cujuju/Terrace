import type { Object3D } from 'three';
import { FALL_SECONDS_PER_BAND } from '@terrace/shared';
import type { MoverGait } from './moverGait.ts';

const TWO_PI = Math.PI * 2;

const UPRIGHT_RADIANS = 0;

const FALL_PITCH_RADIANS = Math.PI;

const FALL_TUMBLE_RADIANS = Math.PI / 8;

const FALL_TUMBLE_SWINGS_PER_BAND = 0.5;
const FALL_TUMBLE_HZ = FALL_TUMBLE_SWINGS_PER_BAND / FALL_SECONDS_PER_BAND;

const CLIMB_LEAN_RADIANS = -0.14;

// Face-first down a riser: nose down a third of the way to vertical.
const DESCEND_PITCH_RADIANS = -Math.PI / 6;

function pitchOf(gait: MoverGait, seconds: number, phase: number, ownsClimbPitch: boolean): number {
  if (gait === 'fall') {
    return (
      FALL_PITCH_RADIANS + Math.sin(seconds * TWO_PI * FALL_TUMBLE_HZ + phase) * FALL_TUMBLE_RADIANS
    );
  }
  if (ownsClimbPitch) return UPRIGHT_RADIANS;
  if (gait === 'climb') return CLIMB_LEAN_RADIANS;
  if (gait === 'descend') return DESCEND_PITCH_RADIANS;
  return UPRIGHT_RADIANS;
}

/** `ownsClimbPitch`: the species pose pitches its own climbs, so the root stays upright. */
export function applyMoverBodyTilt(
  root: Object3D,
  gait: MoverGait,
  seconds: number,
  phase: number,
  ownsClimbPitch = false,
): void {
  root.rotation.z = pitchOf(gait, seconds, phase, ownsClimbPitch);
}
