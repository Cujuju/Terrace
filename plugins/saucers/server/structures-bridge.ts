import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface StructuresCellsApi {
  standingStructures(): readonly {
    readonly x: number;
    readonly y: number;
    readonly footprintRadiusCells: number;
  }[];
}

const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[saucers] structures plugin not available — crash sites will not steer clear of towns';

function asStructuresApi(module: SiblingModule | null): StructuresCellsApi | null {
  if (module === null) return null;
  if (typeof module.standingStructures !== 'function') return null;
  return module as unknown as StructuresCellsApi;
}

const bridge = createSiblingBridge<StructuresCellsApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
});

export function loadStructuresBridge(world: WorldApi): void {
  bridge.load(world);
}

export const CRASH_SETTLEMENT_CLEARANCE_CELLS = 6;

export function isClearOfSettlements(x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) return true;
  for (const cell of api.standingStructures()) {
    // A sibling from before multi-cell buildings reports no radius: its building is its anchor cell.
    const footprint = Number.isInteger(cell.footprintRadiusCells) ? Math.max(0, cell.footprintRadiusCells) : 0;
    const reach = CRASH_SETTLEMENT_CLEARANCE_CELLS + footprint;
    const dx = cell.x - x;
    const dy = cell.y - y;
    if (dx * dx + dy * dy < reach * reach) return false;
  }
  return true;
}

export function clearStructuresBridge(): void {
  bridge.clear();
}

export function resetStructuresBridge(): void {
  bridge.reset();
}
