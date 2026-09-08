import { Color } from 'three';
import type { SkyRigState } from '../plugins/types.ts';
import { SUN_DISTANCE_WORLD_UNITS, type Viewport } from './scene.ts';

export type { SkyRigState };

export function applySkyRig(viewport: Viewport, state: SkyRigState): void {
  const { sun, hemisphere, ambient } = viewport.lighting;

  sun.position
    .set(state.sunDirection.x, state.sunDirection.y, state.sunDirection.z)
    .normalize()
    .multiplyScalar(SUN_DISTANCE_WORLD_UNITS);
  sun.color.setHex(state.sunColor);
  sun.intensity = state.sunIntensity;

  hemisphere.color.setHex(state.hemisphereSkyColor);
  hemisphere.groundColor.setHex(state.hemisphereGroundColor);
  hemisphere.intensity = state.hemisphereIntensity;

  ambient.color.setHex(state.ambientColor);
  ambient.intensity = state.ambientIntensity;

  const background = viewport.scene.background;
  if (background instanceof Color) background.setHex(state.backgroundColor);

  viewport.skyEnvironment.retint(state);
}
