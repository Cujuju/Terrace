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

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
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
  '[flora] fire plugin not available — trees and crops will not burn';

/**
 * RULE 3'S BUFFER. The registration flora wants fire to have, held until fire
 * exists. One slot, not a queue: a second registration REPLACES the first,
 * because there is only ever one answer to "what of flora's is flammable" and
 * replaying a stale one would be worse than replaying none.
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
    if (pendingSource !== null) api.registerFuel(pendingSource);
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
 * Declares flora's flammable content to fire — now if fire is already loaded,
 * on arrival otherwise. Callers never branch on "is it loaded yet" (rule 3).
 */
export function registerFloraFuel(source: NamedFuelSource): void {
  const api = bridge.api();
  pendingSource = source;
  if (api !== null) api.registerFuel(source);
}

/**
 * WITHDRAWS this plugin's registration as its world closes — the bridge's half
 * of session.ts's close contract, and what makes that contract something a
 * registrant can no longer forget (issue #208).
 *
 * WHY THE BRIDGE OWNS THIS AND NOT THE PLUGIN. Registering is push-shaped:
 * what lands in fire is a CALLBACK over this module's live state, and fire's
 * `sources` array is module scope, so it goes on being asked every spread step
 * for as long as the process lives — through world switches, plugin toggles
 * and rollbacks alike. A PULL-style bridge (./structures-bridge.ts) needs
 * nothing like this: it re-resolves its sibling on every onWorldCreate and
 * clears itself when the sibling is gone. A push-style one has already handed
 * something over, so somebody has to hand it back — and the only somebody that
 * cannot forget is the file that pushed it, because a plugin that is disabled
 * for the next session never gets an onWorldCreate to notice anything in.
 *
 * `warned` deliberately survives: a permanently absent fire is worth one line,
 * however many worlds open and close over it.
 */
export function closeFireBridge(): void {
  const api = bridge.api();
  // A no-op when fire never resolved, and harmless when fire has already
  // dropped every source in its own close hook: withdrawal is BY NAME, and a
  // name that is not registered is not an error.
  if (api !== null && pendingSource !== null) api.unregisterFuel(pendingSource.name);
  bridge.clear();
  pendingSource = null;
}

/** Test seam: forgets the resolved sibling, the buffer and the warning. */
export function resetFireBridge(): void {
  bridge.reset();
  pendingSource = null;
}
