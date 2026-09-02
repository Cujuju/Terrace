// pilgrims → monsters, the same cross-plugin bridge shape as
// ./structures-bridge.ts (and relics' mana-bridge.ts before it — its header
// is the contract). READ-ONLY: this plugin only ever polls where the living
// monsters are; it never writes a byte of monsters' state.
//
// DEGRADED BEHAVIOUR when monsters is absent: nothing ever settles, so no
// pilgrimages ever start — true by definition. One warning, once.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** One living monster, structurally typed (never imported). */
export interface BridgedMonsterState {
  readonly id: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

/** The slice of monsters this plugin uses. */
export interface MonstersApi {
  monsterStates(): BridgedMonsterState[];
}

/**
 * The name the host knows monsters by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196). The host hands back the plugin RUNNING
 * as `monsters` in this session, so a monsters that is absent OR disabled for
 * this world resolves to null; the old dynamic import bound to a module
 * URL, and therefore answered from the process's module map either way.
 */
const MONSTERS_PLUGIN_NAME = 'monsters';

export const MONSTERS_UNAVAILABLE_WARNING =
  '[pilgrims] monsters plugin not available — nothing to pilgrimage to';

function asMonstersApi(module: SiblingModule | null): MonstersApi | null {
  if (module === null) return null;
  if (typeof module.monsterStates !== 'function') return null;
  return module as unknown as MonstersApi;
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
const bridge = createSiblingBridge<MonstersApi>({
  pluginName: MONSTERS_PLUGIN_NAME,
  duckType: asMonstersApi,
  unavailableWarning: MONSTERS_UNAVAILABLE_WARNING,
});

/**
 * Resolves monsters through the host, from onWorldCreate.
 *
 * SYNCHRONOUS, AND THERE IS NOTHING LEFT TO AWAIT. The old rule 2 (start the
 * import, do not await it) and the promise it returned existed because module
 * resolution is asynchronous; the host's lookup is not, and it answers whatever
 * the load order — so the sibling is either in hand when this returns or is not
 * running in this world at all.
 *
 * RE-RESOLVED ON EVERY CALL, deliberately: onWorldCreate replays on a reopen
 * and on a rollback, and a monsters the operator has just enabled must be
 * picked up then. The warning still happens at most once.
 */
export function loadMonstersBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * The living monsters right now, or none when monsters is not running here.
 * Entries are re-validated structurally on every poll: the bridge trusts the
 * module's SHAPE once, but a fork could still hand back malformed rows.
 */
export function bridgedMonsters(): BridgedMonsterState[] {
  const states = bridge.api()?.monsterStates();
  if (!Array.isArray(states)) return [];
  const valid: BridgedMonsterState[] = [];
  for (const state of states) {
    if (typeof state !== 'object' || state === null) continue;
    const entry = state as Partial<BridgedMonsterState>;
    if (typeof entry.id !== 'number' || !Number.isFinite(entry.id)) continue;
    if (typeof entry.kind !== 'string') continue;
    if (typeof entry.x !== 'number' || !Number.isFinite(entry.x)) continue;
    if (typeof entry.y !== 'number' || !Number.isFinite(entry.y)) continue;
    valid.push({ id: entry.id, kind: entry.kind, x: entry.x, y: entry.y });
  }
  return valid;
}

/** Test seam: drops all bridge state so a suite can start from zero. */
export function resetMonstersBridge(): void {
  bridge.reset();
}
