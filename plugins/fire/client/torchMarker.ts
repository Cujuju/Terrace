import { createHoverRing, type HoverRing } from '../../../client/src/plugins/kit/hoverRing.ts';

const TORCH_RING_RADIUS = 0.4;

const TORCH_RING_COLOR = 0xff7a33;

export type TorchMarker = HoverRing;

export function createTorchMarker(): TorchMarker {
  return createHoverRing({
    name: 'fire:torch-marker',
    color: TORCH_RING_COLOR,
    radius: TORCH_RING_RADIUS,
  });
}
