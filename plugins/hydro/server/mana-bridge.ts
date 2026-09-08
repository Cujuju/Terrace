import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface ManaSpendApi {
  spendMana(world: WorldApi, playerId: string, amount: number): boolean;
}

const MANA_PLUGIN_NAME = 'mana';

export const MANA_UNAVAILABLE_WARNING =
  '[hydro] mana plugin not available — pouring water will cost nothing';

function asManaApi(module: SiblingModule | null): ManaSpendApi | null {
  if (module === null) return null;
  if (typeof module.spendMana !== 'function') return null;
  return module as unknown as ManaSpendApi;
}

const bridge = createSiblingBridge<ManaSpendApi>({
  pluginName: MANA_PLUGIN_NAME,
  duckType: asManaApi,
  unavailableWarning: MANA_UNAVAILABLE_WARNING,
});

export function loadManaBridge(world: WorldApi): void {
  bridge.load(world);
}

export function chargeMana(world: WorldApi, playerId: string, amount: number): boolean {
  const api = bridge.api();
  if (api === null) {
    bridge.warnUnavailable();
    return true;
  }
  return api.spendMana(world, playerId, amount);
}

export function clearManaBridge(): void {
  bridge.clear();
}

export function resetManaBridge(): void {
  bridge.reset();
}
