// snow — client half. Draws whatever the server's `snow:systems` broadcast says
// exists, and nothing else.
//
// It holds no authority: it never spawns a system, never moves one of its own
// accord, and never predicts. The wiring — subscribe, interpolate, pool one rig
// per living system, animate — is core's client kit
// (client/src/plugins/kit/discSystemsView.ts), which four plugins share; what is
// here is this plugin's rig and its budget.
//
// No HUD panel, deliberately: weather is a thing you look up at. A label saying
// SNOW would be the opposite of the feature.

import type {
  ClientPluginCtx,
  GroundShadeDisc,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { createDiscSystemsView } from '../../../client/src/plugins/kit/discSystemsView.ts';
import type { DiscRig } from '../../../client/src/plugins/kit/discRig.ts';
import { deckShadeDisc } from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { MAX_ACTIVE_SYSTEMS, SNOW_PLUGIN_NAME, SNOW_SYSTEMS_MESSAGE } from '../protocol.ts';
import {
  createSnowRigs,
  SNOW_DECK_DRAW_OBJECTS,
  SNOW_RIG_DRAW_OBJECTS,
  SNOW_SHADE_DARKNESS,
  type SnowRigs,
} from './rig.ts';

/**
 * Module-level singleton, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin
 * (client/src/plugins/host.ts), and `attach`/`dispose` bracket its whole
 * lifetime.
 */
/** See rain's copy of this note: the deck and the shade both need the pool. */
let rigs: SnowRigs | null = null;
let unpublishShade: (() => void) | null = null;

const view = createDiscSystemsView<DiscRig>({
  systemsMessage: SNOW_SYSTEMS_MESSAGE,
  containerName: `${SNOW_PLUGIN_NAME}:systems`,
  createPool: (ctx) => {
    rigs = createSnowRigs(ctx);
    return rigs;
  },
  update: (rig, disc, elapsed) => {
    rig.update(disc, elapsed);
  },
  attachExtras: (ctx: ClientPluginCtx) => {
    const pool = rigs;
    if (pool === null) return;
    ctx.layer.add(pool.deck.object);
  },
  disposeExtras: () => {
    rigs = null;
  },
});

/** The shade this plugin's clouds throw — see rain's copy for the reasoning. */
const shade: GroundShadeDisc[] = [];

function shadeDiscs(): readonly GroundShadeDisc[] {
  shade.length = 0;
  for (const disc of view.poses().values()) {
    if (disc.intensity <= 0) continue;
    shade.push(deckShadeDisc(disc, SNOW_SHADE_DARKNESS));
  }
  return shade;
}

export const clientPlugin: TerraceClientPlugin = {
  name: SNOW_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own cap — see
   * TerraceClientPlugin.drawBudget. One rig per living system, and the sim never
   * has more than MAX_ACTIVE_SYSTEMS.
   */
  drawBudget: MAX_ACTIVE_SYSTEMS * SNOW_RIG_DRAW_OBJECTS + SNOW_DECK_DRAW_OBJECTS,

  /** One shade disc per living mass, so the budget IS the mass cap. */
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
