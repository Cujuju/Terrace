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
// the registration is desired state. If the dynamic import has not resolved
// when flora's world is created — the ordinary case, since the import is
// started and not awaited — the source is held and replayed the moment the
// module arrives. Without that, whether the forest could burn would depend on
// module-resolution timing.
//
// DEGRADED BEHAVIOUR when fire is absent: trees do not burn. One warning is
// logged, once. A self-hoster who deleted the fire plugin deleted fire, not a
// working forest.

/** The slice of fire this plugin uses — one function, deliberately. */
export interface FireFuelApi {
  registerFuel(source: unknown): void;
}

/** Loads the fire module. Swappable so tests can exercise the absent path. */
export type FireModuleLoader = () => Promise<unknown>;

/**
 * The real loader. Relative to this file, resolving to the sibling plugin
 * folder — a bare dynamic import rather than a package name because plugins
 * are folders on disk in v1 (see mana-bridge.ts's header).
 */
const DEFAULT_FIRE_MODULE_LOADER: FireModuleLoader = () => import('../../fire/server/index.ts');

export const FIRE_UNAVAILABLE_WARNING =
  '[flora] fire plugin not available — trees and crops will not burn';

let loadModule: FireModuleLoader = DEFAULT_FIRE_MODULE_LOADER;

/** The resolved API, or null while loading / after a failed load. */
let fireApi: FireFuelApi | null = null;

/** In-flight (or settled) load. Non-null once loadFireBridge has been called. */
let loadPromise: Promise<void> | null = null;

/** True once the "fire is missing" warning has been emitted. */
let warned = false;

/**
 * RULE 3'S BUFFER. The registration flora wants fire to have, held until fire
 * exists. One slot, not a queue: a second registration REPLACES the first,
 * because there is only ever one answer to "what of flora's is flammable" and
 * replaying a stale one would be worse than replaying none.
 */
let pendingSource: unknown = null;

/** Duck-types a loaded module into the API we need (rule 4). */
function asFireApi(module: unknown): FireFuelApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<FireFuelApi>;
  if (typeof candidate.registerFuel !== 'function') return null;
  return candidate as FireFuelApi;
}

function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(FIRE_UNAVAILABLE_WARNING);
}

/**
 * Starts the load (rule 2: called from onWorldCreate, NOT awaited) and replays
 * whatever registration is pending once it settles.
 */
export function loadFireBridge(): void {
  if (loadPromise !== null) return;

  loadPromise = loadModule()
    .then((module) => {
      fireApi = asFireApi(module);
      if (fireApi === null) {
        warnOnce();
        return;
      }
      if (pendingSource !== null) fireApi.registerFuel(pendingSource);
    })
    .catch(() => {
      fireApi = null;
      warnOnce();
    });
}

/**
 * Declares flora's flammable content to fire — now if fire is already loaded,
 * on arrival otherwise. Callers never branch on "is it loaded yet" (rule 3).
 */
export function registerFloraFuel(source: unknown): void {
  pendingSource = source;
  if (fireApi !== null) fireApi.registerFuel(source);
}

/** Test seam: forgets the load, the buffer and the warning. */
export function resetFireBridge(loader: FireModuleLoader = DEFAULT_FIRE_MODULE_LOADER): void {
  loadModule = loader;
  fireApi = null;
  loadPromise = null;
  warned = false;
  pendingSource = null;
}
