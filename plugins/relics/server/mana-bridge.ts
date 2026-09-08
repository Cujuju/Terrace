import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';
import type { ManaPerk } from './perk.ts';

export interface ManaPerkApi {
  setManaPerk(playerId: string, perk: ManaPerk): void;
  clearManaPerk(playerId: string): void;
}

const MANA_PLUGIN_NAME = 'mana';

export const MANA_UNAVAILABLE_WARNING =
  '[relics] mana plugin not available — mana perks (Azure Heart, Spring of Aether) ' +
  'will be granted but have no effect';

const desiredPerks = new Map<string, ManaPerk>();

function asManaPerkApi(module: SiblingModule | null): ManaPerkApi | null {
  if (module === null) return null;
  if (typeof module.setManaPerk !== 'function') return null;
  if (typeof module.clearManaPerk !== 'function') return null;
  return module as unknown as ManaPerkApi;
}

const bridge = createSiblingBridge<ManaPerkApi>({
  pluginName: MANA_PLUGIN_NAME,
  duckType: asManaPerkApi,
  unavailableWarning: MANA_UNAVAILABLE_WARNING,
  onResolved: (api): void => {
    flushDesiredPerks(api);
  },
});

function flushDesiredPerks(target: ManaPerkApi): void {
  for (const [playerId, perk] of desiredPerks) target.setManaPerk(playerId, perk);
}

export function loadManaBridge(world: WorldApi): void {
  bridge.load(world);
}

export function isManaAvailable(): boolean {
  return bridge.api() !== null;
}

export function applyManaPerk(playerId: string, perk: ManaPerk): void {
  desiredPerks.set(playerId, perk);
  bridge.api()?.setManaPerk(playerId, perk);
}

export function revokeManaPerk(playerId: string): void {
  desiredPerks.delete(playerId);
  bridge.api()?.clearManaPerk(playerId);
}

export function resetManaBridge(): void {
  bridge.reset();
  desiredPerks.clear();
}
