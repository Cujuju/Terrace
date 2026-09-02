// THE CROSS-PLUGIN DEPENDENCY PATTERN — relics → mana.
//
// This is the project's first plugin that needs another plugin, and the shape
// of it is the point, not the mana perks it happens to carry. Read this before
// writing the second one.
//
// THE PROBLEM. `plugins/` is auto-discovered from the filesystem (design doc)
// and a self-hoster is invited to delete folders they do not want — and, since
// per-world enablement, to switch one off for a world without deleting
// anything. So another plugin is not a dependency in the package-manager sense
// — it is a plugin that is PROBABLY there, and that may not be RUNNING here
// even when it is. A static `import { setManaPerk } from '../../mana/...'`
// would turn "I deleted the mana folder" into "the server no longer boots",
// because the failure lands in module resolution, before any of our code runs
// and before the host's per-callback try/catch can contain it.
//
// THE PATTERN, in four rules. The first two are now GUARANTEES OF THE HOST
// (issue #196, plan §7 Phase 2) rather than work each bridge does; the second
// two are still the caller's:
//
//   1. ASK THE HOST BY NAME, never the filesystem by path.
//      `WorldApi.sibling('mana')` answers with the module of the plugin
//      RUNNING as mana in this session, or null — a deleted folder, and one
//      the operator disabled for this world, are the same null. A dynamic
//      import could not express the second: its specifier binds to a module
//      URL, so a disabled mana went on answering.
//   2. IT IS SYNCHRONOUS. Every plugin's module is imported before any host
//      exists, so the lookup can be made in onWorldCreate and needs no
//      awaiting, whatever the sibling's place in load order.
//   3. BUFFER, DO NOT DROP. Everything the optional plugin would have been
//      told is recorded here as desired state and replayed once (and if) it
//      arrives — still the caller's job, because core has no idea what a
//      consumer wanted to say. Callers therefore never branch on "is it here
//      yet"; the replay also covers the sibling arriving on a later reopen.
//   4. DUCK-TYPE THE MODULE. A folder can exist and export the wrong thing —
//      an older mana without the perk API, someone's fork. Resolving a
//      sibling is not evidence the API is there; check for the functions.
//
// DEGRADED BEHAVIOUR when mana is absent: relics still spawn, are still
// collected, and perk skills are still granted and shown in the HUD — they
// simply have no economy to modify, which is exactly true, because there is no
// economy. One warning is logged, once. That is the right failure mode: a
// self-hoster who removed the mana plugin removed mana, not relics.

import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';
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

/**
 * The name the host knows mana by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196). The host hands back the plugin RUNNING
 * as `mana` in this session, so a mana that is absent OR disabled for
 * this world resolves to null; the old dynamic import bound to a module
 * URL, and therefore answered from the process's module map either way.
 */
const MANA_PLUGIN_NAME = 'mana';

/** Logged once when the perk API cannot be reached. See DEGRADED BEHAVIOUR. */
export const MANA_UNAVAILABLE_WARNING =
  '[relics] mana plugin not available — mana perks (Azure Heart, Spring of Aether) ' +
  'will be granted but have no effect';

/** The resolved API, or null when no usable mana is running in this world. */
let manaApi: ManaPerkApi | null = null;

/** True once the "mana is missing" warning has been emitted. */
let warned = false;

/**
 * Desired perks, by player id — rule 3 above. This map is the source of truth
 * even when mana IS here, because it is also what gets replayed to a mana that
 * only starts running on a later reopen, after perks were already granted.
 */
const desiredPerks = new Map<string, ManaPerk>();

/** Duck-types the sibling's module namespace into the API. Null if it does not fit. */
function asManaPerkApi(module: SiblingModule | null): ManaPerkApi | null {
  if (module === null) return null;
  if (typeof module.setManaPerk !== 'function') return null;
  if (typeof module.clearManaPerk !== 'function') return null;
  return module as unknown as ManaPerkApi;
}

function warnUnavailable(): void {
  if (warned) return;
  warned = true;
  // console rather than the server's logger: plugins do not import server
  // internals at runtime (mana and reveal take the contract as `import type`
  // only), and a plugin that reached into server/src/log.ts would be a runtime
  // coupling to core that the plugin API is meant to make unnecessary.
  console.warn(MANA_UNAVAILABLE_WARNING);
}

/** Pushes every buffered perk into a freshly-resolved mana. */
function flushDesiredPerks(target: ManaPerkApi): void {
  for (const [playerId, perk] of desiredPerks) target.setManaPerk(playerId, perk);
}

/**
 * Resolves mana through the host, from onWorldCreate.
 *
 * SYNCHRONOUS, AND THERE IS NOTHING LEFT TO AWAIT. The old rule 2 (start the
 * import, do not await it) and the promise it returned existed because module
 * resolution is asynchronous; the host's lookup is not, and it answers whatever
 * the load order — so the sibling is either in hand when this returns or is not
 * running in this world at all.
 *
 * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
 * and on a rollback, and a mana the operator has just enabled must be
 * picked up then. The warning still happens at most once.
 */
export function loadManaBridge(world: WorldApi): void {
  const resolved = asManaPerkApi(world.sibling(MANA_PLUGIN_NAME));
  if (resolved === null) {
    // The folder is there but does not export the perk API: an older mana,
    // or a fork. Same degraded path as no folder at all.
    // CLEARED, not left standing: this runs again on every reopen, and a
    // sibling that WAS running and is not any more (the operator disabled it)
    // must stop being reachable through a stale reference here.
    manaApi = null;
    warnUnavailable();
    return;
  }
  manaApi = resolved;
  flushDesiredPerks(resolved);
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

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetManaBridge(): void {
  manaApi = null;
  warned = false;
  desiredPerks.clear();
}
