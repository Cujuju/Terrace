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
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { createDiscSystemsView } from '../../../client/src/plugins/kit/discSystemsView.ts';
import type { DiscRig } from '../../../client/src/plugins/kit/discRig.ts';
import { MAX_ACTIVE_SYSTEMS, RAIN_PLUGIN_NAME, RAIN_SYSTEMS_MESSAGE } from '../protocol.ts';
import { createRainRigs, RAIN_RIG_DRAW_OBJECTS } from './rig.ts';

/**
 * Module-level singleton, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin
 * (client/src/plugins/host.ts), and `attach`/`dispose` bracket its whole
 * lifetime.
 */
const view = createDiscSystemsView<DiscRig>({
  systemsMessage: RAIN_SYSTEMS_MESSAGE,
  containerName: `${RAIN_PLUGIN_NAME}:systems`,
  createPool: () => createRainRigs(),
  update: (rig, disc, elapsed) => {
    rig.update(disc, elapsed);
  },
});

export const clientPlugin: TerraceClientPlugin = {
  name: RAIN_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own cap — see
   * TerraceClientPlugin.drawBudget. One rig per living system, and the sim never
   * has more than MAX_ACTIVE_SYSTEMS.
   */
  drawBudget: MAX_ACTIVE_SYSTEMS * RAIN_RIG_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
  },

  dispose(): void {
    view.dispose();
  },
};
