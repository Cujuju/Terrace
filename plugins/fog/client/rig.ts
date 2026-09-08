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

export const FOG_HAZE_STRENGTH = 1;

export const FOG_RIG_DRAW_OBJECTS = 4;

export type FogRigs = RigPool<DiscRig>;

export function createFogRigs(ctx: ClientPluginCtx): FogRigs {
  const hazeGeometry: BufferGeometry = buildHazeGeometry();

  const pool = createRigPool<DiscRig>(() =>
    createDiscRig({
      hazeGeometry,
      hazeStrength: FOG_HAZE_STRENGTH,
      profile: null,
      name: `${FOG_PLUGIN_NAME}:system`,
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
