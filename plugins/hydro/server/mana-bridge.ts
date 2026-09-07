// hydro → mana, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (server/src/plugins/kit/bridge.ts — read its header; this file follows its
// four rules).
//
// RULE 3 ("buffer, don't drop") DOES NOT APPLY, and the reason is worth stating
// because this bridge WRITES, which is normally exactly when it does. A debit
// is not desired state — it is an answer to a question being asked right now:
// "may this player pour water here?" Replaying it later would charge someone
// for an action whose moment has passed.
//
// DEGRADED BEHAVIOUR when mana is absent (or too old to export `spendMana`):
// POURING WATER IS FREE. One warning is logged, once. That is the right failure
// mode and the same one the whole plugin family keeps — a self-hoster who
// removed the mana plugin removed the economy, not the ability to play.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of mana this plugin uses — one debit, and nothing else. */
export interface ManaSpendApi {
  spendMana(world: WorldApi, playerId: string, amount: number): boolean;
}

/**
 * The name the host knows mana by — the key `WorldApi.sibling` answers to. A
 * NAME, NOT A PATH (issue #196), so a mana that is absent OR disabled for this
 * world resolves to null.
 */
const MANA_PLUGIN_NAME = 'mana';

export const MANA_UNAVAILABLE_WARNING =
  '[hydro] mana plugin not available — pouring water will cost nothing';

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
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

/** Resolves mana through the host, from onWorldCreate. */
export function loadManaBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * Charges the player, if there is an economy to charge them in. True means the
 * action may proceed — which is also the answer when mana is absent, because a
 * world with no economy has no price to refuse.
 */
export function chargeMana(world: WorldApi, playerId: string, amount: number): boolean {
  const api = bridge.api();
  if (api === null) {
    bridge.warnUnavailable();
    return true;
  }
  return api.spendMana(world, playerId, amount);
}

/**
 * Forgets the resolved sibling — what this bridge does when its world closes.
 * A module-scope view must not outlive the world it was resolved for (the
 * 2026-08-25 revocation rule); the warning survives, because "this deployment
 * has no mana plugin" is a property of the process.
 */
export function clearManaBridge(): void {
  bridge.clear();
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetManaBridge(): void {
  bridge.reset();
}
