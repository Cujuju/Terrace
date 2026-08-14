// THE CROSS-PLUGIN DEPENDENCY PATTERN — relics → mana.
//
// This is the project's first plugin that needs another plugin, and the shape
// of it is the point, not the mana perks it happens to carry. Read this before
// writing the second one.
//
// THE PROBLEM. `plugins/` is auto-discovered from the filesystem (design §3.5)
// and a self-hoster is invited to delete folders they do not want. So another
// plugin is not a dependency in the package-manager sense — it is a plugin that
// is PROBABLY there. A static `import { setManaPerk } from '../../mana/...'`
// would turn "I deleted the mana folder" into "the server no longer boots",
// because the failure lands in module resolution, before any of our code runs
// and before the host's per-callback try/catch can contain it.
//
// THE PATTERN, in four rules:
//
//   1. DYNAMIC import, not static. `await import(...)` fails as a rejected
//      promise, at a point we control, instead of at load time.
//   2. START IT IN onWorldCreate, DO NOT AWAIT IT. The plugin hooks are all
//      synchronous, so the import is kicked off and the rest of the plugin
//      keeps working while it is in flight.
//   3. BUFFER, DO NOT DROP. Everything the optional plugin would have been
//      told is recorded here as desired state and replayed once (and if) it
//      arrives. Callers therefore never branch on "is it loaded yet".
//   4. DUCK-TYPE THE MODULE. A folder can exist and export the wrong thing —
//      an older mana without the perk API, someone's fork. The import
//      succeeding is not evidence the API is there; check for the functions.
//
// DEGRADED BEHAVIOUR when mana is absent: relics still spawn, are still
// collected, and perk skills are still granted and shown in the HUD — they
// simply have no economy to modify, which is exactly true, because there is no
// economy. One warning is logged, once. That is the right failure mode: a
// self-hoster who removed the mana plugin removed mana, not relics.

import type { ManaPerk } from './perk.ts';

/**
 * The slice of mana this plugin uses. Structural, and deliberately tiny: it is
 * the compatibility surface between two independently-deletable folders, so
 * every member added here is another way a version mismatch can degrade.
 */
export interface ManaPerkApi {
  setManaPerk(playerId: string, perk: ManaPerk): void;
  clearManaPerk(playerId: string): void;
}

/** Loads the mana module. Swappable so tests can exercise the absent path. */
export type ManaModuleLoader = () => Promise<unknown>;

/**
 * The real loader. The specifier is relative to this file and resolves to the
 * sibling plugin folder; it is a bare dynamic import rather than a package name
 * because plugins are folders on disk in v1 (design §3.5 — npm-package plugins
 * come later, and this line is the one that changes when they do).
 */
const DEFAULT_MANA_MODULE_LOADER: ManaModuleLoader = () => import('../../mana/server/index.ts');

/** Logged once when the perk API cannot be reached. See DEGRADED BEHAVIOUR. */
export const MANA_UNAVAILABLE_WARNING =
  '[relics] mana plugin not available — mana perks (Azure Heart, Spring of Aether) ' +
  'will be granted but have no effect';

let loadModule: ManaModuleLoader = DEFAULT_MANA_MODULE_LOADER;

/** The resolved API, or null while loading / after a failed load. */
let manaApi: ManaPerkApi | null = null;

/** In-flight (or settled) load. Non-null once loadManaBridge has been called. */
let loadPromise: Promise<void> | null = null;

/** True once the "mana is missing" warning has been emitted. */
let warned = false;

/**
 * Desired perks, by player id — rule 3 above. This map is the source of truth
 * even when mana IS loaded, because it is also what gets replayed if the load
 * finishes after a perk was granted (a player collecting a relic in the first
 * few milliseconds of a world's life).
 */
const desiredPerks = new Map<string, ManaPerk>();

/** Duck-types a loaded module into the API we need. Null if it does not fit. */
function asManaPerkApi(module: unknown): ManaPerkApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<ManaPerkApi>;
  if (typeof candidate.setManaPerk !== 'function') return null;
  if (typeof candidate.clearManaPerk !== 'function') return null;
  return candidate as ManaPerkApi;
}

function warnUnavailable(error?: unknown): void {
  if (warned) return;
  warned = true;
  // console rather than the server's logger: plugins do not import server
  // internals at runtime (mana and reveal take the contract as `import type`
  // only), and a plugin that reached into server/src/log.ts would be a runtime
  // coupling to core that the plugin API is meant to make unnecessary.
  if (error === undefined) console.warn(MANA_UNAVAILABLE_WARNING);
  else console.warn(MANA_UNAVAILABLE_WARNING, error);
}

/** Pushes every buffered perk into a freshly-arrived mana. */
function flushDesiredPerks(target: ManaPerkApi): void {
  for (const [playerId, perk] of desiredPerks) target.setManaPerk(playerId, perk);
}

/**
 * Starts (once) the load of the mana plugin's perk API.
 *
 * Returns a promise that ALWAYS resolves — a missing or incompatible mana is a
 * documented outcome, not an error to propagate. Callers do not need to await
 * it; onWorldCreate deliberately does not. Tests do, via manaBridgeReady().
 */
export function loadManaBridge(): Promise<void> {
  if (loadPromise !== null) return loadPromise;

  loadPromise = loadModule()
    .then((module) => {
      const resolved = asManaPerkApi(module);
      if (resolved === null) {
        // The folder is there but does not export the perk API: an older mana,
        // or a fork. Same degraded path as no folder at all.
        warnUnavailable();
        return;
      }
      manaApi = resolved;
      flushDesiredPerks(resolved);
    })
    .catch((error: unknown) => {
      // The overwhelmingly likely cause is ERR_MODULE_NOT_FOUND: the
      // self-hoster deleted plugins/mana. Anything else (a syntax error in
      // their fork, say) degrades identically and is logged with its cause.
      warnUnavailable(error);
    });

  return loadPromise;
}

/** Resolves when the load has settled, whichever way. Test/boot-order seam. */
export function manaBridgeReady(): Promise<void> {
  return loadPromise ?? Promise.resolve();
}

/** Whether perks are actually reaching a mana economy right now. */
export function isManaAvailable(): boolean {
  return manaApi !== null;
}

/**
 * Records a player's total perk and forwards it if mana is here. Total-state,
 * mirroring mana's own setManaPerk contract: the caller composes every perk
 * the player holds into one value.
 */
export function applyManaPerk(playerId: string, perk: ManaPerk): void {
  desiredPerks.set(playerId, perk);
  manaApi?.setManaPerk(playerId, perk);
}

/**
 * Drops a player's perk. Safe to call for a player who never had one — which
 * is the common case, since relics revokes on every player leave rather than
 * checking first (one unconditional call cannot forget a branch).
 */
export function revokeManaPerk(playerId: string): void {
  desiredPerks.delete(playerId);
  manaApi?.clearManaPerk(playerId);
}

/** Test seam: swaps the loader. Pass null to restore the real one. */
export function setManaModuleLoader(loader: ManaModuleLoader | null): void {
  loadModule = loader ?? DEFAULT_MANA_MODULE_LOADER;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetManaBridge(): void {
  loadModule = DEFAULT_MANA_MODULE_LOADER;
  manaApi = null;
  loadPromise = null;
  warned = false;
  desiredPerks.clear();
}
