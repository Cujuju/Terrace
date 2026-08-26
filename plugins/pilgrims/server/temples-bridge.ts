// pilgrims → temples, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file is the
// pattern's third use here and follows its four rules to the letter: dynamic
// import, started-not-awaited, buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM TEMPLES:
//   * standingTemple() — where the player's temple is, because that is where
//     settlers walk out from (settling.ts).
//
// There is nothing to buffer in the other direction: this bridge is a pure
// READ, so rule 3 costs nothing here — a temple that goes up before the module
// finishes loading is simply seen on the first tick after it does.
//
// DEGRADED BEHAVIOUR when temples is absent: there is no temple, so no
// settlers ever walk — which is exactly true. One warning, once. A self-hoster
// who removed the temples plugin removed the building, not a working pilgrims
// plugin.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** Where the temple stands, structurally typed (never imported). */
export interface BridgedTemple {
  readonly x: number;
  readonly y: number;
  /**
   * The temple's DOOR, in fractional cell coordinates — where a settler
   * stands the instant it steps outside.
   *
   * IT TRAVELS RATHER THAN BEING DERIVED because deriving it needs the
   * temple's footprint span, and a plugin may not import another's constants.
   * Without it a settler spawns on the temple's own cell, which is the CENTRE
   * of a building eight cells across — buried in the masonry, emerging through
   * the wall (owner, 2026-08-24: "they're definitely not").
   *
   * OPTIONAL: a temples build from before 2026-08-24 does not send it, and
   * `bridgedTemple` degrades to the old cell-centre spawn rather than to no
   * settlers at all — the same additive-field rule `age` keeps in the
   * structures bridge.
   */
  readonly doorX?: number;
  readonly doorY?: number;
}

/** The slice of temples this plugin uses — one function. */
export interface TemplesApi {
  standingTemple(): BridgedTemple | null;
}

/**
 * The name the host knows temples by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196). The host hands back the plugin RUNNING
 * as `temples` in this session, so a temples that is absent OR disabled for
 * this world resolves to null; the old dynamic import bound to a module
 * URL, and therefore answered from the process's module map either way.
 */
const TEMPLES_PLUGIN_NAME = 'temples';

export const TEMPLES_UNAVAILABLE_WARNING =
  '[pilgrims] temples plugin not available — no temple means no settlers';

let templesApi: TemplesApi | null = null;
let warned = false;

function asTemplesApi(module: SiblingModule | null): TemplesApi | null {
  if (module === null) return null;
  if (typeof module.standingTemple !== 'function') return null;
  return module as unknown as TemplesApi;
}

function warnUnavailable(): void {
  if (warned) return;
  warned = true;
  console.warn(TEMPLES_UNAVAILABLE_WARNING);
}

/**
 * Resolves temples through the host, from onWorldCreate.
 *
 * SYNCHRONOUS, AND THERE IS NOTHING LEFT TO AWAIT. The old rule 2 (start the
 * import, do not await it) and the promise it returned existed because module
 * resolution is asynchronous; the host's lookup is not, and it answers whatever
 * the load order — so the sibling is either in hand when this returns or is not
 * running in this world at all.
 *
 * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
 * and on a rollback, and a temples the operator has just enabled must be
 * picked up then. The warning still happens at most once.
 */
export function loadTemplesBridge(world: WorldApi): void {
  const resolved = asTemplesApi(world.sibling(TEMPLES_PLUGIN_NAME));
  if (resolved === null) {
    // CLEARED, not left standing: this runs again on every reopen, and a
    // sibling that WAS running and is not any more (the operator disabled it)
    // must stop being reachable through a stale reference here.
    templesApi = null;
    warnUnavailable();
    return;
  }
  templesApi = resolved;
}

/**
 * The standing temple, or null while temples is absent, still loading, or
 * simply has no temple built yet. All three mean the same thing to the settler
 * sim — nobody walks out today — so they are deliberately one answer.
 */
export function bridgedTemple(): BridgedTemple | null {
  return templesApi?.standingTemple() ?? null;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetTemplesBridge(): void {
  templesApi = null;
  warned = false;
}
