import {
  createDiscKindRigs,
  discKindDrawObjects,
  type DiscKindBudget,
  type DiscKindRigs,
} from '../../../client/src/plugins/kit/discKindRigs.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { FOG_PLUGIN_NAME, MAX_ACTIVE_SYSTEMS } from '../protocol.ts';

export const FOG_HAZE_STRENGTH = 1;

export const FOG_KIND: DiscKindBudget = { deck: null, profile: null };

export const FOG_KIND_DRAW_OBJECTS = discKindDrawObjects(FOG_KIND);

export type FogRigs = DiscKindRigs;

export function createFogRigs(ctx: ClientPluginCtx): FogRigs {
  return createDiscKindRigs({
    ...FOG_KIND,
    name: FOG_PLUGIN_NAME,
    maxMasses: MAX_ACTIVE_SYSTEMS,
    hazeStrength: FOG_HAZE_STRENGTH,
    applyRevealClip: (material, label) => ctx.applyRevealClip(material, label),
  });
}
