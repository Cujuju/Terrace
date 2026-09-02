// The fog, built: a bank of drifting sheets, and nothing falling through it.
//
// CLIENT-SIDE PRESENTATION. Nothing here is on the wire and nothing here is
// authoritative — the whole bank is invented locally out of the four numbers a
// system carries (centre, radius, intensity, wind) plus the frame clock.
//
// The MECHANISM is core's client kit (client/src/plugins/kit/discRig.ts and
// hazeBank.ts). Fog is the kind that IS the haze bank, so what is here is one
// number: the strength.

import type { BufferGeometry } from 'three';
import { buildHazeGeometry } from '../../../client/src/plugins/kit/hazeBank.ts';
import {
  createDiscRig,
  createRigPool,
  type DiscRig,
  type RigPool,
} from '../../../client/src/plugins/kit/discRig.ts';
import { FOG_PLUGIN_NAME } from '../protocol.ts';

/**
 * Fog gets the haze bank at FULL strength — it is the bank, where a
 * precipitating kind gets a third of it to grey the air its column falls
 * through (PRECIPITATION_HAZE_SCALE).
 */
export const FOG_HAZE_STRENGTH = 1;

/**
 * Draw objects one fog rig costs: FOUR — the haze sheets and nothing else
 * (client/src/plugins/kit/hazeBank.ts, HAZE_LAYERS). Fog has no falling column,
 * which is exactly the one draw call it saves against rain.
 */
export const FOG_RIG_DRAW_OBJECTS = 4;

/** The pool, and the one geometry every rig in it shares. */
export type FogRigs = RigPool<DiscRig>;

export function createFogRigs(): FogRigs {
  // ONE OWNER: the sheet geometry is built once here and freed once here.
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const pool = createRigPool<DiscRig>(() =>
    createDiscRig({
      hazeGeometry,
      hazeStrength: FOG_HAZE_STRENGTH,
      // No precipitation: fog is a haze and nothing falls out of it.
      profile: null,
      name: `${FOG_PLUGIN_NAME}:system`,
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
