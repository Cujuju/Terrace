import { PointLight } from 'three';
import { THUNDERSTORM_PLUGIN_NAME } from '../protocol.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  FLASH_COLOR,
  FLASH_LIGHT_PEAK_INTENSITY,
  FLASH_LIGHT_RANGE_CELLS,
} from './lightning.ts';

export const FLASH_LIGHT_DRAW_OBJECTS = 0;

export interface FlashLight {
  readonly light: PointLight;
  flash(x: number, y: number, z: number, brightness: number): void;
  park(): void;
  dispose(): void;
}

// The lit set must never change: three keys every lit object's pipeline on the
// visible lights. One light, always visible; intensity 0 gates the BRDF.
export function createFlashLight(): FlashLight {
  const light = new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS);
  light.name = `${THUNDERSTORM_PLUGIN_NAME}:flash-light`;
  light.position.y = BOLT_BOTTOM_WORLD_Y;
  light.visible = true;

  return {
    light,

    flash(x: number, y: number, z: number, brightness: number): void {
      light.position.set(x, y, z);
      light.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
    },

    park(): void {
      light.intensity = 0;
    },

    dispose(): void {
      light.intensity = 0;
      light.removeFromParent();
      light.dispose();
    },
  };
}
