import { Color } from 'three';
import type { SkyRigState } from '../plugins/types.ts';
import { SUN_DISTANCE_WORLD_UNITS, type Viewport } from './scene.ts';
import { backgroundRadiance } from './skyEnvironment.ts';

export type { SkyRigState };

export function skyRigEquals(a: SkyRigState, b: SkyRigState): boolean {
  return (
    a.sunDirection.x === b.sunDirection.x &&
    a.sunDirection.y === b.sunDirection.y &&
    a.sunDirection.z === b.sunDirection.z &&
    a.sunColor === b.sunColor &&
    a.sunIntensity === b.sunIntensity &&
    a.hemisphereSkyColor === b.hemisphereSkyColor &&
    a.hemisphereGroundColor === b.hemisphereGroundColor &&
    a.hemisphereIntensity === b.hemisphereIntensity &&
    a.ambientColor === b.ambientColor &&
    a.ambientIntensity === b.ambientIntensity &&
    a.backgroundColor === b.backgroundColor
  );
}

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
  if (background instanceof Color) {
    background.copy(backgroundRadiance(state.backgroundColor, viewport.renderer));
  }

  viewport.skyEnvironment.retint(state);
}
