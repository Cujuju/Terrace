import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface MudslidesApi {
  startDirectedSlide(world: WorldApi, x: number, y: number): boolean;
}

const MUDSLIDES_PLUGIN_NAME = 'mudslides';

export const MUDSLIDES_UNAVAILABLE_WARNING =
  '[hydro] mudslides plugin not available — poured water will not bring a hillside down';

function asMudslidesApi(module: SiblingModule | null): MudslidesApi | null {
  if (module === null) return null;
  if (typeof module.startDirectedSlide !== 'function') return null;
  return module as unknown as MudslidesApi;
}

const bridge = createSiblingBridge<MudslidesApi>({
  pluginName: MUDSLIDES_PLUGIN_NAME,
  duckType: asMudslidesApi,
  unavailableWarning: MUDSLIDES_UNAVAILABLE_WARNING,
});

export function loadMudslidesBridge(world: WorldApi): void {
  bridge.load(world);
}

export function requestSlide(world: WorldApi, x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) {
    bridge.warnUnavailable();
    return false;
  }
  return api.startDirectedSlide(world, x, y);
}

export function clearMudslidesBridge(): void {
  bridge.clear();
}

export function resetMudslidesBridge(): void {
  bridge.reset();
}
