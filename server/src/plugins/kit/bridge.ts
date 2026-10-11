import type { SiblingModule, WorldApi } from '../types.ts';

export interface SiblingBridgeSpec<T> {
  readonly pluginName: string;
  duckType(module: SiblingModule | null): T | null;
  readonly unavailableWarning: string;
  onResolved?(api: T): void;
}

export interface SiblingBridge<T> {
  load(world: WorldApi): void;
  api(): T | null;
  clear(): void;
  warnUnavailable(): void;
  reset(): void;
}

export interface RegisteringBridgeSpec<TApi, TEntry>
  extends Omit<SiblingBridgeSpec<TApi>, 'onResolved'> {
  register(api: TApi, entry: TEntry): () => void;
}

export interface RegisteringBridge<TApi, TEntry> extends SiblingBridge<TApi> {
  registerWith(entry: TEntry): void;
  unregister(): void;
}

// Buffers the desired entry so a sibling resolved later (or re-resolved on
// reopen) receives it; never holds two live registrations at once.
export function createRegisteringBridge<TApi, TEntry>(
  spec: RegisteringBridgeSpec<TApi, TEntry>,
): RegisteringBridge<TApi, TEntry> {
  let desired: TEntry | null = null;
  let release: (() => void) | null = null;

  function registerNow(api: TApi, entry: TEntry): void {
    release?.();
    release = spec.register(api, entry);
  }

  const bridge = createSiblingBridge<TApi>({
    pluginName: spec.pluginName,
    duckType: spec.duckType,
    unavailableWarning: spec.unavailableWarning,
    onResolved: (api) => {
      if (desired !== null) registerNow(api, desired);
    },
  });

  function unregister(): void {
    release?.();
    release = null;
    desired = null;
  }

  return {
    load: bridge.load,
    api: bridge.api,
    warnUnavailable: bridge.warnUnavailable,
    registerWith(entry: TEntry): void {
      desired = entry;
      const api = bridge.api();
      if (api !== null) registerNow(api, entry);
    },
    unregister,
    clear(): void {
      unregister();
      bridge.clear();
    },
    reset(): void {
      release = null;
      desired = null;
      bridge.reset();
    },
  };
}

// Warns once per run of failed loads: a load that resolves re-arms the warning,
// so the next world that opens without the sibling says so again.
export function createSiblingBridge<T>(spec: SiblingBridgeSpec<T>): SiblingBridge<T> {
  let resolved: T | null = null;
  let warned = false;

  function warnUnavailable(): void {
    if (warned) return;
    warned = true;
    console.warn(spec.unavailableWarning);
  }

  return {
    load(world: WorldApi): void {
      const api = spec.duckType(world.sibling(spec.pluginName));
      if (api === null) {
        resolved = null;
        warnUnavailable();
        return;
      }
      resolved = api;
      warned = false;
      spec.onResolved?.(api);
    },
    api(): T | null {
      return resolved;
    },
    clear(): void {
      resolved = null;
    },
    warnUnavailable,
    reset(): void {
      resolved = null;
      warned = false;
    },
  };
}
