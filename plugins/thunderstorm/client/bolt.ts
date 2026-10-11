import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
} from 'three';
import { MeshBasicNodeMaterial, type NodeMaterial } from 'three/webgpu';
import { DISC_RENDER_ORDER } from '../../../client/src/plugins/kit/discRig.ts';
import { THUNDERSTORM_PLUGIN_NAME } from '../protocol.ts';
import type { FlashLight } from './flashLight.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  BOLT_JAG_WORLD_UNITS,
  BOLT_TIP_WIDTH_FRACTION,
  BOLT_TOP_WORLD_Y,
  BOLT_WIDTH_WORLD_UNITS,
  FLASH_COLOR,
  LightningSchedule,
  type LightningGovernor,
} from './lightning.ts';

const BOLT_SEGMENTS = 9;
const BOLT_JAG_TURN_RADIANS = 2.4;

export const DRY_BOLT_DRAW_OBJECTS = 1;

export function buildBoltGeometry(): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const span = BOLT_TOP_WORLD_Y - BOLT_BOTTOM_WORLD_Y;

  function ribbon(sideways: 'x' | 'z'): void {
    const first = positions.length / 3;
    for (let step = 0; step <= BOLT_SEGMENTS; step++) {
      const along = step / BOLT_SEGMENTS;
      const y = BOLT_TOP_WORLD_Y - along * span;
      const jag = BOLT_JAG_WORLD_UNITS * Math.sin(step * BOLT_JAG_TURN_RADIANS);
      const halfWidth =
        (BOLT_WIDTH_WORLD_UNITS * (1 - (1 - BOLT_TIP_WIDTH_FRACTION) * along)) / 2;
      for (const edge of [-1, 1]) {
        const offset = jag + edge * halfWidth;
        positions.push(sideways === 'x' ? offset : 0, y, sideways === 'z' ? offset : 0);
      }
    }
    for (let step = 0; step < BOLT_SEGMENTS; step++) {
      const corner = first + step * 2;
      indices.push(corner, corner + 1, corner + 3);
      indices.push(corner, corner + 3, corner + 2);
    }
  }

  ribbon('x');
  ribbon('z');

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

export interface DryBoltRig {
  readonly root: Group;
  strike(worldX: number, worldZ: number, governor: LightningGovernor): boolean;
  update(dt: number, reduced: boolean): void;
  dispose(): void;
}

export function createDryBoltRig(
  boltGeometry: BufferGeometry,
  applyRevealClip: (material: NodeMaterial, label: string) => void,
  flash: FlashLight,
): DryBoltRig {
  const root = new Group();
  root.name = `${THUNDERSTORM_PLUGIN_NAME}:dry-bolt`;

  const material = new MeshBasicNodeMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  applyRevealClip(material, `${THUNDERSTORM_PLUGIN_NAME} dry bolt`);

  const bolt = new Mesh(boltGeometry, material);
  bolt.visible = false;
  bolt.renderOrder = DISC_RENDER_ORDER;

  const pivot = new Group();
  pivot.add(bolt);
  root.add(pivot);

  const schedule = new LightningSchedule();
  let wasFlashing = false;
  let strikeX = 0;
  let strikeZ = 0;

  return {
    root,

    strike(worldX: number, worldZ: number, governor: LightningGovernor): boolean {
      if (!schedule.strike(governor)) return false;
      pivot.position.set(worldX, 0, worldZ);
      pivot.rotation.y = Math.atan2(worldZ, worldX);
      strikeX = worldX;
      strikeZ = worldZ;
      return true;
    },

    update(dt: number, reduced: boolean): void {
      schedule.advance(dt);
      const brightness = reduced ? 0 : schedule.brightness();
      const flashing = brightness > 0;
      bolt.visible = flashing;
      if (flashing) {
        material.opacity = brightness;
        flash.flash(strikeX, BOLT_BOTTOM_WORLD_Y, strikeZ, brightness);
      } else if (wasFlashing) {
        flash.park();
      }
      wasFlashing = flashing;
    },

    dispose(): void {
      root.clear();
      material.dispose();
    },
  };
}
