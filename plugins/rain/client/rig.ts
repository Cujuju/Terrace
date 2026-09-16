import { PRECIPITATION_HAZE_SCALE } from '../../../client/src/plugins/kit/hazeBank.ts';
import {
  createDiscKindRigs,
  discKindDrawObjects,
  type DiscKindDeckSpec,
  type DiscKindRigs,
} from '../../../client/src/plugins/kit/discKindRigs.ts';
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  RAIN_FOOTPRINT_AREA_SCALE,
  RAIN_PLUGIN_NAME,
} from '../protocol.ts';

const RAIN_DROP_COUNT_AT_BASE_FOOTPRINT = 450;

export const RAIN_DROP_COUNT = RAIN_DROP_COUNT_AT_BASE_FOOTPRINT * RAIN_FOOTPRINT_AREA_SCALE;

export const RAIN_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: RAIN_DROP_COUNT,
  fallSpeed: 26,
  streakLength: 0.9,
  spriteSize: 0,
  opacity: 0.42,
  color: 0xa8c4d8,
  swayWorldUnits: 0,
  swayHz: 0,
  innerRadiusFraction: 0,
};

export const RAIN_PUFF_SIZE_FRACTION = 0.12;

export const RAIN_DECK_COLOR = 0xb6bcc4;

export const RAIN_DECK: DiscKindDeckSpec = {
  puffSizeFraction: RAIN_PUFF_SIZE_FRACTION,
  color: RAIN_DECK_COLOR,
};

export const RAIN_SHADE_DARKNESS = 0.25;

export const RAIN_KIND_DRAW_OBJECTS = discKindDrawObjects({ deck: RAIN_DECK, profile: RAIN_PROFILE });

export type RainRigs = DiscKindRigs;

export function createRainRigs(ctx: ClientPluginCtx): RainRigs {
  return createDiscKindRigs({
    name: RAIN_PLUGIN_NAME,
    maxMasses: MAX_ACTIVE_SYSTEMS,
    hazeStrength: PRECIPITATION_HAZE_SCALE,
    deck: RAIN_DECK,
    profile: RAIN_PROFILE,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });
}
