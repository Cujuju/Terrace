import '../../plugins/structures/test/support/headlessCanvas.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, Group, Mesh, MeshLambertMaterial, Raycaster, Vector3,
  type Intersection, type Object3D } from 'three';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clientPlugin } from '../../plugins/structures/client/index.ts';
import { installSkiffKit } from '../../plugins/structures/client/skiffModels.ts';
import { buildingKindOf, tierOfKind } from '../../plugins/structures/settlementRules.ts';

function attach() {
  const geometry = new BoxGeometry(0.36, 0.03, 0.14);
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(
    geometry.getAttribute('position').count * 3).fill(1), 3));
  const material = new MeshLambertMaterial({ vertexColors: true });
  const scene = new Group();
  scene.add(new Mesh(geometry, material));
  installSkiffKit({ scene, node: () => scene,
    anchor: (name) => new Vector3(0, name === 'dryline' ? 0.02 : 0, 0),
    dispose: () => { geometry.dispose(); material.dispose(); } });

  const layer = new Group();
  const messages = new Map<string, (payload: unknown) => void>();
  const picks = new Map<Object3D, (hit: Intersection) => { x: number; y: number } | null>();
  const hooks = { terrain: (_dirty: ReadonlySet<number>): void => {} };
  let revision = 0;
  let dry = false;
  let reads = 0;
  const ctx: Partial<ClientPluginCtx> = {
    signal: new AbortController().signal,
    layer,
    terrainRevisionAt: () => revision,
    drawnGroundYAt: (x) => { reads++; return dry || x < 103 ? 4 : -1; },
    onMessage: (type, handler) => { messages.set(type, handler); return () => { messages.delete(type); }; },
    onTerrainChanged: (handler) => { hooks.terrain = handler; return () => {}; },
    onWorldReset: () => () => {}, onFrame: () => () => {}, requestShaderWarmup: () => {},
    markPickable: (object, _occupancy, resolveHit) => {
      picks.set(object, resolveHit!);
      return () => { picks.delete(object); };
    },
  };
  clientPlugin.attach(ctx as ClientPluginCtx);
  return { layer, picks,
    receive(id: string, x: number, y: number) {
      const kind = buildingKindOf(id)!;
      messages.get('all')!({ structures: [x, y, tierOfKind(kind), kind] });
    },
    dryCoast() { reads = 0; dry = true; revision++; hooks.terrain(new Set()); return reads; },
  };
}

describe('structure client lifecycle', () => {
  afterEach(() => clientPlugin.dispose!());

  it('re-surveys resolved coastal placements when their terrain changes', () => {
    const client = attach();
    client.receive('upturned-hull', 100, 100);
    const skiffs = client.layer.getObjectByName('structures:skiffs')!.children[0] as Mesh & { count: number };
    expect(skiffs.count).toBe(1);
    expect(client.dryCoast()).toBeGreaterThan(0);
    expect(skiffs.count).toBe(0);
  });

  it('registers anchor-aware mesh picking and removes the registration on dispose', () => {
    const client = attach();
    client.receive('watchtower', 10, 10);
    client.layer.updateMatrixWorld(true);
    expect(client.picks.size).toBe(1);
    const [object, resolve] = [...client.picks][0];
    const ray = new Raycaster(new Vector3(2.5, 10, 7.5), new Vector3(0, -1, -1).normalize());
    const hit = ray.intersectObject(object, true)[0];
    expect(hit).toBeDefined();
    expect(resolve(hit)).toEqual({ x: 10, y: 10 });
    clientPlugin.dispose!();
    expect(client.picks.size).toBe(0);
  });
});
