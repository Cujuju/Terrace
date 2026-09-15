import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  createDiscSystemsView,
  deckShadeFrom,
} from '../../../client/src/plugins/kit/discSystemsView.ts';
import type { DiscRig } from '../../../client/src/plugins/kit/discRig.ts';
import { MAX_ACTIVE_SYSTEMS, SNOW_PLUGIN_NAME, SNOW_SYSTEMS_MESSAGE } from '../protocol.ts';
import { createSnowRigs, SNOW_KIND_DRAW_OBJECTS, SNOW_SHADE_DARKNESS, type SnowRigs } from './rig.ts';

let rigs: SnowRigs | null = null;

const view = createDiscSystemsView<DiscRig>({
  systemsMessage: SNOW_SYSTEMS_MESSAGE,
  containerName: `${SNOW_PLUGIN_NAME}:systems`,
  maxSystems: MAX_ACTIVE_SYSTEMS,
  createPool: (ctx) => {
    rigs = createSnowRigs(ctx);
    return rigs;
  },
  update: (rig, disc, elapsed) => {
    rig.update(disc, elapsed);
  },
  deck: () => rigs?.deck ?? null,
  kindObjects: () => rigs?.kindObjects() ?? [],
  disposeExtras: () => {
    rigs = null;
  },
});

export const clientPlugin: TerraceClientPlugin = {
  name: SNOW_PLUGIN_NAME,

  drawBudget: SNOW_KIND_DRAW_OBJECTS,

  groundShadeBudget: MAX_ACTIVE_SYSTEMS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
    ctx.publishGroundShade(deckShadeFrom(view, SNOW_SHADE_DARKNESS));
  },

  dispose(): void {
    view.dispose();
  },
};
