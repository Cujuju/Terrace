import type { SkyRigState } from '../../../client/src/plugins/types.ts';
import { CYCLONE_EYE_RADIUS_FRACTION } from '../protocol.ts';

export const MAX_GLOOM_LIGHT_LOSS = 0.6;

export const GLOOM_COLOR = 0x3a4048;

export const GLOOM_RESPONSE_PER_SECOND = 0.35;

// Bounced and ambient light survive the deck better than the sun does, which
// takes the loss in full; each takes only this share of it.
const HEMISPHERE_GLOOM_LOSS_SHARE = 2 / 3;
const AMBIENT_GLOOM_LOSS_SHARE = 1 / 3;

const EYEWALL_SOFTNESS_FRACTION = 0.06;

export function overheadFraction(distanceCells: number, radiusCells: number): number {
  if (!(radiusCells > 0)) return 0;
  const r = distanceCells / radiusCells;
  if (r >= 1) return 0;

  const eye = CYCLONE_EYE_RADIUS_FRACTION;
  if (r <= eye) return 0;

  const overEyewall = Math.min(1, (r - eye) / EYEWALL_SOFTNESS_FRACTION);
  const towardRim = (r - eye) / (1 - eye);
  return overEyewall * (1 - towardRim * towardRim);
}

const RED_SHIFT = 16;
const GREEN_SHIFT = 8;
const BLUE_SHIFT = 0;

function mixChannel(from: number, to: number, t: number, shift: number): number {
  const a = (from >> shift) & 0xff;
  const b = (to >> shift) & 0xff;
  return Math.round(a + (b - a) * t) & 0xff;
}

function mixHex(from: number, to: number, t: number): number {
  return (
    (mixChannel(from, to, t, RED_SHIFT) << RED_SHIFT) |
    (mixChannel(from, to, t, GREEN_SHIFT) << GREEN_SHIFT) |
    mixChannel(from, to, t, BLUE_SHIFT)
  );
}

export function applyGloom(state: SkyRigState, depth: number): SkyRigState {
  const clamped = Math.min(1, Math.max(0, depth));
  if (clamped <= 0) return state;

  const loss = clamped * MAX_GLOOM_LIGHT_LOSS;
  return {
    sunDirection: state.sunDirection,
    sunColor: mixHex(state.sunColor, GLOOM_COLOR, clamped),
    sunIntensity: state.sunIntensity * (1 - loss),
    hemisphereSkyColor: mixHex(state.hemisphereSkyColor, GLOOM_COLOR, clamped),
    hemisphereGroundColor: mixHex(state.hemisphereGroundColor, GLOOM_COLOR, clamped),
    hemisphereIntensity: state.hemisphereIntensity * (1 - loss * HEMISPHERE_GLOOM_LOSS_SHARE),
    ambientColor: mixHex(state.ambientColor, GLOOM_COLOR, clamped),
    ambientIntensity: state.ambientIntensity * (1 - loss * AMBIENT_GLOOM_LOSS_SHARE),
    backgroundColor: mixHex(state.backgroundColor, GLOOM_COLOR, clamped),
  };
}
