// structures → fire, via THE CROSS-PLUGIN DEPENDENCY PATTERN.
//
// plugins/flora/server/fire-bridge.ts is the canonical version of this file and
// carries the full reasoning — why the dependency runs INWARD (a plugin that
// burns tells `fire` so, rather than `fire` growing a bridge per flammable
// thing), and why rule 3's buffer therefore lands on the registrant. This is
// that file with one word changed, because a building burns for exactly the
// same reasons a tree does.
//
// DEGRADED BEHAVIOUR when fire is absent: buildings do not burn. One warning,
// once. A self-hoster who deleted the fire plugin deleted fire, not the town.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of fire this plugin uses — a registration, and its withdrawal. */
export interface FireFuelApi {
  registerFuel(source: NamedFuelSource): void;
  unregisterFuel(name: string): void;
}

/**
 * What the BRIDGE itself needs to know about a registration: its NAME, which
 * is the key fire's registry is stored under and therefore the whole of what
 * withdrawal takes. Everything else stays opaque — what a fuel source is made
 * of is fire's business (rule 4), not this file's.
 */
export interface NamedFuelSource {
  readonly name: string;
  readonly [field: string]: unknown;
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
  '[structures] fire plugin not available — buildings will not burn';

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
let pendingSource: NamedFuelSource | null = null;

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asFireApi(module: SiblingModule | null): FireFuelApi | null {
  if (module === null) return null;
  if (typeof module.registerFuel !== 'function') return null;
  // BOTH HALVES OR NEITHER: a fire that cannot take a source back is not one
  // this bridge can safely hand a source to, because the registration would
  // then outlive the world it describes with no way to withdraw it.
  if (typeof module.unregisterFuel !== 'function') return null;
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
 * Declares this plugin's flammable content to fire — now if fire is already
 * loaded, on arrival otherwise. Callers never branch on "is it loaded yet".
 */
export function registerStructuresFuel(source: NamedFuelSource): void {
  pendingSource = source;
  if (fireApi !== null) fireApi.registerFuel(source);
}

/**
 * WITHDRAWS this plugin's registration as its world closes, from
 * `onWorldClose` (issue #208). plugins/flora/server/fire-bridge.ts carries the
 * reasoning for why the BRIDGE owns withdrawal rather than the plugin.
 */
export function closeFireBridge(): void {
  // A no-op when fire never resolved, and harmless when fire has already
  // dropped every source in its own close hook: withdrawal is BY NAME, and a
  // name that is not registered is not an error.
  if (fireApi !== null && pendingSource !== null) fireApi.unregisterFuel(pendingSource.name);
  fireApi = null;
  pendingSource = null;
}

/** Test seam: forgets the resolved sibling, the buffer and the warning. */
export function resetFireBridge(): void {
  fireApi = null;
  warned = false;
  pendingSource = null;
}
