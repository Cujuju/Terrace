import { describe, expect, it } from 'vitest';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PointLight, Scene, BoxGeometry } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { warmHiddenDrawables } from '../src/render/settleWarmup.ts';

interface Seen {
  readonly layer: boolean;
  readonly mesh: boolean;
  readonly light: boolean;
  readonly hiddenLight: boolean;
}

function rig() {
  const scene = new Scene();
  const layer = new Group();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const light = new PointLight();
  const hiddenLight = new PointLight();
  hiddenLight.visible = false;
  layer.add(mesh, light, hiddenLight);
  layer.visible = false;
  scene.add(layer);
  const seen: Seen[] = [];
  const renderer = {
    initialized: true,
    compileAsync: (): Promise<void> => {
      seen.push({
        layer: layer.visible,
        mesh: mesh.visible,
        light: light.visible,
        hiddenLight: hiddenLight.visible,
      });
      return Promise.resolve();
    },
  } as unknown as WebGPURenderer;
  return { scope: { scene, camera: new PerspectiveCamera(), renderer }, layer, seen };
}

describe('settle warmup of a hidden subtree with lights', () => {
  it('leaves it out by default: its lights would key pipelines the frame never asks for', async () => {
    const r = rig();
    await warmHiddenDrawables(r.scope, 'forbidden');
    expect(r.seen).toEqual([]);
  });

  it('warms it, lights shown, when it is about to be shown; a light hidden inside stays out', async () => {
    const r = rig();
    await warmHiddenDrawables(r.scope, 'forbidden', new Set([r.layer]));
    expect(r.seen).toEqual([{ layer: true, mesh: true, light: true, hiddenLight: false }]);
    expect(r.layer.visible).toBe(false);
  });
});
