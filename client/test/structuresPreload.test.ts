import { Group } from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientPluginCtx } from '../src/plugins/types.ts';
import type { BuildingAssetKit } from '../src/render/buildingAssetKit.ts';

const state = vi.hoisted(() => ({ requests: [] as ((kit: BuildingAssetKit) => void)[], kits: [] as unknown[] }));
vi.mock('../../plugins/structures/client/authoredAssets.ts', () => ({
  preloadAuthoredStructures: () => new Promise<BuildingAssetKit>((resolve) => { state.requests.push(resolve); }),
}));
vi.mock('../../plugins/structures/client/skiffModels.ts', () => ({
  preloadSkiffModels: async () => {}, installSkiffForMount() {}, disposeSkiffKit() {},
  createSkiffModels: () => ({ root: new Group(), apply() {}, animate() {}, dispose() {} }),
}));
vi.mock('../../plugins/structures/client/models.ts', () => ({
  createStructureModels: (kit: unknown) => {
    state.kits.push(kit);
    return { root: new Group(), apply() {}, animate() {}, dispose() {} };
  },
}));
const { clientPlugin } = await import('../../plugins/structures/client/index.ts');

function context(signal: AbortSignal): ClientPluginCtx {
  return { signal, layer: new Group(), terrainRevisionAt: () => 0, drawnGroundYAt: () => 0,
    onMessage: () => () => {}, onWorldReset: () => () => {}, onTerrainChanged: () => () => {},
    onFrame: () => () => {}, markPickable: () => () => {}, requestShaderWarmup() {},
  } as unknown as ClientPluginCtx;
}

afterEach(() => { clientPlugin.dispose!(); state.requests.length = 0; state.kits.length = 0; });

it.each([true, false])('never replaces the current structures kit with a canceled mount (%s)', async (newFirst) => {
  const old = new AbortController(), current = new AbortController();
  const oldKit = { parts: vi.fn(), dispose: vi.fn() }, newKit = { parts: vi.fn(), dispose: vi.fn() };
  const first = clientPlugin.preload!(context(old.signal));
  old.abort();
  const ctx = context(current.signal);
  const second = clientPlugin.preload!(ctx);
  if (newFirst) {
    state.requests[1](newKit); await second; clientPlugin.attach(ctx);
    state.requests[0](oldKit); await first;
  } else {
    state.requests[0](oldKit); await first;
    state.requests[1](newKit); await second; clientPlugin.attach(ctx);
  }
  expect(state.kits).toEqual([newKit]);
  expect(oldKit.dispose).toHaveBeenCalledTimes(1);
  expect(newKit.dispose).not.toHaveBeenCalled();
  clientPlugin.dispose!();
  expect(newKit.dispose).toHaveBeenCalledTimes(1);
});
