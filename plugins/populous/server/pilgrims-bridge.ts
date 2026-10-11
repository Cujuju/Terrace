import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface PilgrimsApi {
  emitSettlerFrom(x: number, y: number): boolean;
}

const PILGRIMS_PLUGIN_NAME = 'pilgrims';

export const PILGRIMS_UNAVAILABLE_WARNING =
  '[populous] pilgrims plugin not available — houses will fill up but nobody walks out';

function asPilgrimsApi(module: SiblingModule | null): PilgrimsApi | null {
  if (module === null) return null;
  if (typeof module.emitSettlerFrom !== 'function') return null;
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

export function emitSettlerFrom(x: number, y: number): boolean {
  return bridge.api()?.emitSettlerFrom(x, y) ?? false;
}

export function resetPilgrimsBridge(): void {
  bridge.reset();
}
