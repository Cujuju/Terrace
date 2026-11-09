import { WHALE_AUTHORED_BOUNDS } from '../swimmerBounds.ts';

export const WHALE_ENVELOPE = {
  crownY: WHALE_AUTHORED_BOUNDS.humpback.crownY,
  bellyY: WHALE_AUTHORED_BOUNDS.humpback.bellyY,
  length: WHALE_AUTHORED_BOUNDS.humpback.noseX - WHALE_AUTHORED_BOUNDS.humpback.tailX,
} as const;
