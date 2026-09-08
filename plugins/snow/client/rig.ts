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
  swayCells: 0.5,
  swayHz: 0.25,
  innerRadiusFraction: 0,
};

export const SNOW_RIG_DRAW_OBJECTS = 5;

export const SNOW_PUFF_SIZE_FRACTION = 0.13;

export const SNOW_PUFFS_PER_MASS = puffsForCoverage(SNOW_PUFF_SIZE_FRACTION);

export const SNOW_DECK_COLOR = 0xd6dce6;

export const SNOW_SHADE_DARKNESS = 0.2;

export interface SnowRigs extends RigPool<DiscRig> {
  readonly deck: CumulusDeck;
  dispose(): void;
}

export function createSnowRigs(ctx: ClientPluginCtx): SnowRigs {
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const deck = createCumulusDeck({
    maxMasses: MAX_ACTIVE_SYSTEMS,
    puffSizeFraction: SNOW_PUFF_SIZE_FRACTION,
    color: SNOW_DECK_COLOR,
    name: `${SNOW_PLUGIN_NAME}:deck`,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });

  const pool = createRigPool<DiscRig>(
    () =>
      createDiscRig({
        hazeGeometry,
        hazeStrength: PRECIPITATION_HAZE_SCALE,
        profile: SNOW_PROFILE,
        name: `${SNOW_PLUGIN_NAME}:system`,
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

export const SNOW_DECK_DRAW_OBJECTS = CUMULUS_DECK_DRAW_OBJECTS;
