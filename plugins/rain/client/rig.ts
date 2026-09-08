import type { BufferGeometry } from 'three';
import {
  buildHazeGeometry,
  PRECIPITATION_HAZE_SCALE,
} from '../../../client/src/plugins/kit/hazeBank.ts';
import {
  createDiscRig,
  createRigPool,
  type DiscRig,
  type RigPool,
} from '../../../client/src/plugins/kit/discRig.ts';
import {
  createCumulusDeck,
  CUMULUS_DECK_DRAW_OBJECTS,
  puffsForCoverage,
  type CumulusDeck,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  RAIN_FOOTPRINT_AREA_SCALE,
  RAIN_PLUGIN_NAME,
} from '../protocol.ts';

const RAIN_DROP_COUNT_AT_BASE_FOOTPRINT = 900;

export const RAIN_DROP_COUNT = RAIN_DROP_COUNT_AT_BASE_FOOTPRINT * RAIN_FOOTPRINT_AREA_SCALE;

export const RAIN_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: RAIN_DROP_COUNT,
  fallSpeed: 26,
  streakLength: 0.9,
  spriteSize: 0,
  opacity: 0.42,
  color: 0xa8c4d8,
  swayCells: 0,
  swayHz: 0,
  innerRadiusFraction: 0,
};

export const RAIN_RIG_DRAW_OBJECTS = 5;

export const RAIN_PUFF_SIZE_FRACTION = 0.12;

export const RAIN_PUFFS_PER_MASS = puffsForCoverage(RAIN_PUFF_SIZE_FRACTION);

export const RAIN_DECK_COLOR = 0xb6bcc4;

export const RAIN_SHADE_DARKNESS = 0.25;

export interface RainRigs extends RigPool<DiscRig> {
  readonly deck: CumulusDeck;
  dispose(): void;
}

export function createRainRigs(ctx: ClientPluginCtx): RainRigs {
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const deck = createCumulusDeck({
    maxMasses: MAX_ACTIVE_SYSTEMS,
    puffSizeFraction: RAIN_PUFF_SIZE_FRACTION,
    color: RAIN_DECK_COLOR,
    name: `${RAIN_PLUGIN_NAME}:deck`,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });

  const pool = createRigPool<DiscRig>(
    () =>
      createDiscRig({
        hazeGeometry,
        hazeStrength: PRECIPITATION_HAZE_SCALE,
        profile: RAIN_PROFILE,
        name: `${RAIN_PLUGIN_NAME}:system`,
        deck,
        applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
      }),
    (rig) => rig.park(),
  );

  return {
    deck,
    acquire: pool.acquire,
    release: pool.release,
    dispose(): void {
      pool.dispose();
      deck.dispose();
      hazeGeometry.dispose();
    },
  };
}

export const RAIN_DECK_DRAW_OBJECTS = CUMULUS_DECK_DRAW_OBJECTS;
