import { Group, type Vector4 } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { createVortexMesh } from './vortexMesh.ts';
import { createDebrisMesh } from './debrisMesh.ts';
import { createStormSlots, MAX_FUNNELS } from './funnelSlots.ts';

export const FUNNEL_DISPERSE_SECONDS = 5;

interface Funnel {
  x: number;
  groundY: number;
  z: number;
  readonly slot: number;
  alive: boolean;
  presence: number;
  intensity: number;
}

export interface FunnelSource {
  readonly id: number;
  readonly x: number;
  readonly groundY: number;
  readonly z: number;
  readonly intensity: number;
}

export interface FunnelRenderer {
  readonly root: Group;
  // The per-slot uniform both shaders read: (x, groundY, z, strength).
  readonly stand: readonly Vector4[];
  apply(live: readonly FunnelSource[]): void;
  update(dt: number, elapsed: number): void;
  clear(): void;
  dispose(): void;
}

export function createFunnel(
  applyRevealClip: (material: NodeMaterial, label: string) => void,
): FunnelRenderer {
  const root = new Group();
  root.name = 'tornado:funnel';

  const slots = createStormSlots(MAX_FUNNELS);
  const vortex = createVortexMesh(slots.stand, applyRevealClip);
  const debris = createDebrisMesh(slots.stand, applyRevealClip);
  root.add(vortex.mesh, debris.mesh);

  const funnels = new Map<number, Funnel>();

  function show(visible: boolean): void {
    vortex.mesh.visible = visible;
    debris.mesh.visible = visible;
  }

  return {
    root,
    stand: slots.stand,

    apply(live): void {
      for (const funnel of funnels.values()) funnel.alive = false;

      for (const storm of live) {
        const existing = funnels.get(storm.id);
        if (existing !== undefined) {
          existing.alive = true;
          existing.x = storm.x;
          existing.groundY = storm.groundY;
          existing.z = storm.z;
          existing.intensity = storm.intensity;
          continue;
        }
        const slot = slots.claim();
        if (slot < 0) continue;
        funnels.set(storm.id, {
          x: storm.x,
          groundY: storm.groundY,
          z: storm.z,
          slot,
          alive: true,
          presence: 1,
          intensity: storm.intensity,
        });
      }
    },

    update(dt, elapsed): void {
      vortex.advance(elapsed);
      debris.advance(elapsed);

      for (const [id, funnel] of funnels) {
        if (funnel.alive) {
          funnel.presence = 1;
        } else {
          funnel.presence -= dt / FUNNEL_DISPERSE_SECONDS;
          if (funnel.presence <= 0) {
            slots.release(funnel.slot);
            funnels.delete(id);
            continue;
          }
        }
        slots.place(
          funnel.slot,
          funnel.x,
          funnel.groundY,
          funnel.z,
          funnel.presence * funnel.intensity,
        );
      }

      show(slots.lit());
    },

    clear(): void {
      funnels.clear();
      slots.reset();
      show(false);
    },

    dispose(): void {
      vortex.dispose();
      debris.dispose();
      root.clear();
      funnels.clear();
      slots.reset();
    },
  };
}
