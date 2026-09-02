// rain — client half. Draws whatever the server's `rain:systems` broadcast says
// exists, and nothing else.
//
// It holds no authority: it never spawns a system, never moves one of its own
// accord, and never predicts. The wiring — subscribe, interpolate, pool one rig
// per living system, animate — is core's client kit
// (client/src/plugins/kit/discSystemsView.ts), which four plugins share; what is
// here is this plugin's rig and its budget.
//
// No HUD panel, deliberately: weather is a thing you look up at. A label saying
// RAIN would be the opposite of the feature.

import type {
  ClientPluginCtx,
  GroundShadeDisc,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { createDiscSystemsView } from '../../../client/src/plugins/kit/discSystemsView.ts';
import type { DiscRig } from '../../../client/src/plugins/kit/discRig.ts';
import { deckShadeDisc } from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { MAX_ACTIVE_SYSTEMS, RAIN_PLUGIN_NAME, RAIN_SYSTEMS_MESSAGE } from '../protocol.ts';
import {
  createRainRigs,
  RAIN_DECK_DRAW_OBJECTS,
  RAIN_RIG_DRAW_OBJECTS,
  RAIN_SHADE_DARKNESS,
  type RainRigs,
} from './rig.ts';

/**
 * Module-level singleton, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin
 * (client/src/plugins/host.ts), and `attach`/`dispose` bracket its whole
 * lifetime.
 */
/**
 * The pool, held here as well as by the view because the deck has to be
 * parented at attach and the shade lookup has to reach it. Null between attach
 * and dispose, exactly like the view's own state — the same shape the
 * thunderstorm plugin's `rigs` has.
 */
let rigs: RainRigs | null = null;
let unpublishShade: (() => void) | null = null;

const view = createDiscSystemsView<DiscRig>({
  systemsMessage: RAIN_SYSTEMS_MESSAGE,
  containerName: `${RAIN_PLUGIN_NAME}:systems`,
  createPool: (ctx) => {
    rigs = createRainRigs(ctx);
    return rigs;
  },
  update: (rig, disc, elapsed) => {
    rig.update(disc, elapsed);
  },
  attachExtras: (ctx: ClientPluginCtx) => {
    const pool = rigs;
    if (pool === null) return;
    // Beside the masses, not inside them: ONE instanced draw carries every
    // mass's cloud, so it belongs to the plugin's layer and not to any rig.
    ctx.layer.add(pool.deck.object);
  },
  disposeExtras: () => {
    rigs = null;
  },
});

/**
 * The shade this plugin's clouds throw on the ground, rebuilt each frame.
 *
 * REUSED, NEVER REALLOCATED: core reads this during the frame it draws, every
 * frame, and a fresh array per frame would be garbage for nothing. Read from
 * the view's INTERPOLATED poses — the same numbers the decks were drawn from
 * this frame — so a shadow can never be a broadcast behind its cloud.
 */
const shade: GroundShadeDisc[] = [];

function shadeDiscs(): readonly GroundShadeDisc[] {
  shade.length = 0;
  for (const disc of view.poses().values()) {
    if (disc.intensity <= 0) continue;
    shade.push(deckShadeDisc(disc, RAIN_SHADE_DARKNESS));
  }
  return shade;
}

export const clientPlugin: TerraceClientPlugin = {
  name: RAIN_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own cap — see
   * TerraceClientPlugin.drawBudget. One rig per living system, and the sim never
   * has more than MAX_ACTIVE_SYSTEMS.
   */
  drawBudget: MAX_ACTIVE_SYSTEMS * RAIN_RIG_DRAW_OBJECTS + RAIN_DECK_DRAW_OBJECTS,

  /**
   * One shade disc per living mass, so the budget IS the mass cap — an
   * expression of this plugin's own cap, exactly as `drawBudget` above is.
   */
  groundShadeBudget: MAX_ACTIVE_SYSTEMS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
    unpublishShade = ctx.publishGroundShade(shadeDiscs);
  },

  dispose(): void {
    unpublishShade?.();
    unpublishShade = null;
    view.dispose();
  },
};
