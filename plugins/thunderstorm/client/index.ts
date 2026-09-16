import { CELL_WORLD_SIZE, MAX_RELIEF_WORLD_UNITS } from '@terrace/shared';
import thunderSfxUrl0 from './assets/thunder-0.wav?url';
import thunderSfxUrl1 from './assets/thunder-1.wav?url';
import thunderSfxUrl2 from './assets/thunder-2.wav?url';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
  WorldPosition,
} from '../../../client/src/plugins/types.ts';
import {
  createDiscSystemsView,
  deckShadeFrom,
  discWeightUnderCamera,
} from '../../../client/src/plugins/kit/discSystemsView.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  STRIKE_NO_SYSTEM,
  THUNDERSTORM_PLUGIN_NAME,
  THUNDERSTORM_STRIKES_MESSAGE,
  THUNDERSTORM_SYSTEMS_MESSAGE,
  parseStrikesPayload,
} from '../protocol.ts';
import { BOLT_BOTTOM_WORLD_Y, LightningGovernor } from './lightning.ts';
import {
  createThunderstormRigs,
  FLASH_DRAW_OBJECTS,
  type ThunderstormRig,
  type ThunderstormRigs,
} from './rig.ts';
import { THUNDERSTORM_KIND_DRAW_OBJECTS, THUNDERSTORM_SHADE_DARKNESS } from './look.ts';

const governor = new LightningGovernor();

let rigs: ThunderstormRigs | null = null;

const WEIGHT_GAUGE_KEY = 'weightUnderCamera';

const view = createDiscSystemsView<ThunderstormRig>({
  systemsMessage: THUNDERSTORM_SYSTEMS_MESSAGE,
  containerName: `${THUNDERSTORM_PLUGIN_NAME}:systems`,
  maxSystems: MAX_ACTIVE_SYSTEMS,
  createPool: (ctx) => {
    rigs = createThunderstormRigs(ctx);
    return rigs;
  },
  update: (rig, disc, elapsed, dt, reduced) => {
    rig.update(disc, elapsed, dt, reduced);
  },
  deck: () => rigs?.deck ?? null,
  kindObjects: () => rigs?.kindObjects() ?? [],
  attachExtras: (ctx: ClientPluginCtx) => {
    const pool = rigs;
    if (pool === null) return;
    ctx.layer.add(pool.dryBolt.root);
    ctx.layer.add(pool.flashLight.light);
  },
  frameExtras: (dt, reduced) => {
    governor.advance(dt);
    rigs?.dryBolt.update(dt, reduced);
  },
  disposeExtras: () => {
    governor.reset();
    rigs = null;
  },
});

const MAX_RELIEF_METRES = 160;
const WORLD_UNIT_METRES = MAX_RELIEF_METRES / MAX_RELIEF_WORLD_UNITS;

const SPEED_OF_SOUND_METRES_PER_SECOND = 343;

const SPEED_OF_SOUND_WORLD_UNITS_PER_SECOND =
  SPEED_OF_SOUND_METRES_PER_SECOND / WORLD_UNIT_METRES;

const MAX_THUNDER_DELAY_SECONDS = 4;

const THUNDER_SFX_URLS: readonly string[] = [thunderSfxUrl0, thunderSfxUrl1, thunderSfxUrl2];

let nextThunderIndex = 0;

function nextThunderSfxUrl(): string {
  const url = THUNDER_SFX_URLS[nextThunderIndex];
  nextThunderIndex = (nextThunderIndex + 1) % THUNDER_SFX_URLS.length;
  return url;
}

function thunderDelaySeconds(ctx: ClientPluginCtx, at: WorldPosition): number {
  const camera = ctx.cameraPosition();
  const dx = at.x - camera.x;
  const dy = at.y - camera.y;
  const dz = at.z - camera.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return Math.min(MAX_THUNDER_DELAY_SECONDS, distance / SPEED_OF_SOUND_WORLD_UNITS_PER_SECOND);
}

function playThunder(ctx: ClientPluginCtx, cellX: number, cellY: number): void {
  const at: WorldPosition = {
    x: cellX * CELL_WORLD_SIZE,
    y: BOLT_BOTTOM_WORLD_Y,
    z: cellY * CELL_WORLD_SIZE,
  };
  ctx.audio.playSfx(nextThunderSfxUrl(), { at, delaySeconds: thunderDelaySeconds(ctx, at) });
}

// True when a bolt was drawn; the governor may refuse a strike that comes too soon.
function applyStrike(systemId: number, cellX: number, cellY: number): boolean {
  const rig = systemId === STRIKE_NO_SYSTEM ? undefined : view.rigFor(systemId);
  const disc = rig === undefined ? undefined : view.poseFor(systemId);

  if (rig === undefined || disc === undefined) {
    const dryBolt = rigs?.dryBolt;
    if (dryBolt === undefined) return false;
    return dryBolt.strike(cellX * CELL_WORLD_SIZE, cellY * CELL_WORLD_SIZE, governor);
  }

  return rig.strike(
    (cellX - disc.x) * CELL_WORLD_SIZE,
    (cellY - disc.y) * CELL_WORLD_SIZE,
    governor,
  );
}

export const clientPlugin: TerraceClientPlugin = {
  name: THUNDERSTORM_PLUGIN_NAME,

  drawBudget: THUNDERSTORM_KIND_DRAW_OBJECTS + FLASH_DRAW_OBJECTS,

  groundShadeBudget: MAX_ACTIVE_SYSTEMS,

  attach(ctx: ClientPluginCtx): void {
    view.attach(ctx);
    for (const url of THUNDER_SFX_URLS) ctx.audio.preload(url);
    ctx.publishGroundShade(deckShadeFrom(view, THUNDERSTORM_SHADE_DARKNESS));
    ctx.publishGauge(WEIGHT_GAUGE_KEY, () => discWeightUnderCamera(view, ctx));

    ctx.onMessage(THUNDERSTORM_STRIKES_MESSAGE, (payload) => {
      const strikes = parseStrikesPayload(payload);
      if (strikes === null) return;
      // No flash, no thunder: sound and light always agree.
      if (view.isReduced()) return;
      for (const strike of strikes) {
        if (applyStrike(strike.systemId, strike.x, strike.y)) playThunder(ctx, strike.x, strike.y);
      }
    });
  },

  dispose(): void {
    view.dispose();
  },
};
