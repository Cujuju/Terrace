// fire → mana, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules).
//
// RULE 3 ("buffer, don't drop") DOES NOT APPLY, and the reason is worth stating
// because this bridge WRITES, which is normally exactly when it does. A debit
// is not desired state — it is an answer to a question being asked right now:
// "may this player light this fire?" Replaying it later would charge someone for
// an action whose moment has passed. So a spend that arrives before mana does is
// not buffered; it is answered from the fallback below.
//
// DEGRADED BEHAVIOUR when mana is absent (or too old to export `spendMana`):
// LIGHTING A FIRE IS FREE. One warning is logged, once. That is the right
// failure mode and the same one the whole plugin family keeps — a self-hoster
// who removed the mana plugin removed the economy, not the ability to play. The
// alternative (refuse the action when there is no economy) would make deleting
// mana silently delete a mechanic that has nothing to do with it.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of mana this plugin uses — one debit, and nothing else. */
export interface ManaSpendApi {
  spendMana(world: WorldApi, playerId: string, amount: number): boolean;
}

/**
 * The name the host knows mana by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196): the host hands back the plugin RUNNING as
 * `mana` in this session, so a mana that is absent OR disabled for this world
 * resolves to null, where the old import answered from the module map either
 * way.
 */
const MANA_PLUGIN_NAME = 'mana';

export const MANA_UNAVAILABLE_WARNING =
  '[fire] mana plugin not available — lighting a fire will cost nothing';

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asManaApi(module: SiblingModule | null): ManaSpendApi | null {
  if (module === null) return null;
  if (typeof module.spendMana !== 'function') return null;
  return module as unknown as ManaSpendApi;
}

/**
 * The sibling, resolved through the host — the MECHANISM only: the name lookup,
 * the warn-once, the re-resolve on every load, the clear on close.
 *
 * It lives in core's plugin kit (server/src/plugins/kit/bridge.ts) because
 * nineteen bridges each carried a copy of it. What stays HERE is the duck-typed
 * interface above and the accessors below, because those are the CONTRACT
 * between two independently-deletable folders — the thing that has to survive
 * one side being absent or older.
 */
const bridge = createSiblingBridge<ManaSpendApi>({
  pluginName: MANA_PLUGIN_NAME,
  duckType: asManaApi,
  unavailableWarning: MANA_UNAVAILABLE_WARNING,
});

/**
 * Resolves mana through the host, from onWorldCreate.
 *
 * NOTHING IS IN FLIGHT ANY MORE: the old rule 2 (start the import, do not await
 * it) existed because module resolution is asynchronous, and the host's lookup
 * is not. Re-resolved on every call, so a mana the operator has just enabled is
 * picked up on the reopen; the bridge's warn-once keeps an absent one to a single line.
 */
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

/** Test seam: forgets the resolved sibling and the warning. */
export function resetManaBridge(): void {
  bridge.reset();
}
