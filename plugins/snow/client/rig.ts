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
  SNOW_FOOTPRINT_AREA_SCALE,
  SNOW_PLUGIN_NAME,
} from '../protocol.ts';

const SNOW_FLAKE_COUNT_AT_BASE_FOOTPRINT = 700;

export const SNOW_FLAKE_COUNT = SNOW_FLAKE_COUNT_AT_BASE_FOOTPRINT * SNOW_FOOTPRINT_AREA_SCALE;

export const SNOW_PROFILE: PrecipitationProfile = {
  form: 'flake',
  count: SNOW_FLAKE_COUNT,
  fallSpeed: 3.2,
  streakLength: 0,
  spriteSize: 0.22,
  opacity: 0.85,
  color: 0xf2f6ff,
  swayWorldUnits: 0.5,
  swayHz: 0.25,
  innerRadiusFraction: 0,
};

export const SNOW_PUFF_SIZE_FRACTION = 0.13;

export const SNOW_DECK_COLOR = 0xd6dce6;

export const SNOW_DECK: DiscKindDeckSpec = {
  puffSizeFraction: SNOW_PUFF_SIZE_FRACTION,
  color: SNOW_DECK_COLOR,
};

export const SNOW_SHADE_DARKNESS = 0.2;

export const SNOW_KIND_DRAW_OBJECTS = discKindDrawObjects({ deck: SNOW_DECK, profile: SNOW_PROFILE });

export type SnowRigs = DiscKindRigs;

export function createSnowRigs(ctx: ClientPluginCtx): SnowRigs {
  return createDiscKindRigs({
    name: SNOW_PLUGIN_NAME,
    maxMasses: MAX_ACTIVE_SYSTEMS,
    hazeStrength: PRECIPITATION_HAZE_SCALE,
    deck: SNOW_DECK,
    profile: SNOW_PROFILE,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });
}
