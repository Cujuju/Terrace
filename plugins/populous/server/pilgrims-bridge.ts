// populous → pilgrims, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts owns the pattern's four rules).
//
// WHAT THIS PLUGIN NEEDS FROM PILGRIMS: one function.
// `emitSettlerFrom(x, y)` — a settler walks out of the house at that cell and
// goes off to found the next one. THAT SETTLER IS PILGRIMS' SETTLER, the same
// one a temple sends out: one walker rule, one model set, one wire (see that
// plugin's settling.ts header). This plugin creates no people of its own, and
// that is the whole reason this bridge exists rather than a walker here.
//
// DEGRADED BEHAVIOUR when pilgrims is absent: houses fill up and simply never
// send anybody out, so a settlement stops spreading — which is exactly true,
// because there is nobody in this world to walk. The board itself keeps
// growing and shrinking with the terrain. One warning is logged, once.
//
// NO BUFFER HERE, unlike ./structures-bridge.ts: an emission is a MOMENT, not
// a desired state. A settler nobody could send while the bridge was loading is
// a settler that did not leave that step; the next step's house will ask
// again. Replaying it later would put somebody on the road on behalf of a
// house that may no longer be standing.

/** The slice of pilgrims this plugin uses — deliberately one function. */
export interface PilgrimsApi {
  emitSettlerFrom(x: number, y: number): boolean;
}

export type PilgrimsModuleLoader = () => Promise<unknown>;

const DEFAULT_PILGRIMS_MODULE_LOADER: PilgrimsModuleLoader = () =>
  import('../../pilgrims/server/index.ts');

export const PILGRIMS_UNAVAILABLE_WARNING =
  '[populous] pilgrims plugin not available — houses will fill up but nobody walks out';

let loadModule: PilgrimsModuleLoader = DEFAULT_PILGRIMS_MODULE_LOADER;
let pilgrimsApi: PilgrimsApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

function asPilgrimsApi(module: unknown): PilgrimsApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<PilgrimsApi>;
  if (typeof candidate.emitSettlerFrom !== 'function') return null;
  return candidate as PilgrimsApi;
}

function warnUnavailable(error?: unknown): void {
  if (warned) return;
  warned = true;
  if (error === undefined) console.warn(PILGRIMS_UNAVAILABLE_WARNING);
  else console.warn(PILGRIMS_UNAVAILABLE_WARNING, error);
}

/** Starts (once) the load. Always resolves — absence is an outcome, not an error. */
export function loadPilgrimsBridge(): Promise<void> {
  if (loadPromise !== null) return loadPromise;

  loadPromise = loadModule()
    .then((module) => {
      const resolved = asPilgrimsApi(module);
      if (resolved === null) {
        warnUnavailable();
        return;
      }
      pilgrimsApi = resolved;
    })
    .catch((error: unknown) => {
      warnUnavailable(error);
    });

  return loadPromise;
}

/** Resolves when the load has settled, whichever way. Test/boot-order seam. */
export function pilgrimsBridgeReady(): Promise<void> {
  return loadPromise ?? Promise.resolve();
}

/**
 * Asks pilgrims to send one settler out of the house at (x, y).
 *
 * FALSE IS AN ORDINARY ANSWER: pilgrims is absent, is still loading, is an
 * older build without the entry point, the walker crowd is at its cap, or
 * nowhere in that house's county is both reachable and buildable. The caller
 * treats every one of those the same way — nobody left the house this step.
 */
export function emitSettlerFrom(x: number, y: number): boolean {
  return pilgrimsApi?.emitSettlerFrom(x, y) ?? false;
}

/** Test seam: swaps the loader. Pass null to restore the real one. */
export function setPilgrimsModuleLoader(loader: PilgrimsModuleLoader | null): void {
  loadModule = loader ?? DEFAULT_PILGRIMS_MODULE_LOADER;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetPilgrimsBridge(): void {
  loadModule = DEFAULT_PILGRIMS_MODULE_LOADER;
  pilgrimsApi = null;
  loadPromise = null;
  warned = false;
}
