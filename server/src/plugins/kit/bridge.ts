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
