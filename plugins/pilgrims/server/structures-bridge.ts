// pilgrims → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file is the
// pattern's second use and follows its four rules to the letter: dynamic
// import, started-not-awaited, buffer-don't-drop, duck-type the module).
//
// WHAT THIS PLUGIN NEEDS FROM STRUCTURES:
//   * standingStructures() — where the towns are, to pick who sends pilgrims;
//   * setBlessedStructureCells(keys) — total-state route blessing (structures'
//     blessings.ts owns the semantics: replace on every call, empty clears);
//   * foundStructure(world, x, y) — a settler moving in (settling.ts). OPTIONAL
//     on the far side: a structures build from before 2026-08-24 does not have
//     it, and `foundStructureAt` below degrades to "the house never appears"
//     rather than to a crash, the same way `age` degrades above.
//   * canFoundStructure(world, x, y) — would that founding succeed? Asked
//     while a settler is choosing where to go (settling.ts's scan). OPTIONAL
//     and degrades to "yes" — see `canFoundStructureAt` for why this one
//     degrades permissively where the founding itself degrades to false.
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
  /**
   * Generations the cell has survived (structures' LiveCellRecord.age),
   * OPTIONAL: a structures build from before 2026-08-19 doesn't send it.
   * Consumers treat absence as "old enough" — degrading an age gate to the
   * ungated old behaviour, never to silence.
   */
  readonly age?: number;
}

/** The slice of structures this plugin uses — deliberately tiny. */
export interface StructuresApi {
  standingStructures(): BridgedStructureCell[];
  setBlessedStructureCells(keys: readonly number[]): void;
  /**
   * Founds a tier-0 home, returning whether it happened. `world` is the
   * CALLER'S WorldApi, handed across because buildability is a question about
   * the ground and structures holds no world of its own between hooks — see
   * that plugin's `foundStructure`. Typed `unknown` on this side of the bridge
   * for the same reason every other member here is duck-typed: this plugin
   * must build with structures deleted, so it may not name that plugin's
   * types.
   *
   * OPTIONAL: an older structures build simply does not export it.
   */
  foundStructure?(world: unknown, x: number, y: number): boolean;
  /**
   * Would `foundStructure` succeed at this cell right now? Pure — asked while
   * a settler is CHOOSING where to walk, once per candidate cell.
   *
   * OPTIONAL, and its absence degrades to "yes" rather than to "no" — see
   * `canFoundStructureAt` below for why the two directions are not
   * interchangeable here.
   */
  canFoundStructure?(world: unknown, x: number, y: number): boolean;
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

/**
 * Asks structures to found a home at (x, y), returning whether one went up.
 *
 * FALSE IS AN ORDINARY ANSWER, not an error: structures is absent, is still
 * loading, is an older build without the entry point, the board is full, or
 * the ground will not take a house. The caller (settling.ts) treats every one
 * of those the same way — the settler arrived and no house appeared — because
 * from the world's point of view they ARE the same thing.
 */
export function foundStructureAt(world: unknown, x: number, y: number): boolean {
  return structuresApi?.foundStructure?.(world, x, y) ?? false;
}

/**
 * Asks structures whether a home could go up at (x, y) — the question a
 * settler needs answered BEFORE it walks somewhere, not after.
 *
 * TRUE IS THE DEGRADED ANSWER, the opposite of `foundStructureAt`'s, and the
 * asymmetry is deliberate. This predicate is a FILTER on candidate ground, and
 * the same scan that a settler uses to pick a site is what tells the temples
 * plugin whether a temple may be placed at all (settling.ts's
 * canDispatchSettler). A missing structures plugin answering "no" would refuse
 * every temple in the world and dispatch nobody — turning "settlements do not
 * exist here" into "temples are broken here". Answering "yes" degrades instead
 * to exactly the pre-2026-08-24 behaviour: the settler walks to walkable
 * ground and finds out on arrival, which with structures absent means no house
 * appears, which `foundStructureAt` already reports honestly.
 */
export function canFoundStructureAt(world: unknown, x: number, y: number): boolean {
  return structuresApi?.canFoundStructure?.(world, x, y) ?? true;
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
