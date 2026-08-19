// flora → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules to the letter: dynamic import, started-not-awaited,
// duck-type the module. Rule 3, "buffer, don't drop", does not apply here —
// unlike relics→mana or pilgrims→structures, this bridge never WRITES
// anything into structures, so there is no desired state to replay into a
// late-arriving module).
//
// WHAT THIS PLUGIN NEEDS FROM STRUCTURES:
//   * standingStructures() — every cell a building currently occupies, so
//     the forest survey can treat it as unplantable and cull whatever
//     already stands there (see ./forest.ts's isOccupied parameter and
//     ./index.ts's occupiedCells).
//
// DEGRADED BEHAVIOUR when structures is absent: no buildings exist, so
// nothing is ever excluded from the forest — which is exactly true. One
// warning is logged, once. A self-hoster who removed the structures plugin
// removed buildings, not a working flora plugin.

/** One occupied cell, structurally typed (never imported). */
export interface BridgedStructureCell {
  readonly x: number;
  readonly y: number;
}

/** The slice of structures this plugin uses — deliberately tiny, read-only. */
export interface StructuresApi {
  standingStructures(): BridgedStructureCell[];
}

export type StructuresModuleLoader = () => Promise<unknown>;

/**
 * The real loader. Relative to this file, resolving to the sibling plugin
 * folder — a bare dynamic import rather than a package name because plugins
 * are folders on disk in v1 (see mana-bridge.ts's header).
 */
const DEFAULT_STRUCTURES_MODULE_LOADER: StructuresModuleLoader = () =>
  import('../../structures/server/index.ts');

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[flora] structures plugin not available — no buildings means nothing excludes trees';

let loadModule: StructuresModuleLoader = DEFAULT_STRUCTURES_MODULE_LOADER;

/** The resolved API, or null while loading / after a failed load. */
let structuresApi: StructuresApi | null = null;

/** In-flight (or settled) load. Non-null once loadStructuresBridge has been called. */
let loadPromise: Promise<void> | null = null;

/** True once the "structures is missing" warning has been emitted. */
let warned = false;

/** Duck-types a loaded module into the API we need. Null if it does not fit. */
function asStructuresApi(module: unknown): StructuresApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<StructuresApi>;
  if (typeof candidate.standingStructures !== 'function') return null;
  return candidate as StructuresApi;
}

function warnUnavailable(error?: unknown): void {
  if (warned) return;
  warned = true;
  // console rather than the server's logger — see mana-bridge.ts's identical
  // note: plugins do not import server internals at runtime.
  if (error === undefined) console.warn(STRUCTURES_UNAVAILABLE_WARNING);
  else console.warn(STRUCTURES_UNAVAILABLE_WARNING, error);
}

/**
 * Starts (once) the load of the structures plugin's occupancy API.
 *
 * Returns a promise that ALWAYS resolves — a missing or incompatible
 * structures is a documented outcome, not an error to propagate. Callers do
 * not need to await it; onWorldCreate deliberately does not. Tests do, via
 * structuresBridgeReady().
 */
export function loadStructuresBridge(): Promise<void> {
  if (loadPromise !== null) return loadPromise;

  loadPromise = loadModule()
    .then((module) => {
      const resolved = asStructuresApi(module);
      if (resolved === null) {
        warnUnavailable();
        return;
      }
      structuresApi = resolved;
    })
    .catch((error: unknown) => {
      warnUnavailable(error);
    });

  return loadPromise;
}

/** Resolves when the load has settled, whichever way. Test/boot-order seam. */
export function structuresBridgeReady(): Promise<void> {
  return loadPromise ?? Promise.resolve();
}

/** The occupied cells, or an empty world while structures is absent/loading. */
export function bridgedStructures(): BridgedStructureCell[] {
  return structuresApi?.standingStructures() ?? [];
}

/** Test seam: swaps the loader. Pass null to restore the real one. */
export function setStructuresModuleLoader(loader: StructuresModuleLoader | null): void {
  loadModule = loader ?? DEFAULT_STRUCTURES_MODULE_LOADER;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetStructuresBridge(): void {
  loadModule = DEFAULT_STRUCTURES_MODULE_LOADER;
  structuresApi = null;
  loadPromise = null;
  warned = false;
}
