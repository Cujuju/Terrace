// populous → pilgrims, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts owns the pattern's four rules).
//
// WHAT THIS PLUGIN NEEDS FROM PILGRIMS: one function.
// `emitSettlerFrom(x, y)` — a settler walks out of the house at that cell and
// goes off to found the next one. THAT SETTLER IS PILGRIMS' SETTLER, the same
// one a temple sends out: one walker rule, one model set, one wire (see that
// plugin's settling.ts header). This plugin creates no people of its own, and
// that is the whole reason this bridge exists rather than a walker here.
//
// DEGRADED BEHAVIOUR when pilgrims is absent: houses fill up and simply never
// send anybody out, so a settlement stops spreading — which is exactly true,
// because there is nobody in this world to walk. The board itself keeps
// growing and shrinking with the terrain. One warning is logged, once.
//
// NO BUFFER HERE, unlike ./structures-bridge.ts: an emission is a MOMENT, not
// a desired state. A settler nobody could send while the bridge was loading is
// a settler that did not leave that step; the next step's house will ask
// again. Replaying it later would put somebody on the road on behalf of a
// house that may no longer be standing.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of pilgrims this plugin uses — deliberately one function. */
export interface PilgrimsApi {
  emitSettlerFrom(x: number, y: number): boolean;
}

/**
 * The name the host knows pilgrims by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196). The host hands back the plugin RUNNING
 * as `pilgrims` in this session, so a pilgrims that is absent OR disabled for
 * this world resolves to null; the old dynamic import bound to a module
 * URL, and therefore answered from the process's module map either way.
 */
const PILGRIMS_PLUGIN_NAME = 'pilgrims';

export const PILGRIMS_UNAVAILABLE_WARNING =
  '[populous] pilgrims plugin not available — houses will fill up but nobody walks out';

let pilgrimsApi: PilgrimsApi | null = null;
let warned = false;

function asPilgrimsApi(module: SiblingModule | null): PilgrimsApi | null {
  if (module === null) return null;
  if (typeof module.emitSettlerFrom !== 'function') return null;
  return module as unknown as PilgrimsApi;
}

function warnUnavailable(): void {
  if (warned) return;
  warned = true;
  console.warn(PILGRIMS_UNAVAILABLE_WARNING);
}

/**
 * Resolves pilgrims through the host, from onWorldCreate.
 *
 * SYNCHRONOUS, AND THERE IS NOTHING LEFT TO AWAIT. The old rule 2 (start the
 * import, do not await it) and the promise it returned existed because module
 * resolution is asynchronous; the host's lookup is not, and it answers whatever
 * the load order — so the sibling is either in hand when this returns or is not
 * running in this world at all.
 *
 * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
 * and on a rollback, and a pilgrims the operator has just enabled must be
 * picked up then. The warning still happens at most once.
 */
export function loadPilgrimsBridge(world: WorldApi): void {
  const resolved = asPilgrimsApi(world.sibling(PILGRIMS_PLUGIN_NAME));
  if (resolved === null) {
    // CLEARED, not left standing: this runs again on every reopen, and a
    // sibling that WAS running and is not any more (the operator disabled it)
    // must stop being reachable through a stale reference here.
    pilgrimsApi = null;
    warnUnavailable();
    return;
  }
  pilgrimsApi = resolved;
}

/**
 * Asks pilgrims to send one settler out of the house at (x, y).
 *
 * FALSE IS AN ORDINARY ANSWER: pilgrims is absent, is still loading, is an
 * older build without the entry point, the walker crowd is at its cap, or
 * nowhere in that house's county is both reachable and buildable. The caller
 * treats every one of those the same way — nobody left the house this step.
 */
export function emitSettlerFrom(x: number, y: number): boolean {
  return pilgrimsApi?.emitSettlerFrom(x, y) ?? false;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetPilgrimsBridge(): void {
  pilgrimsApi = null;
  warned = false;
}
