// temples → pilgrims, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules to the letter: dynamic import, started-not-awaited,
// buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM PILGRIMS:
//   * canDispatchSettler() — whether a temple on this ground could ever send
//     anybody out, asked before a placement is accepted (owner, 2026-08-24:
//     "prevent placing the temple in a location where it cannot spawn a
//     settler").
//
// THE PAIR OF BRIDGES POINT BOTH WAYS ON PURPOSE, and neither direction is a
// copy of the other's numbers: pilgrims asks this plugin where the temple's
// door is, because only the building knows how wide it is; this plugin asks
// pilgrims whether the county around that door is settleable, because only the
// walker sim knows how far a settler goes, what it will cross and what it
// needs to find. Both are lazy dynamic imports, so the cycle is a runtime
// question answered once, not a load-order problem.
//
// There is nothing to buffer in either call: this bridge is a pure READ, so
// rule 3 costs nothing here.
//
// DEGRADED BEHAVIOUR when pilgrims is absent: PLACEMENT IS ALLOWED. That
// direction is deliberate and it is the only defensible one — a self-hoster
// who removed the pilgrims plugin removed settlers from the game, and refusing
// to let them build the temple as well would turn one missing feature into two.
// The gate exists to stop a temple being inert in a world that HAS settlers.
// One warning, once.

import type { TempleWorld } from './suitability.ts';

/** The temple as pilgrims sees it — the same shape its own bridge declares. */
export interface BridgedTempleSite {
  readonly x: number;
  readonly y: number;
  readonly doorX: number;
  readonly doorY: number;
}

/**
 * The slice of pilgrims this plugin uses — one function.
 *
 * `world` is passed straight through: pilgrims reads it through its own
 * PilgrimWorld interface, which the server's WorldApi satisfies. This plugin
 * declares its own narrower TempleWorld and never learns the difference, which
 * is the point of handing the object across rather than a copy of its data.
 */
export interface PilgrimsApi {
  canDispatchSettler(world: unknown, temple: BridgedTempleSite): boolean;
}

export type PilgrimsModuleLoader = () => Promise<unknown>;

const DEFAULT_PILGRIMS_MODULE_LOADER: PilgrimsModuleLoader = () =>
  import('../../pilgrims/server/index.ts');

export const PILGRIMS_UNAVAILABLE_WARNING =
  '[temples] pilgrims plugin not available — placements are not settler-checked';

let loadModule: PilgrimsModuleLoader = DEFAULT_PILGRIMS_MODULE_LOADER;
let pilgrimsApi: PilgrimsApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

function asPilgrimsApi(module: unknown): PilgrimsApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<PilgrimsApi>;
  if (typeof candidate.canDispatchSettler !== 'function') return null;
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
 * Would a temple here ever send a settler out? TRUE while pilgrims is absent
 * or still loading — see this file's header for why the doubt resolves in the
 * player's favour rather than against the placement.
 */
export function templeCanSettle(world: TempleWorld, temple: BridgedTempleSite): boolean {
  if (pilgrimsApi === null) return true;
  return pilgrimsApi.canDispatchSettler(world, temple);
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
