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
import type { PrecipitationProfile } from '../../../client/src/plugins/kit/precipitation.ts';
import { SNOW_PLUGIN_NAME } from '../protocol.ts';

/**
 * Particles in one snow rig — fewer than rain's 900, and that is what makes it
 * read as snow. Snow falls an order of magnitude slower, so a flake is on screen
 * for eight seconds where a drop is on for one; matching rain's count would fill
 * the air with standing flakes.
 */
export const SNOW_FLAKE_COUNT = 700;

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
};

/**
 * Draw objects one snow rig costs: FIVE — the column, plus the four haze sheets
 * (client/src/plugins/kit/hazeBank.ts, HAZE_LAYERS).
 */
export const SNOW_RIG_DRAW_OBJECTS = 5;

/** The pool, and the one geometry every rig in it shares. */
export type SnowRigs = RigPool<DiscRig>;

export function createSnowRigs(): SnowRigs {
  // ONE OWNER: the sheet geometry is built once here and freed once here.
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const pool = createRigPool<DiscRig>(() =>
    createDiscRig({
      hazeGeometry,
      hazeStrength: PRECIPITATION_HAZE_SCALE,
      profile: SNOW_PROFILE,
      name: `${SNOW_PLUGIN_NAME}:system`,
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
