// populous → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules to the letter: ask the host by name, resolve synchronously,
// buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM STRUCTURES: one function. `setGrowthModel(model)`
// — the growth-model seam (that plugin's server/growth-model.ts). Registering
// is the whole of this plugin's relationship with the board: structures then
// calls the registered model once per generation interval and applies whatever
// it returns.
//
// DEGRADED BEHAVIOUR when structures is absent, or is a build from before the
// seam existed: nothing happens at all — there is no board to grow, so there
// is nothing this plugin could do with one. One warning is logged, once.
//
// BUFFER, DON'T DROP (rule 3): the model is registered into a structures module
// that finishes loading after this plugin's onWorldCreate has already run.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of structures this plugin uses — deliberately one function. */
export interface StructuresGrowthApi {
  setGrowthModel(model: unknown): void;
}

/**
 * The name the host knows structures by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196). The host hands back the plugin RUNNING
 * as `structures` in this session, so a structures that is absent OR disabled for
 * this world resolves to null; the old dynamic import bound to a module
 * URL, and therefore answered from the process's module map either way.
 */
const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[populous] structures plugin not available (or too old for the growth-model seam) — nothing to grow';

let structuresApi: StructuresGrowthApi | null = null;
let warned = false;

/** The model this plugin wants registered — rule 3's buffer. */
let desiredModel: unknown = null;

function asStructuresGrowthApi(module: SiblingModule | null): StructuresGrowthApi | null {
  if (module === null) return null;
  if (typeof module.setGrowthModel !== 'function') return null;
  return module as unknown as StructuresGrowthApi;
}

function warnUnavailable(): void {
  if (warned) return;
  warned = true;
  console.warn(STRUCTURES_UNAVAILABLE_WARNING);
}

/**
 * Resolves structures through the host, from onWorldCreate.
 *
 * SYNCHRONOUS, AND THERE IS NOTHING LEFT TO AWAIT. The old rule 2 (start the
 * import, do not await it) and the promise it returned existed because module
 * resolution is asynchronous; the host's lookup is not, and it answers whatever
 * the load order — so the sibling is either in hand when this returns or is not
 * running in this world at all.
 *
 * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
 * and on a rollback, and a structures the operator has just enabled must be
 * picked up then. The warning still happens at most once.
 */
export function loadStructuresBridge(world: WorldApi): void {
  const resolved = asStructuresGrowthApi(world.sibling(STRUCTURES_PLUGIN_NAME));
  if (resolved === null) {
    // CLEARED, not left standing: this runs again on every reopen, and a
    // sibling that WAS running and is not any more (the operator disabled it)
    // must stop being reachable through a stale reference here.
    structuresApi = null;
    warnUnavailable();
    return;
  }
  structuresApi = resolved;
  if (desiredModel !== null) resolved.setGrowthModel(desiredModel);
}

/** Records and forwards the model this plugin wants driving the board. */
export function registerGrowthModel(model: unknown): void {
  desiredModel = model;
  structuresApi?.setGrowthModel(model);
}

/**
 * UNREGISTERS THIS PLUGIN'S MODEL — the buffer emptied AND the slot cleared,
 * in that order, so a late-resolving load cannot put the model back after the
 * world it belonged to has closed.
 *
 * WHY IT IS NOT `resetStructuresBridge` (the test seam): that one also drops
 * the resolved module and the injected loader, which would make every close
 * re-import structures and would silently undo a suite's loader. What a close
 * owes is the REGISTRATION, not the connection.
 */
export function clearGrowthModel(): void {
  desiredModel = null;
  structuresApi?.setGrowthModel(null);
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetStructuresBridge(): void {
  structuresApi = null;
  warned = false;
  desiredModel = null;
}
