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

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of fire this plugin uses — a registration, and its withdrawal. */
export interface FireFuelApi {
  registerEntityFuel(source: NamedFuelSource): void;
  unregisterEntityFuel(name: string): void;
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
  '[wildlife] fire plugin not available — animals will not burn';

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
  if (typeof module.registerEntityFuel !== 'function') return null;
  // BOTH HALVES OR NEITHER: a fire that cannot take a source back is not one
  // this bridge can safely hand a source to, because the registration would
  // then outlive the world it describes with no way to withdraw it.
  if (typeof module.unregisterEntityFuel !== 'function') return null;
  return module as unknown as FireFuelApi;
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
const bridge = createSiblingBridge<FireFuelApi>({
  pluginName: FIRE_PLUGIN_NAME,
  duckType: asFireApi,
  unavailableWarning: FIRE_UNAVAILABLE_WARNING,
  // Rule 3, buffer-don't-drop: what this plugin already wanted said,
  // replayed into a sibling that has only just started running.
  onResolved: (api): void => {
    if (pendingSource !== null) api.registerEntityFuel(pendingSource);
  },
});

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
 * must be picked up then. the bridge's warn-once keeps a permanently absent fire to one
 * line however often that happens.
 */
export function loadFireBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * Declares this plugin's flammable content to fire — now if fire is already
 * loaded, on arrival otherwise. Callers never branch on "is it loaded yet".
 */
export function registerWildlifeFuel(source: NamedFuelSource): void {
  const api = bridge.api();
  pendingSource = source;
  if (api !== null) api.registerEntityFuel(source);
}

/**
 * WITHDRAWS this plugin's registration as its world closes, from
 * `onWorldClose` (issue #208). plugins/flora/server/fire-bridge.ts carries the
 * reasoning for why the BRIDGE owns withdrawal rather than the plugin.
 */
export function closeFireBridge(): void {
  const api = bridge.api();
  // A no-op when fire never resolved, and harmless when fire has already
  // dropped every source in its own close hook: withdrawal is BY NAME, and a
  // name that is not registered is not an error.
  if (api !== null && pendingSource !== null) api.unregisterEntityFuel(pendingSource.name);
  bridge.clear();
  pendingSource = null;
}

/** Test seam: forgets the resolved sibling, the buffer and the warning. */
export function resetFireBridge(): void {
  bridge.reset();
  pendingSource = null;
}
