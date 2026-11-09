import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';
import { CRASH_CRATER_RADIUS_CELLS } from '../protocol.ts';

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

function footprintRadius(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(0, value) : 0;
}

export function isClearOfSettlements(x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) return true;
  for (const cell of api.standingStructures()) {
    // A sibling from before multi-cell buildings reports no radius: its building is its anchor cell.
    const footprint = footprintRadius(cell.footprintRadiusCells);
    const reach = Math.max(CRASH_SETTLEMENT_CLEARANCE_CELLS, CRASH_CRATER_RADIUS_CELLS);
    const dx = Math.max(0, Math.abs(cell.x - x) - footprint);
    const dy = Math.max(0, Math.abs(cell.y - y) - footprint);
    if (dx * dx + dy * dy <= reach * reach) return false;
  }
  return true;
}

export function crashWriteAllowed(): (x: number, y: number) => boolean {
  const structures = bridge.api()?.standingStructures() ?? [];
  return (x, y) => structures.every((cell) => {
    const radius = footprintRadius(cell.footprintRadiusCells);
    return Math.abs(cell.x - x) > radius || Math.abs(cell.y - y) > radius;
  });
}

export function clearStructuresBridge(): void {
  bridge.clear();
}

export function resetStructuresBridge(): void {
  bridge.reset();
}
