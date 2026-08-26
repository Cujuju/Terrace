// flora → fire, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules to the letter).
//
// THE DIRECTION IS THE POINT. Both existing bridges READ from a sibling
// (relics reads mana's perk API, flora reads structures' occupancy). This one
// WRITES: it hands `fire` a description of everything flammable flora owns.
//
// That inversion is deliberate and it belongs to fire's design, not to flora's
// convenience — see plugins/fire/server/fuel.ts's header. If `fire` reached out
// to each flammable plugin instead, `fire` would need a new bridge, and a new
// edit, for every burnable thing ever added to the game. Registering inward
// means a plugin that catches fire says so itself, and `fire` never changes.
//
// RULE 3 ("buffer, don't drop") THEREFORE LANDS HERE, and it is load-bearing:
// the registration is desired state. It is recorded whether or not fire is in
// hand and replayed the moment one is — which covers a registration made
// before this bridge resolves, and a fire the operator only switches on for a
// later session.
//
// DEGRADED BEHAVIOUR when fire is absent: trees do not burn. One warning is
// logged, once. A self-hoster who deleted the fire plugin deleted fire, not a
// working forest.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of fire this plugin uses — one function, deliberately. */
export interface FireFuelApi {
  registerFuel(source: unknown): void;
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
  '[flora] fire plugin not available — trees and crops will not burn';

/** The resolved API, or null when fire is not running in this session. */
let fireApi: FireFuelApi | null = null;

/** True once the "fire is missing" warning has been emitted. */
let warned = false;

/**
 * RULE 3'S BUFFER. The registration flora wants fire to have, held until fire
 * exists. One slot, not a queue: a second registration REPLACES the first,
 * because there is only ever one answer to "what of flora's is flammable" and
 * replaying a stale one would be worse than replaying none.
 */
let pendingSource: unknown = null;

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asFireApi(module: SiblingModule | null): FireFuelApi | null {
  if (module === null) return null;
  if (typeof module.registerFuel !== 'function') return null;
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
  if (pendingSource !== null) fireApi.registerFuel(pendingSource);
}

/**
 * Declares flora's flammable content to fire — now if fire is already loaded,
 * on arrival otherwise. Callers never branch on "is it loaded yet" (rule 3).
 */
export function registerFloraFuel(source: unknown): void {
  pendingSource = source;
  if (fireApi !== null) fireApi.registerFuel(source);
}

/** Test seam: forgets the resolved sibling, the buffer and the warning. */
export function resetFireBridge(): void {
  fireApi = null;
  warned = false;
  pendingSource = null;
}
