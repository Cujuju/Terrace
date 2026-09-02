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
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
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

export function createFogRigs(ctx: ClientPluginCtx): FogRigs {
  // ONE OWNER: the sheet geometry is built once here and freed once here.
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const pool = createRigPool<DiscRig>(() =>
    createDiscRig({
      hazeGeometry,
      hazeStrength: FOG_HAZE_STRENGTH,
      // No precipitation: fog is a haze and nothing falls out of it.
      profile: null,
      name: `${FOG_PLUGIN_NAME}:system`,
      // NO DECK AND NO SHADE (owner, 2026-09-02). Fog is ground haze from a
      // quarter of a world unit to two and a half — it is not overhead, so
      // there is nothing above the player for a cloud to be and nothing
      // between the ground and the sun for a shadow to come from. The clip
      // still applies: a fog bank straddling the frontier must stop at it like
      // everything else.
      deck: null,
      applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
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
