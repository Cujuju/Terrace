import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface BridgedTemple {
  readonly x: number;
  readonly y: number;
  readonly doorX?: number;
  readonly doorY?: number;
}

export interface TemplesApi {
  standingTemple(): BridgedTemple | null;
}

const TEMPLES_PLUGIN_NAME = 'temples';

export const TEMPLES_UNAVAILABLE_WARNING =
  '[pilgrims] temples plugin not available — no temple means no settlers';

function asTemplesApi(module: SiblingModule | null): TemplesApi | null {
  if (module === null) return null;
  if (typeof module.standingTemple !== 'function') return null;
  return module as unknown as TemplesApi;
}

const bridge = createSiblingBridge<TemplesApi>({
  pluginName: TEMPLES_PLUGIN_NAME,
  duckType: asTemplesApi,
  unavailableWarning: TEMPLES_UNAVAILABLE_WARNING,
});

export function loadTemplesBridge(world: WorldApi): void {
  bridge.load(world);
}

export function bridgedTemple(): BridgedTemple | null {
  return bridge.api()?.standingTemple() ?? null;
}

export function resetTemplesBridge(): void {
  bridge.reset();
}
