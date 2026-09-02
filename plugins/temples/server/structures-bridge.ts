// temples → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules: ask the host by name, resolve synchronously,
// buffer-don't-drop, duck-type the module).
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
// claim during onWorldCreate, which may run before this bridge has been
// resolved — and, on a world where structures is switched on later, before
// there is any structures to claim ground with. The desired claim is
// remembered and replayed the moment one is in hand, so the ground under a
// restored temple is protected from the first generation.
//
// DEGRADED BEHAVIOUR when structures is absent: nothing to reserve, because
// there are no settlements to keep off the ground. One warning, once.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** The slice of structures this plugin uses — one function. */
export interface StructuresReservationApi {
  setReservedStructureCells(cells: readonly number[]): void;
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
  '[temples] structures plugin not available — no settlements means nothing to keep off the temple';

/** The claim as last asserted — rule 3's buffer. Empty means "nothing claimed". */
let desiredReservedCells: readonly number[] = [];

function asStructuresApi(module: SiblingModule | null): StructuresReservationApi | null {
  if (module === null) return null;
  if (typeof module.setReservedStructureCells !== 'function') return null;
  return module as unknown as StructuresReservationApi;
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
const bridge = createSiblingBridge<StructuresReservationApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
  // Rule 3, buffer-don't-drop: what this plugin already wanted said,
  // replayed into a sibling that has only just started running.
  onResolved: (api): void => {
    api.setReservedStructureCells(desiredReservedCells);
  },
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

/**
 * Claims (or, with an empty list, releases) the ground no house may grow on.
 * Recorded first, forwarded second — see this file's header on rule 3.
 */
export function reserveStructureGround(cells: readonly number[]): void {
  desiredReservedCells = cells;
  bridge.api()?.setReservedStructureCells(cells);
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetStructuresBridge(): void {
  bridge.reset();
  desiredReservedCells = [];
}
