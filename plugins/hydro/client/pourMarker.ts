import { createHoverRing, type HoverRing } from '../../../client/src/plugins/kit/hoverRing.ts';
import { HYDRO_PATCH_RADIUS_WORLD_UNITS } from '../protocol.ts';

const POUR_RING_RADIUS = HYDRO_PATCH_RADIUS_WORLD_UNITS;

const POUR_RING_COLOR = 0x6fc4ec;

export type PourMarker = HoverRing;

export function createPourMarker(): PourMarker {
  return createHoverRing({
    name: 'hydro:pour-marker',
    color: POUR_RING_COLOR,
    radius: POUR_RING_RADIUS,
  });
}
