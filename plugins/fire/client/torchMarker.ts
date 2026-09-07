// The ring under the cursor while the Torch is held: which cell a click would
// light.
//
// THE RING ITSELF IS THE CLIENT KIT'S (client/src/plugins/kit/hoverRing.ts) —
// read its header. What used to live here was a flat depth-tested ring, which
// terraced ground sliced: the circle survived only over the hovered band and
// the bands below it. The kit's ring is an overlay, so it is drawn across every
// band its radius covers (owner, 2026-09-06).
//
// WHAT STAYS HERE is the only part that is fire's: the colour, and the reach.

import { createHoverRing, type HoverRing } from '../../../client/src/plugins/kit/hoverRing.ts';

/**
 * How far the ring reaches, in world units.
 *
 * A TORCH LIGHTS ONE CELL, so the ring is drawn just inside one — 0.4 against
 * CELL_WORLD_SIZE's 0.25 half-width plus a margin, so the circle sits proud of
 * the cell it names without touching its neighbours.
 */
const TORCH_RING_RADIUS = 0.4;

/** Ember orange — the flame's own colour, so the ring names the tool. */
const TORCH_RING_COLOR = 0xff7a33;

export type TorchMarker = HoverRing;

export function createTorchMarker(): TorchMarker {
  return createHoverRing({
    name: 'fire:torch-marker',
    color: TORCH_RING_COLOR,
    radius: TORCH_RING_RADIUS,
  });
}
