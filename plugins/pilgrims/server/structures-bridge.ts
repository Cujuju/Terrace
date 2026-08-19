// pilgrims → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file is the
// pattern's second use and follows its four rules to the letter: dynamic
// import, started-not-awaited, buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM STRUCTURES:
//   * standingStructures() — where the towns are, to pick who sends pilgrims;
//   * setBlessedStructureCells(keys) — total-state route blessing (structures'
//     blessings.ts owns the semantics: replace on every call, empty clears).
//
// DEGRADED BEHAVIOUR when structures is absent: no settlements exist, so no
// pilgrimages ever start — which is exactly true. One warning is logged,
// once. A self-hoster who removed the structures plugin removed towns, not a
// working pilgrims plugin.

/** One standing structure, structurally typed (never imported). */
export interface BridgedStructureCell {
  readonly x: number;
  readonly y: number;
  readonly tier: number;
}

/** The slice of structures this plugin uses — deliberately tiny. */
export interface StructuresApi {
  standingStructures(): BridgedStructureCell[];
  setBlessedStructureCells(keys: readonly number[]): void;
}

export type StructuresModuleLoader = () => Promise<unknown>;

const DEFAULT_STRUCTURES_MODULE_LOADER: StructuresModuleLoader = () =>
  import('../../structures/server/index.ts');

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[pilgrims] structures plugin not available — no settlements means no pilgrimages';

let loadModule: StructuresModuleLoader = DEFAULT_STRUCTURES_MODULE_LOADER;
let structuresApi: StructuresApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

/**
 * The desired blessed set — rule 3 (buffer, don't drop): re-asserted into a
 * structures module that finishes loading after routes already formed.
 */
let desiredBlessedKeys: readonly number[] = [];

function asStructuresApi(module: unknown): StructuresApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<StructuresApi>;
  if (typeof candidate.standingStructures !== 'function') return null;
  if (typeof candidate.setBlessedStructureCells !== 'function') return null;
  return candidate as StructuresApi;
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
      resolved.setBlessedStructureCells(desiredBlessedKeys);
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

/** The standing towns, or an empty world while structures is absent/loading. */
export function bridgedStructures(): BridgedStructureCell[] {
  return structuresApi?.standingStructures() ?? [];
}

/** Records and forwards the total blessed set (structures' replace semantics). */
export function applyBlessedCells(keys: readonly number[]): void {
  desiredBlessedKeys = keys;
  structuresApi?.setBlessedStructureCells(keys);
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
  desiredBlessedKeys = [];
}
