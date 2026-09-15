import {
  discKindDrawObjects,
  type DiscKindDeckSpec,
} from '../../../client/src/plugins/kit/discKindRigs.ts';
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';

export const THUNDERSTORM_DROP_COUNT = 1350;

export const THUNDERSTORM_PROFILE: PrecipitationProfile = {
  form: 'streak',
  count: THUNDERSTORM_DROP_COUNT,
  fallSpeed: 30,
  streakLength: 1.1,
  spriteSize: 0,
  opacity: 0.55,
  color: 0x8fa8bd,
  swayWorldUnits: 0,
  swayHz: 0,
  innerRadiusFraction: 0,
};

export const THUNDERSTORM_PUFF_SIZE_FRACTION = 0.12;

export const THUNDERSTORM_DECK_COLOR = 0x51565f;

export const THUNDERSTORM_DECK: DiscKindDeckSpec = {
  puffSizeFraction: THUNDERSTORM_PUFF_SIZE_FRACTION,
  color: THUNDERSTORM_DECK_COLOR,
};

export const THUNDERSTORM_SHADE_DARKNESS = 0.45;

export const THUNDERSTORM_KIND_DRAW_OBJECTS = discKindDrawObjects({
  deck: THUNDERSTORM_DECK,
  profile: THUNDERSTORM_PROFILE,
});
