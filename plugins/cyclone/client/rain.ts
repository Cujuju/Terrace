import { Group } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import {
  createPrecipitationField,
  PRECIPITATION_FIELD_DRAW_OBJECTS,
  type PrecipitationField,
} from '../../../client/src/plugins/kit/precipitationField.ts';
import { DISC_RENDER_ORDER } from '../../../client/src/plugins/kit/discRig.ts';
import { CYCLONE_EYE_RADIUS_FRACTION, CYCLONE_PLUGIN_NAME } from '../protocol.ts';
import { CYCLONE_NOMINAL_RADIUS_WORLD_UNITS, MAX_SPIRALS } from './spiralLayout.ts';

export const CYCLONE_RAIN_DROPS_PER_WORLD_AREA = 1;

export const CYCLONE_RAIN_ANNULUS_WORLD_AREA =
  Math.PI *
  CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
  CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
  (1 - CYCLONE_EYE_RADIUS_FRACTION * CYCLONE_EYE_RADIUS_FRACTION);

export const CYCLONE_DROP_COUNT = Math.round(
  CYCLONE_RAIN_DROPS_PER_WORLD_AREA * CYCLONE_RAIN_ANNULUS_WORLD_AREA,
);

export const CYCLONE_RAIN_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: CYCLONE_DROP_COUNT,
  fallSpeed: 34,
  streakLength: 1.3,
  spriteSize: 0,
  opacity: 0.5,
  color: 0x8ea3b8,
  swayWorldUnits: 0,
  swayHz: 0,
  innerRadiusFraction: CYCLONE_EYE_RADIUS_FRACTION,
};

export const CYCLONE_RAIN_DRAW_OBJECTS = PRECIPITATION_FIELD_DRAW_OBJECTS;

export interface CycloneRainSource {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly radiusWorldUnits: number;
  readonly intensity: number;
  readonly vx: number;
  readonly vz: number;
}

export interface CycloneRainField {
  readonly root: Group;
  apply(live: readonly CycloneRainSource[], elapsed: number): void;
  reset(): void;
  dispose(): void;
}

export function createCycloneRainField(
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): CycloneRainField {
  const root = new Group();
  root.name = `${CYCLONE_PLUGIN_NAME}:rain`;

  const field: PrecipitationField = createPrecipitationField(CYCLONE_RAIN_PROFILE, {
    maxMasses: MAX_SPIRALS,
    name: `${CYCLONE_PLUGIN_NAME}:rain`,
    renderOrder: DISC_RENDER_ORDER,
    applyRevealClip,
  });
  root.add(field.object);

  const slotOf = new Map<number, number>();
  const freeSlots: number[] = [];

  return {
    root,

    apply(live, elapsed): void {
      for (const [id, slot] of slotOf) {
        if (live.some((storm) => storm.id === id)) continue;
        field.park(slot);
        slotOf.delete(id);
        freeSlots.push(slot);
      }

      for (const storm of live) {
        let slot = slotOf.get(storm.id);
        if (slot === undefined) {
          if (storm.intensity <= 0) continue;
          slot = freeSlots.pop() ?? field.claimSlot();
          if (slot < 0) continue;
          slotOf.set(storm.id, slot);
        }
        field.updateWorld(
          slot,
          storm.x,
          storm.z,
          storm.radiusWorldUnits,
          storm.intensity,
          storm.vx,
          storm.vz,
          elapsed,
        );
      }
    },

    reset(): void {
      for (const slot of slotOf.values()) {
        field.park(slot);
        freeSlots.push(slot);
      }
      slotOf.clear();
    },

    dispose(): void {
      field.dispose();
      slotOf.clear();
      freeSlots.length = 0;
      root.clear();
    },
  };
}
