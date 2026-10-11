import type { Object3D } from 'three';
import { PointLight } from 'three';

export const PARKED_LIGHT_INTENSITY = 0;

export interface LightBankSpec {
  readonly size: number;
  readonly color: number;
  readonly range: number;
  readonly decay?: number;
  readonly name: string;
  readonly parent: Object3D;
}

export interface LightBank {
  readonly lights: readonly PointLight[];
  lend(): PointLight | null;
  give(light: PointLight): void;
  dispose(): void;
}

// three keys every lit pipeline on the visible-light set, so adding, removing or hiding
// one rebuilds the whole scene. A fixed bank, parented once, never hidden, parked at zero.
export function createLightBank(spec: LightBankSpec): LightBank {
  const lights: PointLight[] = [];
  const free: PointLight[] = [];

  for (let index = 0; index < spec.size; index++) {
    const light = new PointLight(spec.color, PARKED_LIGHT_INTENSITY, spec.range);
    if (spec.decay !== undefined) light.decay = spec.decay;
    light.name = `${spec.name}:${index}`;
    spec.parent.add(light);
    lights.push(light);
    free.push(light);
  }

  return {
    lights,

    lend(): PointLight | null {
      const light = free.pop();
      if (light === undefined) return null;
      light.intensity = PARKED_LIGHT_INTENSITY;
      return light;
    },

    give(light: PointLight): void {
      if (!lights.includes(light) || free.includes(light)) return;
      light.intensity = PARKED_LIGHT_INTENSITY;
      free.push(light);
    },

    dispose(): void {
      for (const light of lights) {
        light.intensity = PARKED_LIGHT_INTENSITY;
        light.removeFromParent();
        light.dispose();
      }
      lights.length = 0;
      free.length = 0;
    },
  };
}
