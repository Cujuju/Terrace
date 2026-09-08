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

function pitchOf(gait: MoverGait, seconds: number, phase: number): number {
  if (gait === 'fall') {
    return (
      FALL_PITCH_RADIANS + Math.sin(seconds * TWO_PI * FALL_TUMBLE_HZ + phase) * FALL_TUMBLE_RADIANS
    );
  }
  if (gait === 'climb') return CLIMB_LEAN_RADIANS;
  return UPRIGHT_RADIANS;
}

export function applyMoverBodyTilt(
  root: Object3D,
  gait: MoverGait,
  seconds: number,
  phase: number,
): void {
  root.rotation.z = pitchOf(gait, seconds, phase);
}
