import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface BridgedStructureCell {
  readonly x: number;
  readonly y: number;
}

export interface StructuresApi {
  standingStructures(): BridgedStructureCell[];
}

const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[flora] structures plugin not available — no buildings means nothing excludes trees';

function asStructuresApi(module: SiblingModule | null): StructuresApi | null {
  if (module === null) return null;
  if (typeof module.standingStructures !== 'function') return null;
  return module as unknown as StructuresApi;
}

const bridge = createSiblingBridge<StructuresApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
});

export function loadStructuresBridge(world: WorldApi): void {
  bridge.load(world);
}

export function bridgedStructures(): BridgedStructureCell[] {
  return bridge.api()?.standingStructures() ?? [];
}

export function resetStructuresBridge(): void {
  bridge.reset();
}
