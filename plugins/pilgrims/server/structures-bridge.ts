import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface BridgedStructureCell {
  readonly x: number;
  readonly y: number;
  readonly tier: number;
  readonly age?: number;
}

export interface StructuresApi {
  standingStructures(): BridgedStructureCell[];
  setBlessedStructureCells(keys: readonly number[]): void;
  foundStructure?(world: unknown, x: number, y: number): boolean;
  canFoundStructure?(world: unknown, x: number, y: number): boolean;
}

const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[pilgrims] structures plugin not available — no settlements means no pilgrimages';

let desiredBlessedKeys: readonly number[] = [];

function asStructuresApi(module: SiblingModule | null): StructuresApi | null {
  if (module === null) return null;
  if (typeof module.standingStructures !== 'function') return null;
  if (typeof module.setBlessedStructureCells !== 'function') return null;
  return module as unknown as StructuresApi;
}

const bridge = createSiblingBridge<StructuresApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
  onResolved: (api): void => {
    api.setBlessedStructureCells(desiredBlessedKeys);
  },
});

export function loadStructuresBridge(world: WorldApi): void {
  bridge.load(world);
}

export function bridgedStructures(): BridgedStructureCell[] {
  return bridge.api()?.standingStructures() ?? [];
}

export function foundStructureAt(world: unknown, x: number, y: number): boolean {
  return bridge.api()?.foundStructure?.(world, x, y) ?? false;
}

export function canFoundStructureAt(world: unknown, x: number, y: number): boolean {
  return bridge.api()?.canFoundStructure?.(world, x, y) ?? true;
}

export function applyBlessedCells(keys: readonly number[]): void {
  desiredBlessedKeys = keys;
  bridge.api()?.setBlessedStructureCells(keys);
}

export function resetStructuresBridge(): void {
  bridge.reset();
  desiredBlessedKeys = [];
}
