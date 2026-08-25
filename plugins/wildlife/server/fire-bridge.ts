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

/** The slice of fire this plugin uses — one function, deliberately. */
export interface FireFuelApi {
  registerEntityFuel(source: unknown): void;
}

/** Loads the fire module. Swappable so tests can exercise the absent path. */
export type FireModuleLoader = () => Promise<unknown>;

/** The real loader — the sibling plugin folder, since plugins are folders in v1. */
const DEFAULT_FIRE_MODULE_LOADER: FireModuleLoader = () => import('../../fire/server/index.ts');

export const FIRE_UNAVAILABLE_WARNING =
  '[wildlife] fire plugin not available — animals will not burn';

let loadModule: FireModuleLoader = DEFAULT_FIRE_MODULE_LOADER;

/** The resolved API, or null while loading / after a failed load. */
let fireApi: FireFuelApi | null = null;

/** In-flight (or settled) load. Non-null once loadFireBridge has been called. */
let loadPromise: Promise<void> | null = null;

/** True once the "fire is missing" warning has been emitted. */
let warned = false;

/**
 * RULE 3'S BUFFER — the registration this plugin wants fire to have, held until
 * fire exists. One slot, not a queue: there is only ever one answer to "what of
 * this plugin's is flammable", and replaying a stale one would be worse than
 * replaying none.
 */
let pendingSource: unknown = null;

/** Duck-types a loaded module into the API we need (rule 4). */
function asFireApi(module: unknown): FireFuelApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<FireFuelApi>;
  if (typeof candidate.registerEntityFuel !== 'function') return null;
  return candidate as FireFuelApi;
}

function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(FIRE_UNAVAILABLE_WARNING);
}

/** Starts the load (rule 2: called from onWorldCreate, NOT awaited). */
export function loadFireBridge(): void {
  if (loadPromise !== null) return;

  loadPromise = loadModule()
    .then((module) => {
      fireApi = asFireApi(module);
      if (fireApi === null) {
        warnOnce();
        return;
      }
      if (pendingSource !== null) fireApi.registerEntityFuel(pendingSource);
    })
    .catch(() => {
      fireApi = null;
      warnOnce();
    });
}

/**
 * Declares this plugin's flammable content to fire — now if fire is already
 * loaded, on arrival otherwise. Callers never branch on "is it loaded yet".
 */
export function registerWildlifeFuel(source: unknown): void {
  pendingSource = source;
  if (fireApi !== null) fireApi.registerEntityFuel(source);
}

/** Test seam: forgets the load, the buffer and the warning. */
export function resetFireBridge(loader: FireModuleLoader = DEFAULT_FIRE_MODULE_LOADER): void {
  loadModule = loader;
  fireApi = null;
  loadPromise = null;
  warned = false;
  pendingSource = null;
}
