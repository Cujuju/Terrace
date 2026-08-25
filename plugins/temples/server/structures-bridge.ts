// temples → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules: dynamic import, started-not-awaited, buffer-don't-drop,
// duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM STRUCTURES:
//   * setReservedStructureCells(cells) — "do not grow a house on this ground"
//     (owner-reported, 2026-08-24: a settlement cell appeared inside the
//     temple's own footprint). Total-state replace, a flat x, y, x, y… list;
//     an empty call clears the claim. structures' reservations.ts owns the
//     semantics and this file only re-asserts them.
//
// WHY THE CLAIM IS PUSHED AND NOT ASKED FOR. structures tests buildability for
// every cell of the board every generation, so the answer must be a lookup on
// its side rather than a call into this plugin; and this plugin knows the
// exact moment its claim changes, because the claim IS its whole state — one
// building, placed and razed by hand. Anything else would be polling.
//
// BUFFER, DON'T DROP (rule 3), and here it is load-bearing rather than
// ceremonial: a world restored with a temple already standing asserts its
// claim during onWorldCreate, which is very likely BEFORE the dynamic import
// of structures has resolved. The desired claim is remembered and replayed
// into the module the moment it lands, so the ground under a restored temple
// is protected from the first generation rather than from whenever the import
// happened to finish.
//
// DEGRADED BEHAVIOUR when structures is absent: nothing to reserve, because
// there are no settlements to keep off the ground. One warning, once.

/** The slice of structures this plugin uses — one function. */
export interface StructuresReservationApi {
  setReservedStructureCells(cells: readonly number[]): void;
}

export type StructuresModuleLoader = () => Promise<unknown>;

const DEFAULT_STRUCTURES_MODULE_LOADER: StructuresModuleLoader = () =>
  import('../../structures/server/index.ts');

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[temples] structures plugin not available — no settlements means nothing to keep off the temple';

let loadModule: StructuresModuleLoader = DEFAULT_STRUCTURES_MODULE_LOADER;
let structuresApi: StructuresReservationApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

/** The claim as last asserted — rule 3's buffer. Empty means "nothing claimed". */
let desiredReservedCells: readonly number[] = [];

function asStructuresApi(module: unknown): StructuresReservationApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<StructuresReservationApi>;
  if (typeof candidate.setReservedStructureCells !== 'function') return null;
  return candidate as StructuresReservationApi;
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
      const resolved = asStructuresApi(module);
      if (resolved === null) {
        warnUnavailable();
        return;
      }
      structuresApi = resolved;
      resolved.setReservedStructureCells(desiredReservedCells);
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

/**
 * Claims (or, with an empty list, releases) the ground no house may grow on.
 * Recorded first, forwarded second — see this file's header on rule 3.
 */
export function reserveStructureGround(cells: readonly number[]): void {
  desiredReservedCells = cells;
  structuresApi?.setReservedStructureCells(cells);
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
  desiredReservedCells = [];
}
