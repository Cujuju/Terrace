import rainLoopUrl from './assets/rain-loop.wav?url';
import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  createDiscSystemsView,
  deckShadeFrom,
  discWeightUnderCamera,
} from '../../../client/src/plugins/kit/discSystemsView.ts';
import type { DiscRig } from '../../../client/src/plugins/kit/discRig.ts';
import { MAX_ACTIVE_SYSTEMS, RAIN_PLUGIN_NAME, RAIN_SYSTEMS_MESSAGE } from '../protocol.ts';
import { createRainRigs, RAIN_KIND_DRAW_OBJECTS, RAIN_SHADE_DARKNESS, rainDensityFractionFor, type RainRigs } from './rig.ts';

let rigs: RainRigs | null = null;

const WEIGHT_GAUGE_KEY = 'weightUnderCamera';

const view = createDiscSystemsView<DiscRig>({
  systemsMessage: RAIN_SYSTEMS_MESSAGE,
  containerName: `${RAIN_PLUGIN_NAME}:systems`,
  maxSystems: MAX_ACTIVE_SYSTEMS,
  createPool: (ctx) => {
    rigs = createRainRigs(ctx);
    return rigs;
  },
  update: (rig, disc, elapsed) => {
    rig.setPrecipitationDensity?.(rainDensityFractionFor(disc.id));
    rig.update(disc, elapsed);
  },
  deck: () => rigs?.deck ?? null,
  kindObjects: () => rigs?.kindObjects() ?? [],
  disposeExtras: () => {
    rigs = null;
  },
});

export const clientPlugin: TerraceClientPlugin = {
  name: RAIN_PLUGIN_NAME,

  drawBudget: RAIN_KIND_DRAW_OBJECTS,

  groundShadeBudget: MAX_ACTIVE_SYSTEMS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
    ctx.audio.preload(rainLoopUrl);
    ctx.publishGroundShade(deckShadeFrom(view, RAIN_SHADE_DARKNESS));
    ctx.publishGauge(WEIGHT_GAUGE_KEY, () => discWeightUnderCamera(view, ctx));
    ctx.onFrame(() => {
      ctx.audio.ambience(rainLoopUrl, discWeightUnderCamera(view, ctx));
    });
  },

  dispose(): void {
    view.dispose();
  },
};
