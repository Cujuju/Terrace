import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface FireFuelApi {
  registerFuel(source: NamedFuelSource): void;
  unregisterFuel(name: string): void;
}

export interface NamedFuelSource {
  readonly name: string;
  readonly [field: string]: unknown;
}

const FIRE_PLUGIN_NAME = 'fire';

export const FIRE_UNAVAILABLE_WARNING =
  '[structures] fire plugin not available — buildings will not burn';

let pendingSource: NamedFuelSource | null = null;

function asFireApi(module: SiblingModule | null): FireFuelApi | null {
  if (module === null) return null;
  if (typeof module.registerFuel !== 'function') return null;
  if (typeof module.unregisterFuel !== 'function') return null;
  return module as unknown as FireFuelApi;
}

const bridge = createSiblingBridge<FireFuelApi>({
  pluginName: FIRE_PLUGIN_NAME,
  duckType: asFireApi,
  unavailableWarning: FIRE_UNAVAILABLE_WARNING,
  onResolved: (api): void => {
    if (pendingSource !== null) api.registerFuel(pendingSource);
  },
});

export function loadFireBridge(world: WorldApi): void {
  bridge.load(world);
}

export function registerStructuresFuel(source: NamedFuelSource): void {
  const api = bridge.api();
  pendingSource = source;
  if (api !== null) api.registerFuel(source);
}

export function closeFireBridge(): void {
  const api = bridge.api();
  if (api !== null && pendingSource !== null) api.unregisterFuel(pendingSource.name);
  bridge.clear();
  pendingSource = null;
}

export function resetFireBridge(): void {
  bridge.reset();
  pendingSource = null;
}
