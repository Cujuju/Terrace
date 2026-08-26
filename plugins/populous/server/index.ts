// populous — the Bullfrog growth model as a SECOND, SELECTABLE settlement
// rule for the structures plugin (owner brief, 2026-08-25).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PLUGIN IS, AND WHAT IT DELIBERATELY IS NOT.
//
// It is a RULE, registered into somebody else's board. structures stays the
// owner of the board, the wire, the tiers, the persistence slice and every
// downstream consumer (fire, flora, chronicle, pilgrims all read structures);
// this plugin owns one function — what the board looks like next — and reaches
// it through that plugin's growth-model seam (structures/server/growth-model.ts).
//
// So there is NO CLIENT HALF and no wire message of its own: a Populous
// settlement is drawn by structures' own client, because it IS a structures
// settlement. A house here and a house under the Conway CA are the same house
// to every other plugin, to the snapshot, and to the renderer — which is the
// point of doing this behind a seam instead of as a rival plugin.
//
// It also creates NO PEOPLE. A house that fills up asks the pilgrims plugin to
// send one of ITS settlers out (./pilgrims-bridge.ts) — one walker rule, one
// model set, one wire, exactly as pilgrims' own settling.ts insists.
//
// ─────────────────────────────────────────────────────────────────────────────
// OFFERED, NOT SELF-SELECTING (per-world plugin settings, 2026-08-25). This
// plugin registers its rule into the growth-model seam whenever it is running
// in a world, and structures runs the registered rule only where THAT plugin's
// own `model` setting says so. Registering is cheap and idempotent — one slot,
// last writer wins — so an offer nobody takes up costs a world nothing.
//
// WHY THE CHOICE IS NOT READ HERE. It is structures' setting, and a plugin can
// only read settings recorded under its OWN name (WorldApi.setting), which is
// the same wall the message namespace and the persistence slice already stand
// behind. This plugin must also build and run with structures deleted, so it
// may not import that plugin's key or its values to ask about them. Two
// readings of one choice is exactly the drift the env gate used to risk.
// ─────────────────────────────────────────────────────────────────────────────

import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import {
  stepPopulous,
  type PopulousCellRecord,
  type PopulousContext,
  type PopulousStepResult,
  type PopulousWorld,
} from './model.ts';
import { emitSettlerFrom, loadPilgrimsBridge } from './pilgrims-bridge.ts';
import {
  clearGrowthModel,
  loadStructuresBridge,
  registerGrowthModel,
} from './structures-bridge.ts';

/** This plugin's name, and its message namespace. See PLUGIN_NAME_PATTERN. */
export const POPULOUS_PLUGIN_NAME = 'populous';

/**
 * Logged once per world this plugin runs in. It says OFFERED rather than
 * ACTIVE on purpose: whether the board is actually grown by this rule is
 * structures' answer, and that plugin logs which model the world is running.
 */
export const POPULOUS_REGISTERED_MESSAGE =
  '[populous] growth model registered — it drives the board in worlds set to it';

/**
 * THE REGISTERED MODEL — the pure step (./model.ts) plus the one side effect
 * it deliberately does not perform itself: asking pilgrims to put the settlers
 * it reported on the road.
 *
 * THE WALKING HAPPENS IN `afterSwap`, NOT IN `step`, and that is structures'
 * contract rather than this plugin's preference (see its GrowthModel doc): the
 * step reports the cells, structures swaps the board in, broadcasts it, and
 * only then calls back. So a settler is never sent from a house the same step
 * demolished, and the walker — whose arrival founds the next house — is
 * created against the generation that actually stands, not the one it replaced.
 *
 * A REFUSED EMISSION IS DROPPED, NOT RETRIED. See ./pilgrims-bridge.ts: the
 * house has already been reset to an empty population by the step, so a
 * refusal costs it one filling. That is the intended reading — the crowd was
 * at its cap, or there was nowhere to go, and the people stayed home — and the
 * alternative (holding the house at capacity until somebody can leave) would
 * make a full house spam the bridge every step for as long as the world is
 * busy.
 */
const model = {
  name: POPULOUS_PLUGIN_NAME,
  step(
    world: PopulousWorld,
    live: ReadonlyMap<number, PopulousCellRecord>,
    ctx: PopulousContext,
  ): PopulousStepResult {
    return stepPopulous(world, live, ctx);
  },
  afterSwap(emitted: ReadonlyArray<{ x: number; y: number }>): void {
    for (const cell of emitted) emitSettlerFrom(cell.x, cell.y);
  },
};

export const plugin: TerracePlugin = {
  name: POPULOUS_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    // The bridge pattern, host-mediated (structures-bridge.ts): each lookup is
    // synchronous, so the model reaches structures before this hook returns
    // when structures is running here at all — there is no window in which a
    // half-configured world runs the wrong rule. The model stays buffered in
    // the bridge for the case where it is not, and is registered on the reopen
    // that switches structures on.
    loadStructuresBridge(world);
    loadPilgrimsBridge(world);
    registerGrowthModel(model);
    console.info(POPULOUS_REGISTERED_MESSAGE);
  },

  /**
   * THE RULE IS UNREGISTERED WITH THE WORLD IT WAS CHOSEN FOR (issue #167).
   *
   * The growth-model slot is one slot, last writer wins, and it lives in the
   * structures MODULE — not in a session. Left filled, this plugin would keep
   * driving the board of the NEXT world opened in this process even when that
   * world did not select it, which is precisely the swap this seam exists to
   * make an explicit, per-world choice. Registration happens in onWorldCreate
   * on every open, so clearing here costs the selected case nothing.
   */
  onWorldClose(): void {
    clearGrowthModel();
  },
};

/** Test seam: the model object this plugin registers. */
export function growthModelForTest(): typeof model {
  return model;
}
