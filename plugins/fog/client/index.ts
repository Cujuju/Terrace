import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { createDiscSystemsView } from '../../../client/src/plugins/kit/discSystemsView.ts';
import type { DiscRig } from '../../../client/src/plugins/kit/discRig.ts';
import { MAX_ACTIVE_SYSTEMS, FOG_PLUGIN_NAME, FOG_SYSTEMS_MESSAGE } from '../protocol.ts';
import { createFogRigs, FOG_RIG_DRAW_OBJECTS } from './rig.ts';

const view = createDiscSystemsView<DiscRig>({
  systemsMessage: FOG_SYSTEMS_MESSAGE,
  containerName: `${FOG_PLUGIN_NAME}:systems`,
  createPool: (ctx) => createFogRigs(ctx),
  update: (rig, disc, elapsed) => {
    rig.update(disc, elapsed);
  },
});

export const clientPlugin: TerraceClientPlugin = {
  name: FOG_PLUGIN_NAME,

  drawBudget: MAX_ACTIVE_SYSTEMS * FOG_RIG_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
  },

  dispose(): void {
    view.dispose();
  },
};
