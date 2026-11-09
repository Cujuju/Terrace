import { expect, it } from 'vitest';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry } from 'three';
import { createClientPluginHost } from '../src/plugins/host.ts';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import type { Viewport } from '../src/render/scene.ts';
import type { World } from '../src/world.ts';
import type { Connection } from '../src/net/connection.ts';

it('resolves a child mesh hit to its registered owning anchor before coordinate fallback', () => {
  const camera = new PerspectiveCamera(60, 4 / 3, 0.1, 100);
  camera.position.set(3, 10, 3);
  camera.lookAt(3, 0, 3);
  camera.updateMatrixWorld(true);
  const viewport = {
    camera, scene: new Scene(), onFrame: () => () => {},
    renderer: { domElement: { addEventListener: () => {}, removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
      info: { render: { calls: 0 } } },
  } as unknown as Viewport;
  const world = { terrainBuildHeld: () => false, worldSize: () => 64,
    pickPointedCell: () => null } as unknown as World;
  let ctx!: ClientPluginCtx;
  const host = createClientPluginHost([{ name: 'anchors', drawBudget: 1, attach: (context) => { ctx = context; } }], {
    viewport, world, connection: () => ({}) as Connection, coreDrawBudget: () => 0,
  });
  const geometry = new SphereGeometry(1);
  const material = new MeshBasicMaterial();
  const root = new Group();
  const mesh = new Mesh(geometry, material);
  mesh.position.set(3, 2, 3);
  root.add(mesh);
  root.updateMatrixWorld(true);
  try {
    const release = ctx.markPickable(root, undefined, (hit) => {
      expect(hit.object).toBe(mesh);
      return { x: 20, y: 21 };
    });
    expect(ctx.pickWorldCell(400, 300)).toEqual({ x: 20, y: 21 });
    camera.position.x += 10;
    expect(ctx.pickWorldCell(400, 300)).toBeNull();
    camera.position.x -= 10;
    release();
    ctx.markPickable(root, undefined, () => null);
    expect(ctx.pickWorldCell(400, 300)).toBeNull();
  } finally { host.dispose(); geometry.dispose(); material.dispose(); }
});
