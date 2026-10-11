import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';
import type { TempleWorld } from './suitability.ts';

export interface BridgedTempleSite {
  readonly x: number;
  readonly y: number;
  readonly doorX: number;
  readonly doorY: number;
}

export interface PilgrimsApi {
  canDispatchSettler(world: unknown, temple: BridgedTempleSite): boolean;
}

const PILGRIMS_PLUGIN_NAME = 'pilgrims';

export const PILGRIMS_UNAVAILABLE_WARNING =
  '[temples] pilgrims plugin not available — placements are not settler-checked';

function asPilgrimsApi(module: SiblingModule | null): PilgrimsApi | null {
  if (module === null) return null;
  if (typeof module.canDispatchSettler !== 'function') return null;
  return module as unknown as PilgrimsApi;
}

const bridge = createSiblingBridge<PilgrimsApi>({
  pluginName: PILGRIMS_PLUGIN_NAME,
  duckType: asPilgrimsApi,
  unavailableWarning: PILGRIMS_UNAVAILABLE_WARNING,
});

export function loadPilgrimsBridge(world: WorldApi): void {
  bridge.load(world);
}

export function templeCanSettle(world: TempleWorld, temple: BridgedTempleSite): boolean {
  const api = bridge.api();
  if (api === null) return true;
  return api.canDispatchSettler(world, temple);
}

export function resetPilgrimsBridge(): void {
  bridge.reset();
}
