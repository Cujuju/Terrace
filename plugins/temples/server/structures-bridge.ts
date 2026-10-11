import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface StructuresReservationApi {
  setReservedStructureCells(cells: readonly number[]): void;
}

const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[temples] structures plugin not available — no settlements means nothing to keep off the temple';

let desiredReservedCells: readonly number[] = [];

function asStructuresApi(module: SiblingModule | null): StructuresReservationApi | null {
  if (module === null) return null;
  if (typeof module.setReservedStructureCells !== 'function') return null;
  return module as unknown as StructuresReservationApi;
}

const bridge = createSiblingBridge<StructuresReservationApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
  onResolved: (api): void => {
    api.setReservedStructureCells(desiredReservedCells);
  },
});

export function loadStructuresBridge(world: WorldApi): void {
  bridge.load(world);
}

export function reserveStructureGround(cells: readonly number[]): void {
  desiredReservedCells = cells;
  bridge.api()?.setReservedStructureCells(cells);
}

export function resetStructuresBridge(): void {
  bridge.reset();
  desiredReservedCells = [];
}
