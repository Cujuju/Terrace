import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface FireFuelApi {
  registerEntityFuel(source: NamedFuelSource): void;
  unregisterEntityFuel(name: string): void;
}

export interface NamedFuelSource {
  readonly name: string;
  readonly [field: string]: unknown;
}

const FIRE_PLUGIN_NAME = 'fire';

export const FIRE_UNAVAILABLE_WARNING =
  '[pilgrims] fire plugin not available — peeps will not burn';

let pendingSource: NamedFuelSource | null = null;

function asFireApi(module: SiblingModule | null): FireFuelApi | null {
  if (module === null) return null;
  if (typeof module.registerEntityFuel !== 'function') return null;
  if (typeof module.unregisterEntityFuel !== 'function') return null;
  return module as unknown as FireFuelApi;
}

const bridge = createSiblingBridge<FireFuelApi>({
  pluginName: FIRE_PLUGIN_NAME,
  duckType: asFireApi,
  unavailableWarning: FIRE_UNAVAILABLE_WARNING,
  onResolved: (api): void => {
    if (pendingSource !== null) api.registerEntityFuel(pendingSource);
  },
});

export function loadFireBridge(world: WorldApi): void {
  bridge.load(world);
}

export function registerPilgrimsFuel(source: NamedFuelSource): void {
  const api = bridge.api();
  pendingSource = source;
  if (api !== null) api.registerEntityFuel(source);
}

export function closeFireBridge(): void {
  const api = bridge.api();
  if (api !== null && pendingSource !== null) api.unregisterEntityFuel(pendingSource.name);
  bridge.clear();
  pendingSource = null;
}

export function resetFireBridge(): void {
  bridge.reset();
  pendingSource = null;
}
