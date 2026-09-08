import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface StructuresGrowthApi {
  setGrowthModel(model: unknown): void;
}

const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[populous] structures plugin not available (or too old for the growth-model seam) — nothing to grow';

let desiredModel: unknown = null;

function asStructuresGrowthApi(module: SiblingModule | null): StructuresGrowthApi | null {
  if (module === null) return null;
  if (typeof module.setGrowthModel !== 'function') return null;
  return module as unknown as StructuresGrowthApi;
}

const bridge = createSiblingBridge<StructuresGrowthApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresGrowthApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
  onResolved: (api): void => {
    if (desiredModel !== null) api.setGrowthModel(desiredModel);
  },
});

export function loadStructuresBridge(world: WorldApi): void {
  bridge.load(world);
}

export function registerGrowthModel(model: unknown): void {
  desiredModel = model;
  bridge.api()?.setGrowthModel(model);
}

export function clearGrowthModel(): void {
  desiredModel = null;
  bridge.api()?.setGrowthModel(null);
}

export function resetStructuresBridge(): void {
  bridge.reset();
  desiredModel = null;
}
