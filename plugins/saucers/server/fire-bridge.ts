// saucers → fire, via THE CROSS-PLUGIN DEPENDENCY PATTERN.
//
// plugins/flora/server/fire-bridge.ts is the canonical version of this file and
// carries the full reasoning; plugins/volcanoes/server/fire-bridge.ts is the
// nearest relative, because it too only CALLS fire rather than registering
// anything with it. A call has nothing to buffer (rule 3): a crash that happened
// while fire was absent is a crash nothing could have set alight, which is the
// correct outcome and not a dropped message.
//
// DEGRADED BEHAVIOUR when fire is absent: the wreck still leaves a crater, and
// the crater simply does not burn. One warning, once. That is exactly right for
// a self-hoster who removed the fire plugin — they removed fire, not saucers.

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
  '[saucers] fire plugin not available — a crash site will leave a crater but no flames';

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asFireApi(module: SiblingModule | null): FireIgnitionApi | null {
  if (module === null) return null;
  if (typeof module.igniteAt !== 'function') return null;
  return module as unknown as FireIgnitionApi;
}

const bridge = createSiblingBridge<FireIgnitionApi>({
  pluginName: FIRE_PLUGIN_NAME,
  duckType: asFireApi,
  unavailableWarning: FIRE_UNAVAILABLE_WARNING,
});

/**
 * Resolves fire through the host, from onWorldCreate. RE-RESOLVED ON EVERY CALL,
 * deliberately: onWorldCreate replays on a reopen and on a rollback, and a fire
 * the operator has just enabled for this world must be picked up then.
 */
export function loadFireBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * Tries to light one cell of the crash site. False when fire is not running, or
 * when nothing there would catch — which is the ORDINARY answer and not an
 * error: bare rock, water and a world already at the fire cap all give it, and a
 * crater's rim is mostly freshly-turned rock.
 *
 * ONE CELL AT A TIME, matching fire's own entry point rather than batching:
 * `igniteAt` already batches its broadcast internally (its `inIgnitionBatch`),
 * so a batching layer here would buy nothing and would have to know about fire's
 * cap to be correct.
 */
export function igniteCrashCell(x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) return false;
  return api.igniteAt(x, y);
}

/** Released when the world closes — a module-scope view must not outlive it. */
export function clearFireBridge(): void {
  bridge.clear();
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetFireBridge(): void {
  bridge.reset();
}
