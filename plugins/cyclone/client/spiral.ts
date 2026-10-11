import { Group } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { createMassSlots } from '../../../client/src/plugins/kit/discSlots.ts';
import type { GroundSampler } from '../../../client/src/plugins/kit/groundFollow.ts';
import { createSpiralMesh } from './spiralLook.ts';
import { createColumnGround } from './spiralGround.ts';
import { MAX_SPIRALS } from './spiralLayout.ts';

export const SPIRAL_DRAW_OBJECTS = 1;

export const SPIRAL_DISPERSE_SECONDS = 30;

// The slot ledger has no velocity to carry: the spiral's puffs do not drift.
const SPIRAL_DRIFT = 0;

interface Spiral {
  x: number;
  z: number;
  radiusWorldUnits: number;
  readonly slot: number;
  alive: boolean;
  presence: number;
  intensity: number;
}

export interface SpiralSource {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly radiusCells: number;
  readonly intensity: number;
}

export interface SpiralRenderer {
  readonly root: Group;
  apply(live: readonly SpiralSource[]): void;
  update(dt: number, elapsed: number): void;
  orderAgainstCamera(cameraWorldY: number): void;
  reset(): void;
  dispose(): void;
}

export function createSpiral(
  applyRevealClip: (material: NodeMaterial, label: string) => void,
  groundAt: GroundSampler,
): SpiralRenderer {
  const root = new Group();
  root.name = 'cyclone:spiral';

  const slots = createMassSlots(MAX_SPIRALS);
  const ground = createColumnGround();
  const puffs = createSpiralMesh(slots.massXZ, slots.massSize, ground.lanes, applyRevealClip);
  root.add(puffs.mesh);

  const spirals = new Map<number, Spiral>();
  const freeSlots: number[] = [];

  function claim(): number {
    return freeSlots.pop() ?? slots.claim();
  }

  return {
    root,

    apply(live): void {
      for (const spiral of spirals.values()) spiral.alive = false;

      for (const storm of live) {
        const radiusWorldUnits = storm.radiusCells * CELL_WORLD_SIZE;
        const existing = spirals.get(storm.id);
        if (existing !== undefined) {
          existing.alive = true;
          existing.x = storm.x;
          existing.z = storm.z;
          existing.radiusWorldUnits = radiusWorldUnits;
          existing.intensity = storm.intensity;
          continue;
        }
        const slot = claim();
        if (slot < 0) continue;
        spirals.set(storm.id, {
          x: storm.x,
          z: storm.z,
          radiusWorldUnits,
          slot,
          alive: true,
          presence: 1,
          intensity: storm.intensity,
        });
      }
    },

    update(dt, elapsed): void {
      const spinTurns = puffs.advance(elapsed);

      let lit = false;
      for (const [id, spiral] of spirals) {
        if (spiral.alive) {
          spiral.presence = 1;
        } else {
          spiral.presence -= dt / SPIRAL_DISPERSE_SECONDS;
          if (spiral.presence <= 0) {
            lit = slots.park(spiral.slot);
            freeSlots.push(spiral.slot);
            spirals.delete(id);
            continue;
          }
        }
        lit = slots.updateWorld(
          spiral.slot,
          spiral.x,
          spiral.z,
          spiral.radiusWorldUnits,
          spiral.presence * spiral.intensity,
          SPIRAL_DRIFT,
          SPIRAL_DRIFT,
        );
        ground.stand(spiral.slot, spiral.x, spiral.z, spiral.radiusWorldUnits, spinTurns, groundAt);
      }

      puffs.mesh.visible = lit;
    },

    orderAgainstCamera(cameraWorldY): void {
      puffs.orderAgainstCamera(cameraWorldY);
    },

    reset(): void {
      spirals.clear();
      freeSlots.length = 0;
      slots.reset();
      puffs.mesh.visible = false;
    },

    dispose(): void {
      puffs.dispose();
      root.clear();
      spirals.clear();
      freeSlots.length = 0;
      slots.reset();
    },
  };
}
