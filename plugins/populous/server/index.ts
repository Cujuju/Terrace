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
// INERT UNLESS SELECTED. STRUCTURES_MODEL=populous turns this plugin on; under
// any other value (including the default) it logs one line and registers
// nothing, so an installed-but-unselected plugin costs a world nothing but the
// import. The variable is READ HERE TOO rather than asked of structures: this
// plugin must build and run with structures deleted, so it may not import that
// plugin's constants — the restate-don't-import rule every cross-plugin value
// in this repo lives under. The two readings cannot disagree about anything
// except a value structures would already have refused to boot on.
// ─────────────────────────────────────────────────────────────────────────────

import type { TerracePlugin } from '../../../server/src/plugins/types.ts';
import {
  stepPopulous,
  type PopulousCellRecord,
  type PopulousContext,
  type PopulousStepResult,
  type PopulousWorld,
} from './model.ts';
import { emitSettlerFrom, loadPilgrimsBridge } from './pilgrims-bridge.ts';
import { loadStructuresBridge, registerGrowthModel } from './structures-bridge.ts';

/** This plugin's name, and its message namespace. See PLUGIN_NAME_PATTERN. */
export const POPULOUS_PLUGIN_NAME = 'populous';

/** Restated, not imported — see this file's header. structures owns the name. */
export const STRUCTURES_MODEL_ENV = 'STRUCTURES_MODEL';

/** The one value of that variable that makes this plugin the active model. */
export const STRUCTURES_MODEL_POPULOUS = 'populous';

export const POPULOUS_INACTIVE_MESSAGE =
  `[populous] ${STRUCTURES_MODEL_ENV} is not "${STRUCTURES_MODEL_POPULOUS}" — this plugin is inert`;

export const POPULOUS_ACTIVE_MESSAGE =
  '[populous] registered as the structures growth model';

/** Is this deployment configured to run this model? Read once, at world create. */
export function isPopulousSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STRUCTURES_MODEL_ENV]?.trim() === STRUCTURES_MODEL_POPULOUS;
}

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

  onWorldCreate(): void {
    if (!isPopulousSelected()) {
      console.info(POPULOUS_INACTIVE_MESSAGE);
      return;
    }

    // Rule 2 of the bridge pattern: kick the loads off, do not await them.
    // The model is buffered inside the structures bridge and registered the
    // moment that plugin resolves; structures itself does nothing at all until
    // then (its board simply does not change), so there is no window in which
    // a half-configured world runs the wrong rule.
    void loadStructuresBridge();
    void loadPilgrimsBridge();
    registerGrowthModel(model);
    console.info(POPULOUS_ACTIVE_MESSAGE);
  },
};

/** Test seam: the model object this plugin registers. */
export function growthModelForTest(): typeof model {
  return model;
}
