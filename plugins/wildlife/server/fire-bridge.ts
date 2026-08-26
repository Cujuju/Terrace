// wildlife → fire, via THE CROSS-PLUGIN DEPENDENCY PATTERN.
//
// plugins/flora/server/fire-bridge.ts is the canonical version of this file and
// carries the full reasoning — why the dependency runs INWARD, and why rule 3's
// buffer therefore lands on the registrant.
//
// THE ONE DIFFERENCE from flora's and structures': this plugin registers into
// fire's ENTITY registry rather than its cell registry, because an animal walks
// (plugins/fire/server/entityFuel.ts's header on why those are two registries
// and not one). The bridge itself is unchanged — it loads a sibling, buffers
// one registration and replays it — because which registry the payload is for
// is fire's business, not the bridge's.
//
// DEGRADED BEHAVIOUR when fire is absent: animals do not burn. One warning,
// once.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of fire this plugin uses — one function, deliberately. */
export interface FireFuelApi {
  registerEntityFuel(source: unknown): void;
}

/**
 * The name the host knows fire by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH, and that is the whole of this phase: the host hands back
 * the plugin RUNNING as `fire` in this session, so a fire that is disabled
 * here (or absent) resolves to null instead of answering from the module map
 * (issue #196).
 */
const FIRE_PLUGIN_NAME = 'fire';

export const FIRE_UNAVAILABLE_WARNING =
  '[wildlife] fire plugin not available — animals will not burn';

/** The resolved API, or null when fire is not running in this session. */
let fireApi: FireFuelApi | null = null;

/** True once the "fire is missing" warning has been emitted. */
let warned = false;

/**
 * RULE 3'S BUFFER — the registration this plugin wants fire to have, held until
 * fire exists. One slot, not a queue: there is only ever one answer to "what of
 * this plugin's is flammable", and replaying a stale one would be worse than
 * replaying none.
 */
let pendingSource: unknown = null;

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asFireApi(module: SiblingModule | null): FireFuelApi | null {
  if (module === null) return null;
  if (typeof module.registerEntityFuel !== 'function') return null;
  return module as unknown as FireFuelApi;
}

function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(FIRE_UNAVAILABLE_WARNING);
}

/**
 * Resolves fire through the host, from onWorldCreate.
 *
 * NOTHING IS IN FLIGHT ANY MORE. The old rule 2 (start the import, do not
 * await it) existed because module resolution is asynchronous; the host's
 * lookup is not, and answers whatever the load order, so the sibling is
 * either in hand when this returns or is not running at all. Whatever
 * registration is pending is replayed here.
 *
 * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
 * and on a rollback, and a fire the operator has just enabled for this world
 * must be picked up then. `warnOnce` keeps a permanently absent fire to one
 * line however often that happens.
 */
export function loadFireBridge(world: WorldApi): void {
  fireApi = asFireApi(world.sibling(FIRE_PLUGIN_NAME));
  if (fireApi === null) {
    warnOnce();
    return;
  }
  if (pendingSource !== null) fireApi.registerEntityFuel(pendingSource);
}

/**
 * Declares this plugin's flammable content to fire — now if fire is already
 * loaded, on arrival otherwise. Callers never branch on "is it loaded yet".
 */
export function registerWildlifeFuel(source: unknown): void {
  pendingSource = source;
  if (fireApi !== null) fireApi.registerEntityFuel(source);
}

/** Test seam: forgets the resolved sibling, the buffer and the warning. */
export function resetFireBridge(): void {
  fireApi = null;
  warned = false;
  pendingSource = null;
}
