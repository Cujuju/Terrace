import { describe, expect, it, vi } from 'vitest';
import type { BuildingAssetKit } from '../src/render/buildingAssetKit.ts';
import { loadBuildingAssetKit } from '../src/render/buildingAssetKit.ts';
import { preloadTempleForMount, takeTempleForMount } from '../../plugins/temples/client/authoredAssets.ts';

vi.mock('../src/render/buildingAssetKit.ts', () => ({ loadBuildingAssetKit: vi.fn() }));

function pendingKit() {
  const kit: BuildingAssetKit = { parts: () => [], dispose: vi.fn() };
  let resolve!: (kit: BuildingAssetKit) => void;
  const promise = new Promise<BuildingAssetKit>((done) => { resolve = done; });
  vi.mocked(loadBuildingAssetKit).mockReturnValueOnce(promise);
  return { kit, resolve: () => resolve(kit) };
}

describe('temple preload resource ownership', () => {
  it.each(['stale-first', 'current-first'] as const)('isolates overlapping mounts: %s', async (order) => {
    const stale = new AbortController();
    const first = pendingKit();
    const firstLoad = preloadTempleForMount(stale.signal, 'low');
    stale.abort();
    const current = new AbortController();
    const second = pendingKit();
    const secondLoad = preloadTempleForMount(current.signal, 'original');
    if (order === 'stale-first') { first.resolve(); await firstLoad; }
    second.resolve();
    await secondLoad;
    const mountedKit = takeTempleForMount(current.signal);
    if (order === 'current-first') { first.resolve(); await firstLoad; }
    expect(mountedKit).toBe(second.kit);
    expect(takeTempleForMount(stale.signal)).toBeUndefined();
    expect(first.kit.dispose).toHaveBeenCalledTimes(1);
    expect(second.kit.dispose).not.toHaveBeenCalled();
    current.abort();
    expect(second.kit.dispose).not.toHaveBeenCalled();
    mountedKit!.dispose();
    expect(second.kit.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a loaded kit canceled before attach and never hands it out', async () => {
    const lifetime = new AbortController();
    const pending = pendingKit();
    const load = preloadTempleForMount(lifetime.signal, 'low');
    pending.resolve();
    await load;
    lifetime.abort();
    expect(pending.kit.dispose).toHaveBeenCalledTimes(1);
    expect(takeTempleForMount(lifetime.signal)).toBeUndefined();
  });
});
