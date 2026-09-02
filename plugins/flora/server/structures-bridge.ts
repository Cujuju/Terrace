// flora → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules to the letter: ask the host by name, resolve synchronously,
// duck-type the module. Rule 3, "buffer, don't drop", does not apply here —
// unlike relics→mana or pilgrims→structures, this bridge never WRITES
// anything into structures, so there is no desired state to replay).
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

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** One occupied cell, structurally typed (never imported). */
export interface BridgedStructureCell {
  readonly x: number;
  readonly y: number;
}

/** The slice of structures this plugin uses — deliberately tiny, read-only. */
export interface StructuresApi {
  standingStructures(): BridgedStructureCell[];
}

/**
 * The name the host knows structures by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196). The host hands back the plugin RUNNING
 * as `structures` in this session, so a structures that is absent OR disabled for
 * this world resolves to null; the old dynamic import bound to a module
 * URL, and therefore answered from the process's module map either way.
 */
const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[flora] structures plugin not available — no buildings means nothing excludes trees';

/** Duck-types a loaded module into the API we need. Null if it does not fit. */
function asStructuresApi(module: SiblingModule | null): StructuresApi | null {
  if (module === null) return null;
  if (typeof module.standingStructures !== 'function') return null;
  return module as unknown as StructuresApi;
}

/**
 * The sibling, resolved through the host — the MECHANISM only: the name lookup,
 * the warn-once, the re-resolve on every load, the clear on close.
 *
 * It lives in core's plugin kit (server/src/plugins/kit/bridge.ts) because
 * nineteen bridges each carried a copy of it. What stays HERE is the duck-typed
 * interface above and the accessors below, because those are the CONTRACT
 * between two independently-deletable folders — the thing that has to survive
 * one side being absent or older.
 */
const bridge = createSiblingBridge<StructuresApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
});

/**
 * Resolves structures through the host, from onWorldCreate.
 *
 * SYNCHRONOUS, AND THERE IS NOTHING LEFT TO AWAIT. The old rule 2 (start the
 * import, do not await it) and the promise it returned existed because module
 * resolution is asynchronous; the host's lookup is not, and it answers whatever
 * the load order — so the sibling is either in hand when this returns or is not
 * running in this world at all.
 *
 * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
 * and on a rollback, and a structures the operator has just enabled must be
 * picked up then. The warning still happens at most once.
 */
export function loadStructuresBridge(world: WorldApi): void {
  bridge.load(world);
}

/** The occupied cells, or an empty world when structures is not running here. */
export function bridgedStructures(): BridgedStructureCell[] {
  return bridge.api()?.standingStructures() ?? [];
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetStructuresBridge(): void {
  bridge.reset();
}
