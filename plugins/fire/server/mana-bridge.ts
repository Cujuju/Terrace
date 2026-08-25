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

import type { WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of mana this plugin uses — one debit, and nothing else. */
export interface ManaSpendApi {
  spendMana(world: WorldApi, playerId: string, amount: number): boolean;
}

export type ManaModuleLoader = () => Promise<unknown>;

const DEFAULT_MANA_MODULE_LOADER: ManaModuleLoader = () => import('../../mana/server/index.ts');

export const MANA_UNAVAILABLE_WARNING =
  '[fire] mana plugin not available — lighting a fire will cost nothing';

let loadModule: ManaModuleLoader = DEFAULT_MANA_MODULE_LOADER;
let manaApi: ManaSpendApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

function asManaApi(module: unknown): ManaSpendApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<ManaSpendApi>;
  if (typeof candidate.spendMana !== 'function') return null;
  return candidate as ManaSpendApi;
}

function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(MANA_UNAVAILABLE_WARNING);
}

/** Starts the load (rule 2: from onWorldCreate, NOT awaited). */
export function loadManaBridge(): void {
  if (loadPromise !== null) return;

  loadPromise = loadModule()
    .then((module) => {
      manaApi = asManaApi(module);
      if (manaApi === null) warnOnce();
    })
    .catch(() => {
      manaApi = null;
      warnOnce();
    });
}

/**
 * Charges the player, if there is an economy to charge them in. True means the
 * action may proceed — which is also the answer when mana is absent, because a
 * world with no economy has no price to refuse.
 */
export function chargeMana(world: WorldApi, playerId: string, amount: number): boolean {
  if (manaApi === null) {
    warnOnce();
    return true;
  }
  return manaApi.spendMana(world, playerId, amount);
}

/** Test seam: forgets the load and the warning. */
export function resetManaBridge(loader: ManaModuleLoader = DEFAULT_MANA_MODULE_LOADER): void {
  loadModule = loader;
  manaApi = null;
  loadPromise = null;
  warned = false;
}
