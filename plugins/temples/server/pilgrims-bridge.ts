// temples → pilgrims, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules to the letter: ask the host by name, resolve synchronously,
// buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM PILGRIMS:
//   * canDispatchSettler() — whether a temple on this ground could ever send
//     anybody out, asked before a placement is accepted (owner, 2026-08-24:
//     "prevent placing the temple in a location where it cannot spawn a
//     settler").
//
// THE PAIR OF BRIDGES POINT BOTH WAYS ON PURPOSE, and neither direction is a
// copy of the other's numbers: pilgrims asks this plugin where the temple's
// door is, because only the building knows how wide it is; this plugin asks
// pilgrims whether the county around that door is settleable, because only the
// walker sim knows how far a settler goes, what it will cross and what it
// needs to find. Both go through the host's sibling lookup, so the cycle is a
// runtime question answered per session, not a load-order problem.
//
// There is nothing to buffer in either call: this bridge is a pure READ, so
// rule 3 costs nothing here.
//
// DEGRADED BEHAVIOUR when pilgrims is absent: PLACEMENT IS ALLOWED. That
// direction is deliberate and it is the only defensible one — a self-hoster
// who removed the pilgrims plugin removed settlers from the game, and refusing
// to let them build the temple as well would turn one missing feature into two.
// The gate exists to stop a temple being inert in a world that HAS settlers.
// One warning, once.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';
import type { TempleWorld } from './suitability.ts';

/** The temple as pilgrims sees it — the same shape its own bridge declares. */
export interface BridgedTempleSite {
  readonly x: number;
  readonly y: number;
  readonly doorX: number;
  readonly doorY: number;
}

/**
 * The slice of pilgrims this plugin uses — one function.
 *
 * `world` is passed straight through: pilgrims reads it through its own
 * PilgrimWorld interface, which the server's WorldApi satisfies. This plugin
 * declares its own narrower TempleWorld and never learns the difference, which
 * is the point of handing the object across rather than a copy of its data.
 */
export interface PilgrimsApi {
  canDispatchSettler(world: unknown, temple: BridgedTempleSite): boolean;
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
  '[temples] pilgrims plugin not available — placements are not settler-checked';

let pilgrimsApi: PilgrimsApi | null = null;
let warned = false;

function asPilgrimsApi(module: SiblingModule | null): PilgrimsApi | null {
  if (module === null) return null;
  if (typeof module.canDispatchSettler !== 'function') return null;
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
 * Would a temple here ever send a settler out? TRUE while pilgrims is absent
 * or still loading — see this file's header for why the doubt resolves in the
 * player's favour rather than against the placement.
 */
export function templeCanSettle(world: TempleWorld, temple: BridgedTempleSite): boolean {
  if (pilgrimsApi === null) return true;
  return pilgrimsApi.canDispatchSettler(world, temple);
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetPilgrimsBridge(): void {
  pilgrimsApi = null;
  warned = false;
}
