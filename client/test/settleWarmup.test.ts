import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PointLight, Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { warmHiddenDrawables } from '../src/render/settleWarmup.ts';

interface Seen {
  readonly layer: boolean;
  readonly mesh: boolean;
  readonly meshCulled: boolean;
  readonly light: boolean;
}

function rig(layerVisible: boolean) {
  const scene = new Scene();
  const layer = new Group();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const light = new PointLight();
  layer.add(mesh, light);
  layer.visible = layerVisible;
  scene.add(layer);
  const seen: Seen[] = [];
  const renderer = {
    initialized: true,
    compileAsync: (): Promise<void> => {
      seen.push({
        layer: layer.visible,
        mesh: mesh.visible,
        meshCulled: mesh.frustumCulled,
        light: light.visible,
      });
      return Promise.resolve();
    },
  } as unknown as WebGPURenderer;
  return { scope: { scene, camera: new PerspectiveCamera(), renderer }, layer, mesh, seen };
}

describe('settle warmup', () => {
  it('leaves out a hidden subtree with lights: they would key pipelines the frame never asks for', async () => {
    const r = rig(false);
    await warmHiddenDrawables(r.scope, 'forbidden');
    expect(r.seen).toEqual([]);
  });

  it('has nothing to warm when every drawable is visible and drawn', async () => {
    const r = rig(true);
    await warmHiddenDrawables(r.scope, 'forbidden');
    expect(r.seen).toEqual([]);
  });

  it('warms a visible subtree three has not drawn, lights and visibility untouched, culling restored', async () => {
    const r = rig(true);
    await warmHiddenDrawables(r.scope, 'forbidden', new Set([r.layer]));
    expect(r.seen).toEqual([{ layer: true, mesh: true, meshCulled: false, light: true }]);
    expect(r.mesh.frustumCulled).toBe(true);
  });
});
