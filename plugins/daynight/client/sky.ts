import type { SkyRigState } from '../../../client/src/plugins/types.ts';

const TWO_PI = Math.PI * 2;

const NOON_SUN_DIRECTION = { x: 0.7, y: 0.45, z: 0.55 };
const NOON_SUN_INTENSITY = 1.2;
const NOON_HEMISPHERE_INTENSITY = 1.5;
const NOON_AMBIENT_INTENSITY = 0.9;
const NOON_SKY_COLOR = 0x9fc7e8;
const NOON_GROUND_COLOR = 0x9a948a;
const NOON_LIGHT_COLOR = 0xffffff;

const NOON_ELEVATION_ANGLE_RADIANS = Math.asin(
  NOON_SUN_DIRECTION.y / Math.hypot(NOON_SUN_DIRECTION.x, NOON_SUN_DIRECTION.y, NOON_SUN_DIRECTION.z),
);

const horizontalMagnitude = Math.hypot(NOON_SUN_DIRECTION.x, NOON_SUN_DIRECTION.z);
const SUN_BEARING = {
  x: NOON_SUN_DIRECTION.x / horizontalMagnitude,
  z: NOON_SUN_DIRECTION.z / horizontalMagnitude,
};

const HORIZON_SUN_COLOR = 0xffa864;
const HORIZON_SUN_INTENSITY = NOON_SUN_INTENSITY / 3;
const HORIZON_SKY_COLOR = 0xdb8f66;
const HORIZON_GROUND_COLOR = 0x8a6a52;
const HORIZON_HEMISPHERE_INTENSITY = 1;
const HORIZON_AMBIENT_COLOR = 0xffd9ad;
const HORIZON_AMBIENT_INTENSITY = 0.6;

const NIGHT_SUN_COLOR = 0x3a5a8f;
const NIGHT_SUN_INTENSITY = 0;
const NIGHT_SKY_COLOR = 0x141c30;
const NIGHT_GROUND_COLOR = 0x1c2230;
const NIGHT_AMBIENT_COLOR = 0x8fa6c9;

const NIGHT_DIM_FACTOR = 1 / 3;

export const NIGHT_FLOOR_INTENSITY = NOON_AMBIENT_INTENSITY * NIGHT_DIM_FACTOR;
const NIGHT_HEMISPHERE_INTENSITY = NOON_HEMISPHERE_INTENSITY * NIGHT_DIM_FACTOR;

export function sunHeight(phase: number): number {
  return Math.sin(phase * TWO_PI);
}

function sunDirectionAt(phase: number): SkyRigState['sunDirection'] {
  const elevationAngle = sunHeight(phase) * NOON_ELEVATION_ANGLE_RADIANS;
  return {
    x: SUN_BEARING.x * Math.cos(elevationAngle),
    y: Math.sin(elevationAngle),
    z: SUN_BEARING.z * Math.cos(elevationAngle),
  };
}

function lerpColor(from: number, to: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const channel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * clamped);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, t));
}

export function skyStateAtPhase(phase: number): SkyRigState {
  const height = sunHeight(phase);
  const t = Math.abs(height);
  const towardNoon = height >= 0;

  return {
    sunDirection: sunDirectionAt(phase),
    sunColor: lerpColor(HORIZON_SUN_COLOR, towardNoon ? NOON_LIGHT_COLOR : NIGHT_SUN_COLOR, t),
    sunIntensity: lerp(HORIZON_SUN_INTENSITY, towardNoon ? NOON_SUN_INTENSITY : NIGHT_SUN_INTENSITY, t),
    hemisphereSkyColor: lerpColor(HORIZON_SKY_COLOR, towardNoon ? NOON_SKY_COLOR : NIGHT_SKY_COLOR, t),
    hemisphereGroundColor: lerpColor(
      HORIZON_GROUND_COLOR,
      towardNoon ? NOON_GROUND_COLOR : NIGHT_GROUND_COLOR,
      t,
    ),
    hemisphereIntensity: lerp(
      HORIZON_HEMISPHERE_INTENSITY,
      towardNoon ? NOON_HEMISPHERE_INTENSITY : NIGHT_HEMISPHERE_INTENSITY,
      t,
    ),
    ambientColor: lerpColor(HORIZON_AMBIENT_COLOR, towardNoon ? NOON_LIGHT_COLOR : NIGHT_AMBIENT_COLOR, t),
    ambientIntensity: lerp(
      HORIZON_AMBIENT_INTENSITY,
      towardNoon ? NOON_AMBIENT_INTENSITY : NIGHT_FLOOR_INTENSITY,
      t,
    ),
    backgroundColor: lerpColor(HORIZON_SKY_COLOR, towardNoon ? NOON_SKY_COLOR : NIGHT_SKY_COLOR, t),
  };
}
