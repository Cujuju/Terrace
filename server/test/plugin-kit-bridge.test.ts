import { describe, expect, it, vi } from 'vitest';
import { createSiblingBridge } from '../src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../src/plugins/types.ts';

interface DemoApi {
  doThing(): number;
}

function demoDuckType(module: SiblingModule | null): DemoApi | null {
  if (module === null) return null;
  if (typeof module.doThing !== 'function') return null;
  return module as unknown as DemoApi;
}

function worldWith(module: SiblingModule | null): WorldApi {
  return { sibling: () => module } as unknown as WorldApi;
}

const WARNING = '[demo] sibling not available';

function makeBridge(): ReturnType<typeof createSiblingBridge<DemoApi>> {
  return createSiblingBridge<DemoApi>({
    pluginName: 'demo',
    duckType: demoDuckType,
    unavailableWarning: WARNING,
  });
}

describe('createSiblingBridge', () => {
  it('resolves the sibling by NAME through the host', () => {
    const bridge = makeBridge();
    const sibling = vi.fn(() => ({ doThing: () => 7 }) as SiblingModule);
    bridge.load({ sibling } as unknown as WorldApi);
    expect(sibling).toHaveBeenCalledWith('demo');
    expect(bridge.api()?.doThing()).toBe(7);
  });

  it('is null before any load, and null for an absent sibling', () => {
    const bridge = makeBridge();
    expect(bridge.api()).toBe(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.load(worldWith(null));
    expect(bridge.api()).toBe(null);
    warn.mockRestore();
  });

  it('treats a module that does not duck-type as absent', () => {
    const bridge = makeBridge();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.load(worldWith({ somethingElse: 1 }));
    expect(bridge.api()).toBe(null);
    expect(warn).toHaveBeenCalledWith(WARNING);
    warn.mockRestore();
  });

  it('warns once, however many worlds open without the sibling', () => {
    const bridge = makeBridge();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.load(worldWith(null));
    bridge.load(worldWith(null));
    bridge.load(worldWith(null));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('CLEARS a sibling that stopped running, rather than leaving it reachable', () => {
    const bridge = makeBridge();
    bridge.load(worldWith({ doThing: () => 1 }));
    expect(bridge.api()).not.toBe(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.load(worldWith(null));
    expect(bridge.api()).toBe(null);
    warn.mockRestore();
  });

  it('calls onResolved with the API, so a caller can replay buffered state', () => {
    const replayed: number[] = [];
    const bridge = createSiblingBridge<DemoApi>({
      pluginName: 'demo',
      duckType: demoDuckType,
      unavailableWarning: WARNING,
      onResolved: (api) => replayed.push(api.doThing()),
    });
    bridge.load(worldWith({ doThing: () => 4 }));
    expect(replayed).toEqual([4]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.load(worldWith(null));
    expect(replayed).toEqual([4]);
    warn.mockRestore();
  });

  it('clear() drops the sibling but LEAVES the warning stood', () => {
    const bridge = makeBridge();
    bridge.load(worldWith({ doThing: () => 1 }));
    bridge.clear();
    expect(bridge.api()).toBe(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.load(worldWith(null));
    bridge.load(worldWith(null));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('warnUnavailable() emits the same once-only warning, for a caller that needs it', () => {
    const bridge = makeBridge();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.warnUnavailable();
    bridge.warnUnavailable();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(WARNING);
    warn.mockRestore();
  });

  it('reset() forgets both the sibling and the warning', () => {
    const bridge = makeBridge();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.load(worldWith(null));
    bridge.reset();
    bridge.load(worldWith(null));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(bridge.api()).toBe(null);
    warn.mockRestore();
  });
});
