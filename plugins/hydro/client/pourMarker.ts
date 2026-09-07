// The ring under the cursor while Hydro is held: which cell a click would wet,
// and how far the water would spread.
//
// THE RING ITSELF IS THE CLIENT KIT'S (client/src/plugins/kit/hoverRing.ts) —
// read its header. It is an overlay, so it is drawn across every band its
// radius covers rather than being sliced off at the first riser above the
// hovered band (owner, 2026-09-06). That matters more for this tool than for
// the torch: a pour reaches HYDRO_PATCH_RADIUS_WORLD_UNITS, which is several
// cells, so on any hillside the ring crosses bands by construction.
//
// WHAT STAYS HERE is the only part that is hydro's: the colour, and the reach.

import { createHoverRing, type HoverRing } from '../../../client/src/plugins/kit/hoverRing.ts';
import { HYDRO_PATCH_RADIUS_WORLD_UNITS } from '../protocol.ts';

/**
 * THE PATCH'S OWN RADIUS, not a number of its own: the ring promises where the
 * water will reach, and a ring that disagreed with `hydroFalloff`'s edge by so
 * much as a tenth would be promising ground the pour does not wet.
 */
const POUR_RING_RADIUS = HYDRO_PATCH_RADIUS_WORLD_UNITS;

/** The puddle's own sheen colour, so the ring names the tool. */
const POUR_RING_COLOR = 0x6fc4ec;

export type PourMarker = HoverRing;

export function createPourMarker(): PourMarker {
  return createHoverRing({
    name: 'hydro:pour-marker',
    color: POUR_RING_COLOR,
    radius: POUR_RING_RADIUS,
  });
}
