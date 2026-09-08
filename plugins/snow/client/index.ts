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
  deck: () => rigs?.deck ?? null,
  attachExtras: (ctx: ClientPluginCtx) => {
    const pool = rigs;
    if (pool === null) return;
    ctx.layer.add(pool.deck.object);
  },
  disposeExtras: () => {
    rigs = null;
  },
});

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

  drawBudget: MAX_ACTIVE_SYSTEMS * SNOW_RIG_DRAW_OBJECTS + SNOW_DECK_DRAW_OBJECTS,

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
