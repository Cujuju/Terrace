// The snow, built: a falling column of drifting flakes inside a bank of haze.
//
// CLIENT-SIDE PRESENTATION. Nothing here is on the wire and nothing here is
// authoritative — every flake is invented locally out of the four numbers a
// system carries (centre, radius, intensity, wind) plus the frame clock.
//
// The MECHANISM is core's client kit (client/src/plugins/kit/discRig.ts). What is
// here is the one thing that is actually about snow — its profile.

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

/**
 * Particles in one snow rig at the kit's BASE disc size — fewer than rain's 900,
 * and that is what makes it read as snow. Snow falls an order of magnitude
 * slower, so a flake is on screen for eight seconds where a drop is on for one;
 * matching rain's count would fill the air with standing flakes.
 */
const SNOW_FLAKE_COUNT_AT_BASE_FOOTPRINT = 700;

/**
 * Flakes in one snow rig, derived.
 *
 * DENSITY IS THE INVARIANT, NOT THE COUNT — the same call rain's
 * RAIN_DROP_COUNT makes and for the same reason: 700 is justified as flakes per
 * unit of disc, and holding it fixed while SNOW_FOOTPRINT_AREA_SCALE triples the
 * disc would thin the fall to a third. Flakes are seeded uniformly by AREA
 * (client/src/plugins/kit/precipitation.ts, `seedRadius`), so the count follows
 * the area.
 *
 * THE COST, STATED. 2 100 flakes per rig where it was 700; at the plugin's cap
 * of MAX_ACTIVE_SYSTEMS (2) that is 4 200 particles a frame against 1 400, each
 * costing one `Math.sin` for the sway. A fifth of rain's enlarged load, on a
 * plugin whose cap is two. UNVERIFIED: counted, not profiled.
 */
export const SNOW_FLAKE_COUNT = SNOW_FLAKE_COUNT_AT_BASE_FOOTPRINT * SNOW_FOOTPRINT_AREA_SCALE;

/**
 * How snow falls and looks.
 *
 * Snow falls at a twelfth of rain's speed and SWAYS: those two facts are the
 * whole difference between the two effects, and both are why snow needs the
 * sprite form (a streak at 3 units/s would be a stationary dash).
 *
 * Half a cell of sway at a quarter of a hertz: a four-second sideways wander of
 * about a flake's own drift, slow enough to read as air moving rather than as a
 * flake vibrating. Nothing in this plugin oscillates faster than this.
 */
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
  // A FULL DISC: snow falls out of the whole cloud, which has no hole in it.
  innerRadiusFraction: 0,
};

/**
 * Draw objects one snow rig costs: FIVE — the column, plus the four haze sheets
 * (client/src/plugins/kit/hazeBank.ts, HAZE_LAYERS). The DECK is not among
 * them: one instanced draw carries every mass's cloud at once.
 */
export const SNOW_RIG_DRAW_OBJECTS = 5;

/**
 * A snow puff's half-width, as a fraction of the mass's radius.
 *
 * 0.13 — a touch larger than rain's 0.12, and the difference is the same one
 * the two profiles above carry: a snow sky is a softer, lumpier overcast, not
 * the fine even grey of a rain front. The COUNT follows from it
 * (`puffsForCoverage`): 119 puffs today, against rain's 139 — the same "fewer,
 * bigger" relation SNOW_FLAKE_COUNT has to RAIN_DROP_COUNT.
 *
 * UNTOUCHED BY SNOW_FOOTPRINT_AREA_SCALE, and that is the fraction earning its
 * keep: puff size is a fraction of the mass's radius and the count is derived
 * from that fraction alone, so an enlarged mass gets the same 119 puffs, each
 * grown with it — the deck's texture per unit of cloud is identical and the
 * instance buffer does not move.
 */
export const SNOW_PUFF_SIZE_FRACTION = 0.13;

/** Puffs in one snow mass's deck — derived from the size, never chosen. */
export const SNOW_PUFFS_PER_MASS = puffsForCoverage(SNOW_PUFF_SIZE_FRACTION);

/**
 * The snow cloud's own colour, before any of the scene's light reaches it.
 *
 * Pale, and faintly blue — the same cold cast SNOW_PROFILE's flakes carry, and
 * lighter than rain's deck because a snow sky is bright rather than leaden. A
 * DIFFUSE colour, not a finished pixel: the deck is Lambert-lit.
 */
export const SNOW_DECK_COLOR = 0xd6dce6;

/**
 * How much of the light a snow deck takes off the ground under it, at full
 * intensity.
 *
 * A fifth — the lightest of the three precipitating kinds, and less than rain's
 * quarter for the same reason its colour is paler: snow cloud is the thin
 * bright overcast, and the ground under it is dim rather than dark.
 */
export const SNOW_SHADE_DARKNESS = 0.2;

/** The pool, its shared geometry, and the plugin's one cloud deck. */
export interface SnowRigs extends RigPool<DiscRig> {
  /** One instanced draw for every mass's cloud; parented at attach. */
  readonly deck: CumulusDeck;
  dispose(): void;
}

export function createSnowRigs(ctx: ClientPluginCtx): SnowRigs {
  // ONE OWNER: the sheet geometry is built once here and freed once here.
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
    // See rain's copy of this note: a rig leaves the scene without a last
    // frame, and the deck is drawn from uniforms rather than from its root.
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

/** Draw objects the whole plugin costs beyond its rigs: the deck. */
export const SNOW_DECK_DRAW_OBJECTS = CUMULUS_DECK_DRAW_OBJECTS;
