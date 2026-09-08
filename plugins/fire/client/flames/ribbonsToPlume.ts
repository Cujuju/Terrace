import { Group } from 'three';
import { buildRibbonFlames } from './ribbons.ts';
import { buildShaderPlumeFlames } from './shaderPlume.ts';
import type { FireInstance, FlameRenderer, FlameRendererBuilder } from './types.ts';

export const PLUME_TAKEOVER_START_INTENSITY = 0.55;
export const PLUME_TAKEOVER_END_INTENSITY = 0.85;

const MINIMUM_VISIBLE_PRESENCE = 0.01;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function plumeShareOf(intensity: number): number {
  return smoothstep(PLUME_TAKEOVER_START_INTENSITY, PLUME_TAKEOVER_END_INTENSITY, intensity);
}

function presenceForShare(share: number): number {
  return Math.sqrt(share);
}

type MutableFireInstance = { -readonly [K in keyof FireInstance]: FireInstance[K] };

function ensurePool(pool: MutableFireInstance[], size: number): void {
  while (pool.length < size) {
    pool.push({ key: 0, x: 0, z: 0, groundY: 0, fuelHeight: 0, intensity: 0, ageSeconds: 0, presence: 1, seed: 0 });
  }
}

function writeSlot(slot: MutableFireInstance, fire: FireInstance, presence: number): void {
  slot.key = fire.key;
  slot.x = fire.x;
  slot.z = fire.z;
  slot.groundY = fire.groundY;
  slot.fuelHeight = fire.fuelHeight;
  slot.intensity = fire.intensity;
  slot.ageSeconds = fire.ageSeconds;
  slot.seed = fire.seed;
  slot.presence = presence;
}

export const buildRibbonsToPlumeFlames: FlameRendererBuilder = () => {
  const plume = buildShaderPlumeFlames();
  const ribbons = buildRibbonFlames();

  const root = new Group();
  root.name = 'fire:flames';
  root.add(ribbons.root);
  root.add(plume.root);

  const plumePool: MutableFireInstance[] = [];
  const ribbonPool: MutableFireInstance[] = [];
  const plumeList: FireInstance[] = [];
  const ribbonList: FireInstance[] = [];

  return {
    name: 'ribbons → plume',
    root,

    get drawnCount(): number {
      return plume.drawnCount + ribbons.drawnCount;
    },

    apply(fires: readonly FireInstance[]): void {
      ensurePool(plumePool, fires.length);
      ensurePool(ribbonPool, fires.length);
      plumeList.length = 0;
      ribbonList.length = 0;

      for (const fire of fires) {
        const plumeShare = plumeShareOf(fire.intensity);
        const plumePresence = presenceForShare(plumeShare);
        const ribbonPresence = presenceForShare(1 - plumeShare);

        if (plumePresence >= MINIMUM_VISIBLE_PRESENCE) {
          const slot = plumePool[plumeList.length]!;
          writeSlot(slot, fire, plumePresence);
          plumeList.push(slot);
        }
        if (ribbonPresence >= MINIMUM_VISIBLE_PRESENCE) {
          const slot = ribbonPool[ribbonList.length]!;
          writeSlot(slot, fire, ribbonPresence);
          ribbonList.push(slot);
        }
      }

      plume.apply(plumeList);
      ribbons.apply(ribbonList);
    },

    update(dt: number, elapsed: number): void {
      plume.update(dt, elapsed);
      ribbons.update(dt, elapsed);
    },

    dispose(): void {
      plume.dispose();
      ribbons.dispose();
      root.clear();
      plumePool.length = 0;
      ribbonPool.length = 0;
      plumeList.length = 0;
      ribbonList.length = 0;
    },
  };
};
