// volcanoes → fire, via THE CROSS-PLUGIN DEPENDENCY PATTERN.
//
// plugins/flora/server/fire-bridge.ts is the canonical version of this file and
// carries the full reasoning. THE DIFFERENCE HERE is the direction of the call:
// flora, structures and boats REGISTER something with fire and therefore need
// rule 3's buffer (a registration held until fire exists). This plugin only
// CALLS fire, once per newly molten cell, and a call has nothing to buffer — a
// cell that went molten while fire was absent is a cell nothing could have lit,
// which is the correct outcome and not a dropped message.
//
// DEGRADED BEHAVIOUR when fire is absent: lava does not set anything alight. It
// still flows, still cools, still rewrites the ground. One warning, once.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of fire this plugin uses — one function, deliberately. */
export interface FireIgnitionApi {
  igniteAt(x: number, y: number): boolean;
}

/**
 * The name the host knows fire by — the key `WorldApi.sibling` answers to. A
 * NAME, NOT A PATH: the host hands back the plugin RUNNING as `fire` in this
 * session, so a fire the operator disabled for this world resolves to null
 * instead of answering from the process's module map (issue #196).
 */
const FIRE_PLUGIN_NAME = 'fire';

export const FIRE_UNAVAILABLE_WARNING =
  '[volcanoes] fire plugin not available — lava will not set anything alight';

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asFireApi(module: SiblingModule | null): FireIgnitionApi | null {
  if (module === null) return null;
  if (typeof module.igniteAt !== 'function') return null;
  return module as unknown as FireIgnitionApi;
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
const bridge = createSiblingBridge<FireIgnitionApi>({
  pluginName: FIRE_PLUGIN_NAME,
  duckType: asFireApi,
  unavailableWarning: FIRE_UNAVAILABLE_WARNING,
});

/**
 * Resolves fire through the host, from onWorldCreate. RE-RESOLVED ON EVERY
 * CALL, deliberately: onWorldCreate replays on a reopen and on a rollback, and
 * a fire the operator has just enabled for this world must be picked up then.
 */
export function loadFireBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * Tries to set fire to whatever is standing on a cell the lava has just
 * reached. False when fire is not running, or when nothing there would catch —
 * which is the ORDINARY answer, not an error: bare rock and water both give it,
 * and a lava flow crosses a great deal of both.
 *
 * ONE CELL AT A TIME, matching fire's own entry point rather than batching:
 * `igniteAt` already batches its broadcast internally (its `inIgnitionBatch`),
 * so a batching layer here would buy nothing and would have to know about
 * fire's cap to be correct.
 */
export function igniteLavaCell(x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) return false;
  return api.igniteAt(x, y);
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetFireBridge(): void {
  bridge.reset();
}
