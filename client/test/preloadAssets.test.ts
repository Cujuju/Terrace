import { describe, expect, it, vi } from 'vitest';
import { createPreloadAssets } from '../src/plugins/kit/preloadAssets.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('mount-owned pending assets', () => {
  it.each([true, false])('keeps replacement assets independent of canceled completion order (%s)', async (newFirst) => {
    const slots = createPreloadAssets<{ dispose(): void }>();
    const old = new AbortController(), current = new AbortController();
    const oldLoad = deferred<{ dispose(): void }>(), newLoad = deferred<{ dispose(): void }>();
    const a = { dispose: vi.fn() }, b = { dispose: vi.fn() };
    const first = slots.load(old.signal, () => oldLoad.promise);
    old.abort();
    const second = slots.load(current.signal, () => newLoad.promise);
    if (newFirst) { newLoad.resolve(b); await second; oldLoad.resolve(a); }
    else { oldLoad.resolve(a); await first; newLoad.resolve(b); }
    await Promise.all([first, second]);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(slots.take(old.signal)).toBeUndefined();
    expect(slots.take(current.signal)).toBe(b);
    current.abort();
    expect(b.dispose).not.toHaveBeenCalled();
    b.dispose();
  });

  it('disposes a completed but unattached preload immediately on cancellation', async () => {
    const slots = createPreloadAssets<{ dispose(): void }>();
    const mount = new AbortController(), asset = { dispose: vi.fn() };
    await slots.load(mount.signal, async () => asset);
    mount.abort();
    expect(asset.dispose).toHaveBeenCalledTimes(1);
    expect(slots.take(mount.signal)).toBeUndefined();
  });

  it('does not acquire new assets after cancellation', async () => {
    const slots = createPreloadAssets<{ dispose(): void }>();
    const mount = new AbortController(), acquire = vi.fn();
    mount.abort();
    await slots.load(mount.signal, acquire);
    expect(acquire).not.toHaveBeenCalled();
  });
});
