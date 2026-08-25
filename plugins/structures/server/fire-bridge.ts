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

/** The slice of fire this plugin uses — one function, deliberately. */
export interface FireFuelApi {
  registerFuel(source: unknown): void;
}

/** Loads the fire module. Swappable so tests can exercise the absent path. */
export type FireModuleLoader = () => Promise<unknown>;

/** The real loader — the sibling plugin folder, since plugins are folders in v1. */
const DEFAULT_FIRE_MODULE_LOADER: FireModuleLoader = () => import('../../fire/server/index.ts');

export const FIRE_UNAVAILABLE_WARNING =
  '[structures] fire plugin not available — buildings will not burn';

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
  if (typeof candidate.registerFuel !== 'function') return null;
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
      if (pendingSource !== null) fireApi.registerFuel(pendingSource);
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
export function registerStructuresFuel(source: unknown): void {
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
