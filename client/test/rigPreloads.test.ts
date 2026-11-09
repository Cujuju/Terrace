import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import type { RigAsset } from '../src/render/rigAsset.ts';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import { clearSaucerAssets, createSaucerModels, disposeSaucerAssets, installSaucerForMount, preloadSaucerModels } from '../../plugins/saucers/client/models.ts';
import { preloadBoatModels } from '../../plugins/boats/client/models.ts';

const wildlife = vi.hoisted(() => ({ installed: new Map<string, RigAsset>() }));
vi.mock('../../plugins/wildlife/client/species/assetSpecies.ts', async (original) => ({
  ...await original<typeof import('../../plugins/wildlife/client/species/assetSpecies.ts')>(),
  prepareSpeciesAsset(_spec: unknown, asset: RigAsset) {
    return { asset, root: asset.scene, joints: {}, dispose: () => asset.dispose() };
  },
  installPreparedSpecies(species: string, prepared: { asset: RigAsset }) { wildlife.installed.set(species, prepared.asset); },
  disposeSpeciesAssets() { for (const asset of wildlife.installed.values()) asset.dispose(); wildlife.installed.clear(); },
}));
vi.mock('../../plugins/wildlife/client/models.ts', () => ({ createWildlifeModels: () => ({
  objects: Array.from({ length: 15 }, () => new Group()), dispose() {},
}) }));
const { clientPlugin: wildlifePlugin } = await import('../../plugins/wildlife/client/index.ts');

function asset(name: string): RigAsset & { dispose: ReturnType<typeof vi.fn> } {
  const geometry = new BoxGeometry(0.1, 0.1, 0.1), material = new MeshStandardMaterial();
  const scene = new Group(), mesh = new Mesh(geometry, material);
  mesh.name = name;
  scene.add(mesh);
  return { scene, node: () => mesh, anchor: (name) => new Vector3(0, name === 'fire_top' ? 0.1 : 0, 0),
    dispose: vi.fn(() => { geometry.dispose(); material.dispose(); }) };
}

function context(signal: AbortSignal, loadRigAsset: ClientPluginCtx['loadRigAsset']): ClientPluginCtx {
  return { signal, loadRigAsset, layer: new Group(), onMessage: () => () => {}, onFrame: () => () => {},
    onWorldReset: () => () => {}, markPickable: () => () => {}, publishMovers: () => () => {},
  } as unknown as ClientPluginCtx;
}

afterEach(() => { clearSaucerAssets(); wildlifePlugin.dispose!(); });

it('a canceled saucer load neither clears nor replaces mounted hull assets', async () => {
  const old = new AbortController(), current = new AbortController();
  const a = asset('abandoned');
  let resolveOld!: (asset: RigAsset) => void;
  const acquireOld = vi.fn(() => new Promise<RigAsset>((resolve) => { resolveOld = resolve; }));
  const first = preloadSaucerModels(context(old.signal, acquireOld));
  await vi.waitFor(() => expect(acquireOld).toHaveBeenCalledTimes(1));
  old.abort();
  const mounted: ReturnType<typeof asset>[] = [];
  await preloadSaucerModels(context(current.signal, async () => {
    const next = asset(`mounted-${mounted.length}`); mounted.push(next); return next;
  }));
  installSaucerForMount(current.signal);
  const models = createSaucerModels();
  const model = models.create(0);
  expect(model.root.getObjectByName('mounted-0')).toBeDefined();
  resolveOld(a);
  await first;
  expect(a.dispose).toHaveBeenCalledTimes(1);
  for (const next of mounted) expect(next.dispose).not.toHaveBeenCalled();
  model.dispose(); models.dispose(); disposeSaucerAssets();
  for (const next of mounted) expect(next.dispose).toHaveBeenCalledTimes(1);
});

it('wildlife publishes only the current mount and disposes partial abandoned species loads', async () => {
  const old = new AbortController(), current = new AbortController();
  const partial = asset('partial'), abandoned = asset('abandoned');
  let resolveOld!: (asset: RigAsset) => void;
  let calls = 0;
  const first = wildlifePlugin.preload!(context(old.signal, () => ++calls === 1 ? Promise.resolve(partial)
    : new Promise<RigAsset>((resolve) => { resolveOld = resolve; })));
  await vi.waitFor(() => expect(calls).toBe(2));
  old.abort();
  expect(partial.dispose).toHaveBeenCalledTimes(1);
  const mounted: ReturnType<typeof asset>[] = [];
  const ctx = context(current.signal, async () => {
    const next = asset(`mounted-${mounted.length}`); mounted.push(next); return next;
  });
  await wildlifePlugin.preload!(ctx);
  wildlifePlugin.attach(ctx);
  expect(wildlife.installed.size).toBe(mounted.length);
  resolveOld(abandoned);
  await first;
  expect(abandoned.dispose).toHaveBeenCalledTimes(1);
  expect([...wildlife.installed.values()]).toEqual(mounted);
  for (const next of mounted) expect(next.dispose).not.toHaveBeenCalled();
  wildlifePlugin.dispose!();
  for (const next of mounted) expect(next.dispose).toHaveBeenCalledTimes(1);
});

it('a completed boat preload is released when its mount is canceled before attach', async () => {
  const mount = new AbortController(), boat = asset('boat');
  await preloadBoatModels(context(mount.signal, async () => boat), 'boat.glb');
  expect(boat.dispose).not.toHaveBeenCalled();
  mount.abort();
  expect(boat.dispose).toHaveBeenCalledTimes(1);
});
