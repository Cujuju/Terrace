import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { createDiscSystemsView } from '../../../client/src/plugins/kit/discSystemsView.ts';
import type { DiscRig } from '../../../client/src/plugins/kit/discRig.ts';
import { MAX_ACTIVE_SYSTEMS, FOG_PLUGIN_NAME, FOG_SYSTEMS_MESSAGE } from '../protocol.ts';
import { createFogRigs, FOG_KIND_DRAW_OBJECTS, type FogRigs } from './rig.ts';

let rigs: FogRigs | null = null;

const view = createDiscSystemsView<DiscRig>({
  systemsMessage: FOG_SYSTEMS_MESSAGE,
  containerName: `${FOG_PLUGIN_NAME}:systems`,
  maxSystems: MAX_ACTIVE_SYSTEMS,
  createPool: (ctx) => {
    rigs = createFogRigs(ctx);
    return rigs;
  },
  update: (rig, disc, elapsed) => {
    rig.update(disc, elapsed);
  },
  kindObjects: () => rigs?.kindObjects() ?? [],
  disposeExtras: () => {
    rigs = null;
  },
});

export const clientPlugin: TerraceClientPlugin = {
  name: FOG_PLUGIN_NAME,

  drawBudget: FOG_KIND_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
  },

  dispose(): void {
    view.dispose();
  },
};
