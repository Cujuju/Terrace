import { Group } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import {
  createPrecipitationColumn,
  type PrecipitationColumn,
  type PrecipitationProfile,
} from '../../../client/src/plugins/kit/precipitation.ts';
import { DISC_RENDER_ORDER } from '../../../client/src/plugins/kit/discRig.ts';
import { CYCLONE_EYE_RADIUS_FRACTION, CYCLONE_PLUGIN_NAME } from '../protocol.ts';
import { CYCLONE_NOMINAL_RADIUS_WORLD_UNITS, MAX_SPIRALS } from './spiral.ts';

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
  swayCells: 0,
  swayHz: 0,
  innerRadiusFraction: CYCLONE_EYE_RADIUS_FRACTION,
};

export const CYCLONE_RAIN_DRAW_OBJECTS = 1;

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
  dispose(): void;
}

interface RainRig {
  readonly root: Group;
  readonly column: PrecipitationColumn;
}

export function createCycloneRainField(
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): CycloneRainField {
  const root = new Group();
  root.name = `${CYCLONE_PLUGIN_NAME}:rain`;

  const rigs = new Map<number, RainRig>();
  const free: RainRig[] = [];
  const built: RainRig[] = [];

  function acquire(): RainRig {
    const reused = free.pop();
    if (reused !== undefined) return reused;
    const rig: RainRig = {
      root: new Group(),
      column: createPrecipitationColumn(CYCLONE_RAIN_PROFILE, DISC_RENDER_ORDER),
    };
    rig.root.name = `${CYCLONE_PLUGIN_NAME}:rain:column`;
    rig.root.add(rig.column.object);
    applyRevealClip(rig.column.material, `${CYCLONE_PLUGIN_NAME} rain`);
    built.push(rig);
    return rig;
  }

  return {
    root,

    apply(live, elapsed): void {
      for (const [id, rig] of rigs) {
        if (live.some((storm) => storm.id === id)) continue;
        root.remove(rig.root);
        rigs.delete(id);
        free.push(rig);
      }

      for (const storm of live) {
        const lit = storm.intensity > 0;
        let rig = rigs.get(storm.id);
        if (rig === undefined) {
          if (!lit) continue;
          if (rigs.size >= MAX_SPIRALS) continue;
          rig = acquire();
          rigs.set(storm.id, rig);
          root.add(rig.root);
        }
        rig.root.visible = lit;
        if (!lit) continue;

        rig.root.position.set(storm.x, 0, storm.z);
        rig.column.material.opacity = CYCLONE_RAIN_PROFILE.opacity * storm.intensity;
        rig.column.advance(elapsed, storm.radiusWorldUnits, storm.vx, storm.vz);
      }
    },

    dispose(): void {
      for (const rig of built) rig.column.dispose();
      built.length = 0;
      free.length = 0;
      rigs.clear();
      root.clear();
    },
  };
}
