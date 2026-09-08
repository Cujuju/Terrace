import type { SkyRigState } from '../../../client/src/plugins/types.ts';
import { CYCLONE_EYE_RADIUS_FRACTION } from '../protocol.ts';

export const MAX_GLOOM_LIGHT_LOSS = 0.6;

export const GLOOM_COLOR = 0x3a4048;

export const GLOOM_RESPONSE_PER_SECOND = 0.35;

export function overheadFraction(distanceCells: number, radiusCells: number): number {
  if (!(radiusCells > 0)) return 0;
  const r = distanceCells / radiusCells;
  if (r >= 1) return 0;

  const eye = CYCLONE_EYE_RADIUS_FRACTION;
  const eyewallSoftness = 0.06;
  if (r <= eye) return 0;

  const overEyewall = Math.min(1, (r - eye) / eyewallSoftness);
  const towardRim = (r - eye) / (1 - eye);
  return overEyewall * (1 - towardRim * towardRim);
}

function mixHex(from: number, to: number, t: number): number {
  const mixChannel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * t) & 0xff;
  };
  return (mixChannel(16) << 16) | (mixChannel(8) << 8) | mixChannel(0);
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
    hemisphereIntensity: state.hemisphereIntensity * (1 - loss * (2 / 3)),
    ambientColor: mixHex(state.ambientColor, GLOOM_COLOR, clamped),
    ambientIntensity: state.ambientIntensity * (1 - loss / 3),
    backgroundColor: mixHex(state.backgroundColor, GLOOM_COLOR, clamped),
  };
}
