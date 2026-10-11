import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface FireIgnitionApi {
  igniteAt(x: number, y: number): boolean;
}

const FIRE_PLUGIN_NAME = 'fire';

export const FIRE_UNAVAILABLE_WARNING =
  '[saucers] fire plugin not available — a crash site will leave a crater but no flames';

function asFireApi(module: SiblingModule | null): FireIgnitionApi | null {
  if (module === null) return null;
  if (typeof module.igniteAt !== 'function') return null;
  return module as unknown as FireIgnitionApi;
}

const bridge = createSiblingBridge<FireIgnitionApi>({
  pluginName: FIRE_PLUGIN_NAME,
  duckType: asFireApi,
  unavailableWarning: FIRE_UNAVAILABLE_WARNING,
});

export function loadFireBridge(world: WorldApi): void {
  bridge.load(world);
}

export function igniteCrashCell(x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) return false;
  return api.igniteAt(x, y);
}

export function clearFireBridge(): void {
  bridge.clear();
}

export function resetFireBridge(): void {
  bridge.reset();
}
