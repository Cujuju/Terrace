// pilgrims → temples, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file is the
// pattern's third use here and follows its four rules to the letter: dynamic
// import, started-not-awaited, buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM TEMPLES:
//   * standingTemple() — where the player's temple is, because that is where
//     settlers walk out from (settling.ts).
//
// There is nothing to buffer in the other direction: this bridge is a pure
// READ, so rule 3 costs nothing here — a temple that goes up before the module
// finishes loading is simply seen on the first tick after it does.
//
// DEGRADED BEHAVIOUR when temples is absent: there is no temple, so no
// settlers ever walk — which is exactly true. One warning, once. A self-hoster
// who removed the temples plugin removed the building, not a working pilgrims
// plugin.

/** Where the temple stands, structurally typed (never imported). */
export interface BridgedTemple {
  readonly x: number;
  readonly y: number;
}

/** The slice of temples this plugin uses — one function. */
export interface TemplesApi {
  standingTemple(): BridgedTemple | null;
}

export type TemplesModuleLoader = () => Promise<unknown>;

const DEFAULT_TEMPLES_MODULE_LOADER: TemplesModuleLoader = () =>
  import('../../temples/server/index.ts');

export const TEMPLES_UNAVAILABLE_WARNING =
  '[pilgrims] temples plugin not available — no temple means no settlers';

let loadModule: TemplesModuleLoader = DEFAULT_TEMPLES_MODULE_LOADER;
let templesApi: TemplesApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

function asTemplesApi(module: unknown): TemplesApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<TemplesApi>;
  if (typeof candidate.standingTemple !== 'function') return null;
  return candidate as TemplesApi;
}

function warnUnavailable(error?: unknown): void {
  if (warned) return;
  warned = true;
  if (error === undefined) console.warn(TEMPLES_UNAVAILABLE_WARNING);
  else console.warn(TEMPLES_UNAVAILABLE_WARNING, error);
}

/** Starts (once) the load. Always resolves — absence is an outcome, not an error. */
export function loadTemplesBridge(): Promise<void> {
  if (loadPromise !== null) return loadPromise;

  loadPromise = loadModule()
    .then((module) => {
      const resolved = asTemplesApi(module);
      if (resolved === null) {
        warnUnavailable();
        return;
      }
      templesApi = resolved;
    })
    .catch((error: unknown) => {
      warnUnavailable(error);
    });

  return loadPromise;
}

/** Resolves when the load has settled, whichever way. Test/boot-order seam. */
export function templesBridgeReady(): Promise<void> {
  return loadPromise ?? Promise.resolve();
}

/**
 * The standing temple, or null while temples is absent, still loading, or
 * simply has no temple built yet. All three mean the same thing to the settler
 * sim — nobody walks out today — so they are deliberately one answer.
 */
export function bridgedTemple(): BridgedTemple | null {
  return templesApi?.standingTemple() ?? null;
}

/** Test seam: swaps the loader. Pass null to restore the real one. */
export function setTemplesModuleLoader(loader: TemplesModuleLoader | null): void {
  loadModule = loader ?? DEFAULT_TEMPLES_MODULE_LOADER;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetTemplesBridge(): void {
  loadModule = DEFAULT_TEMPLES_MODULE_LOADER;
  templesApi = null;
  loadPromise = null;
  warned = false;
}
