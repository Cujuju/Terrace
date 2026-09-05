// saucers → structures, via THE CROSS-PLUGIN DEPENDENCY PATTERN.
//
// WHY THIS BRIDGE EXISTS AT ALL — and it is worth being explicit, because the
// brief for this plugin assumed something the source does not support.
//
// The brief said a crash cell must not be "inside any protection another plugin
// exposes via the deny-chain". THERE IS NO SUCH CHAIN FOR A PLUGIN'S OWN EDIT.
// `TerracePlugin.onIntent` is documented as a PLAYER-intent interceptor
// (server/src/plugins/types.ts, onIntent), and `WorldApi.sculpt` goes straight
// to `applyServerSculpt` (server/src/plugins/world-api.ts:226 →
// server/src/world/sculpt-service.ts:54), which applies the brush and notifies
// listeners — it never consults an interceptor. A plugin's terraform cannot be
// vetoed by anybody, and "if the deny chain rejects the sculpt, pick the next
// candidate" describes a mechanism that does not exist. Verified from those two
// files, this session.
//
// So the restraint has to be asked for, not enforced: this plugin ASKS
// structures where the towns are and sites the wreck away from them. That is the
// same answer the deny chain would have given for the one plugin that actually
// protects ground it owns, without pretending core will stop us.
//
// DEGRADED BEHAVIOUR when structures is absent: no settlement check, because
// there are no settlements. One warning, once.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/**
 * The slice of structures this plugin uses — one query, deliberately.
 *
 * The entry point IS structures' compatibility surface (it re-exports
 * `standingStructures` for exactly this, plugins/structures/server/index.ts:1025),
 * so this couples to a NAME and a shape, never to that plugin's file layout.
 */
export interface StructuresCellsApi {
  standingStructures(): readonly { readonly x: number; readonly y: number }[];
}

/** The name the host knows structures by — a NAME, not a path (issue #196). */
const STRUCTURES_PLUGIN_NAME = 'structures';

export const STRUCTURES_UNAVAILABLE_WARNING =
  '[saucers] structures plugin not available — crash sites will not steer clear of towns';

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asStructuresApi(module: SiblingModule | null): StructuresCellsApi | null {
  if (module === null) return null;
  if (typeof module.standingStructures !== 'function') return null;
  return module as unknown as StructuresCellsApi;
}

const bridge = createSiblingBridge<StructuresCellsApi>({
  pluginName: STRUCTURES_PLUGIN_NAME,
  duckType: asStructuresApi,
  unavailableWarning: STRUCTURES_UNAVAILABLE_WARNING,
});

/** Resolves structures through the host, from onWorldCreate. */
export function loadStructuresBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * How far a crash must stay from the nearest standing building, in cells.
 *
 * SIX — comfortably outside CRASH_CRATER_RADIUS_CELLS (2.5) plus the fire ring
 * (2), so neither the hole nor the flames reach a wall. It is deliberately not
 * derived from those two: this is a statement about how close a player wants a
 * flaming wreck to their town, which is a bigger number than "the blast does not
 * technically touch it".
 */
export const CRASH_SETTLEMENT_CLEARANCE_CELLS = 6;

/**
 * Is this cell far enough from every standing building?
 *
 * TRUE WHEN STRUCTURES IS ABSENT, which is the correct degraded answer: a world
 * with no structures plugin has no buildings to spare.
 *
 * A LINEAR SCAN over the standing cells, and that is affordable precisely
 * because of when it runs — once per candidate site, at most a handful of
 * candidates, at most once per encounter (minutes apart). A spatial index for a
 * query made twice an hour would be a cost the tick loop pays for a saving
 * nothing measures.
 */
export function isClearOfSettlements(x: number, y: number): boolean {
  const api = bridge.api();
  if (api === null) return true;
  const clearance = CRASH_SETTLEMENT_CLEARANCE_CELLS * CRASH_SETTLEMENT_CLEARANCE_CELLS;
  for (const cell of api.standingStructures()) {
    const dx = cell.x - x;
    const dy = cell.y - y;
    if (dx * dx + dy * dy < clearance) return false;
  }
  return true;
}

/** Released when the world closes — a module-scope view must not outlive it. */
export function clearStructuresBridge(): void {
  bridge.clear();
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetStructuresBridge(): void {
  bridge.reset();
}
