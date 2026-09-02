// The rain, built: a falling column of streaks inside a bank of haze.
//
// CLIENT-SIDE PRESENTATION. Nothing here is on the wire and nothing here is
// authoritative — every drop is invented locally out of the four numbers a system
// carries (centre, radius, intensity, wind) plus the frame clock. Two players
// standing in the same front see the same front and different drops.
//
// The MECHANISM is core's client kit: the column, the haze bank, the pool and the
// rig that holds them (client/src/plugins/kit/discRig.ts). What is here is the
// one thing that is actually about rain — its profile.

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
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import { RAIN_PLUGIN_NAME } from '../protocol.ts';

/**
 * Particles in one rain rig.
 *
 * 900 over a system's disc, which is 1 800 cells² at the minimum radius and
 * 9 800 at the maximum — so between one drop per two cells and one per eleven,
 * spread through a 28-unit column. That is not a physical density (real rain
 * would be millions); it is the density at which the eye reads "it is raining"
 * from the camera's 80-cell orbit, where a single drop is a sub-pixel streak and
 * what registers is the texture of the whole column.
 *
 * The cost is one draw call and, per frame, 900 iterations writing 5 400 floats
 * into a buffer that is allocated once.
 */
export const RAIN_DROP_COUNT = 900;

/**
 * How rain falls and looks.
 *
 * Pale grey-blue, and translucent: a drop is a highlight on falling water, not a
 * solid object. The fall speed puts a drop through the whole column in 1.1 s,
 * which at 60 fps is a 0.43-unit step per frame — half a streak length, so
 * consecutive frames overlap and the column reads as continuous rather than as a
 * dotted line. It does not sway: a streak that swayed would smear.
 */
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
};

/**
 * Draw objects one rain rig costs: FIVE — the column, plus the four haze sheets
 * (client/src/plugins/kit/hazeBank.ts, HAZE_LAYERS).
 */
export const RAIN_RIG_DRAW_OBJECTS = 5;

/** The pool, and the one geometry every rig in it shares. */
export interface RainRigs extends RigPool<DiscRig> {
  dispose(): void;
}

export function createRainRigs(): RainRigs {
  // ONE OWNER: the sheet geometry is built once here and freed once here;
  // freeing it inside a rig would tear the resource out from under every other.
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const pool = createRigPool<DiscRig>(() =>
    createDiscRig({
      hazeGeometry,
      // A third of a full bank: precipitation without any haze under it reads as
      // lines in a vacuum, and real rain greys the air it falls through.
      hazeStrength: PRECIPITATION_HAZE_SCALE,
      profile: RAIN_PROFILE,
      name: `${RAIN_PLUGIN_NAME}:system`,
    }),
  );

  return {
    acquire: pool.acquire,
    release: pool.release,
    dispose(): void {
      pool.dispose();
      hazeGeometry.dispose();
    },
  };
}
