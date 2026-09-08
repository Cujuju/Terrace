import { CELL_WORLD_SIZE } from '@terrace/shared';
import rainLoopUrl from './assets/rain-loop.wav?url';
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

let rigs: RainRigs | null = null;
let unpublishShade: (() => void) | null = null;
let unsubscribeAmbience: (() => void) | null = null;
let unpublishWeight: (() => void) | null = null;

const WEIGHT_GAUGE_KEY = 'weightUnderCamera';

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
    shade.push(deckShadeDisc(disc, RAIN_SHADE_DARKNESS));
  }
  return shade;
}

function rainWeightUnderCamera(ctx: ClientPluginCtx): number {
  const camera = ctx.cameraPosition();
  const cameraCellX = camera.x / CELL_WORLD_SIZE;
  const cameraCellY = camera.z / CELL_WORLD_SIZE;
  let loudest = 0;
  for (const disc of view.poses().values()) {
    if (disc.intensity <= 0 || disc.radius <= 0) continue;
    const dx = cameraCellX - disc.x;
    const dy = cameraCellY - disc.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance >= disc.radius) continue;
    const weight = disc.intensity * (1 - distance / disc.radius);
    if (weight > loudest) loudest = weight;
  }
  return Math.min(1, Math.max(0, loudest));
}

export const clientPlugin: TerraceClientPlugin = {
  name: RAIN_PLUGIN_NAME,

  drawBudget: MAX_ACTIVE_SYSTEMS * RAIN_RIG_DRAW_OBJECTS + RAIN_DECK_DRAW_OBJECTS,

  groundShadeBudget: MAX_ACTIVE_SYSTEMS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
    ctx.audio.preload(rainLoopUrl);
    unpublishShade = ctx.publishGroundShade(shadeDiscs);
    unpublishWeight = ctx.publishGauge(WEIGHT_GAUGE_KEY, () => rainWeightUnderCamera(ctx));
    unsubscribeAmbience = ctx.onFrame(() => {
      ctx.audio.ambience(rainLoopUrl, rainWeightUnderCamera(ctx));
    });
  },

  dispose(): void {
    unsubscribeAmbience?.();
    unsubscribeAmbience = null;
    unpublishWeight?.();
    unpublishWeight = null;
    unpublishShade?.();
    unpublishShade = null;
    view.dispose();
  },
};
