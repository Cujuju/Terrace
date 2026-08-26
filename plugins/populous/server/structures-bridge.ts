// populous → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules to the letter: dynamic import, started-not-awaited,
// buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM STRUCTURES: one function. `setGrowthModel(model)`
// — the growth-model seam (that plugin's server/growth-model.ts). Registering
// is the whole of this plugin's relationship with the board: structures then
// calls the registered model once per generation interval and applies whatever
// it returns.
//
// DEGRADED BEHAVIOUR when structures is absent, or is a build from before the
// seam existed: nothing happens at all — there is no board to grow, so there
// is nothing this plugin could do with one. One warning is logged, once.
//
// BUFFER, DON'T DROP (rule 3): the model is registered into a structures module
// that finishes loading after this plugin's onWorldCreate has already run.

/** The slice of structures this plugin uses — deliberately one function. */
export interface StructuresGrowthApi {
  setGrowthModel(model: unknown): void;
}

export type StructuresModuleLoader = () => Promise<unknown>;

const DEFAULT_STRUCTURES_MODULE_LOADER: StructuresModuleLoader = () =>
  import('../../structures/server/index.ts');

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[populous] structures plugin not available (or too old for the growth-model seam) — nothing to grow';

let loadModule: StructuresModuleLoader = DEFAULT_STRUCTURES_MODULE_LOADER;
let structuresApi: StructuresGrowthApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

/** The model this plugin wants registered — rule 3's buffer. */
let desiredModel: unknown = null;

function asStructuresGrowthApi(module: unknown): StructuresGrowthApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<StructuresGrowthApi>;
  if (typeof candidate.setGrowthModel !== 'function') return null;
  return candidate as StructuresGrowthApi;
}

function warnUnavailable(error?: unknown): void {
  if (warned) return;
  warned = true;
  if (error === undefined) console.warn(STRUCTURES_UNAVAILABLE_WARNING);
  else console.warn(STRUCTURES_UNAVAILABLE_WARNING, error);
}

/** Starts (once) the load. Always resolves — absence is an outcome, not an error. */
export function loadStructuresBridge(): Promise<void> {
  if (loadPromise !== null) return loadPromise;

  loadPromise = loadModule()
    .then((module) => {
      const resolved = asStructuresGrowthApi(module);
      if (resolved === null) {
        warnUnavailable();
        return;
      }
      structuresApi = resolved;
      if (desiredModel !== null) resolved.setGrowthModel(desiredModel);
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

/** Records and forwards the model this plugin wants driving the board. */
export function registerGrowthModel(model: unknown): void {
  desiredModel = model;
  structuresApi?.setGrowthModel(model);
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
  desiredModel = null;
}
