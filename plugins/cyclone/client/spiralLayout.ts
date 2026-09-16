import { CELL_WORLD_SIZE } from '@terrace/shared';
import { SEA_SURFACE_WORLD_Y } from '../../../client/src/worldScale.ts';
import {
  DECK_BASE_WORLD_Y,
  DECK_THICKNESS_WORLD_UNITS,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { MAX_GROUND_WORLD_Y } from '../../../client/src/plugins/kit/precipitation.ts';
import {
  CYCLONE_EYE_RADIUS_FRACTION,
  CYCLONE_RADIUS_CELLS,
  MAX_ACTIVE_CYCLONES,
} from '../protocol.ts';

// One slot beyond the server's cap: a cyclone disperses over half a minute, so
// its ghost still needs a slot when the next one forms.
export const DISPERSING_HEADROOM = 1;

export const MAX_SPIRALS = MAX_ACTIVE_CYCLONES + DISPERSING_HEADROOM;

export const ARMS_PER_SPIRAL = 9;
export const POSITIONS_PER_ARM = 90;

// A column is one stack of puffs on one arm; every column knows its own ground.
export const COLUMNS_PER_SPIRAL = ARMS_PER_SPIRAL * POSITIONS_PER_ARM;
export const COLUMN_CAPACITY = MAX_SPIRALS * COLUMNS_PER_SPIRAL;

export const ARM_WRAP_TURNS = 0.85;

// Every column tops out on one flat cap, where the ordinary cloud deck tops out.
export const CYCLONE_TOP_WORLD_Y = DECK_BASE_WORLD_Y + DECK_THICKNESS_WORLD_UNITS;

// The rim hangs from the cap; its underside clears the highest ground by half a deck.
export const CYCLONE_RIM_HEADROOM_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS / 2;
export const CYCLONE_RIM_BOTTOM_WORLD_Y = MAX_GROUND_WORLD_Y + CYCLONE_RIM_HEADROOM_WORLD_UNITS;

// The eye wall's foot is the sea at lowest; columns carry enough tiers to reach it.
export const CYCLONE_WALL_FLOOR_WORLD_Y = SEA_SURFACE_WORLD_Y;

// The funnel: undersides drop from the rim bottom to the ground by this power of
// the distance in from the rim; only the eye wall reaches all the way down.
export const CYCLONE_FUNNEL_PROFILE_EXPONENT = 0.5;

export const CYCLONE_EYEWALL_PUFF_GROWTH = 0.6;

export const PUFF_SIZE_RADIUS_FRACTION = 0.085;
export const PUFF_SIZE_SEED_MIN = 0.7;
export const PUFF_SIZE_SEED_SPAN = 0.6;

export const CYCLONE_NOMINAL_RADIUS_WORLD_UNITS = CYCLONE_RADIUS_CELLS * CELL_WORLD_SIZE;

export const CYCLONE_EYEWALL_PUFF_HALF_WIDTH_FRACTION =
  PUFF_SIZE_RADIUS_FRACTION *
  (1 + CYCLONE_EYEWALL_PUFF_GROWTH) *
  (PUFF_SIZE_SEED_MIN + PUFF_SIZE_SEED_SPAN);
export const CYCLONE_BAND_INNER_RADIUS_FRACTION =
  CYCLONE_EYE_RADIUS_FRACTION + CYCLONE_EYEWALL_PUFF_HALF_WIDTH_FRACTION;

// Tiers sit one nominal puff half-width apart: neighbours overlap by half, so the wall closes.
export const CYCLONE_TIER_RISE_PUFF_HALF_WIDTHS = 1;

export const CYCLONE_TIER_JITTER_FRACTION = 0.5;

const SEED_HASH_TIER_JITTER = 7.31;

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

// The eyewall profile: 1 at the eyewall, 0 at the rim.
export function wallAt(along: number): number {
  return 1 - Math.pow(along, CYCLONE_FUNNEL_PROFILE_EXPONENT);
}

// A column's underside when it stands over the sea; the shader lifts it onto higher ground.
export function undersideOverSeaAt(along: number): number {
  return (
    CYCLONE_RIM_BOTTOM_WORLD_Y +
    (CYCLONE_WALL_FLOOR_WORLD_Y - CYCLONE_RIM_BOTTOM_WORLD_Y) * wallAt(along)
  );
}

export function puffHalfWidthAt(along: number): number {
  return (
    CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
    PUFF_SIZE_RADIUS_FRACTION *
    (1 + CYCLONE_EYEWALL_PUFF_GROWTH * wallAt(along))
  );
}

export function tierRiseAt(along: number): number {
  return puffHalfWidthAt(along) * CYCLONE_TIER_RISE_PUFF_HALF_WIDTHS;
}

export function tiersAt(along: number): number {
  return Math.round((CYCLONE_TOP_WORLD_Y - undersideOverSeaAt(along)) / tierRiseAt(along)) + 1;
}

export function alongAt(index: number): number {
  return (index + 0.5) / POSITIONS_PER_ARM;
}

// Where a column stands in the storm's frame; the shader spins the same bearing.
export function columnBearingTurns(arm: number, along: number): number {
  return arm / ARMS_PER_SPIRAL + along * ARM_WRAP_TURNS;
}

export function columnRadiusFraction(along: number): number {
  return CYCLONE_BAND_INNER_RADIUS_FRACTION + (1 - CYCLONE_BAND_INNER_RADIUS_FRACTION) * along;
}

export const PUFFS_PER_ARM: number = (() => {
  let total = 0;
  for (let index = 0; index < POSITIONS_PER_ARM; index++) total += tiersAt(alongAt(index));
  return total;
})();
export const PUFFS_PER_SPIRAL = ARMS_PER_SPIRAL * PUFFS_PER_ARM;

export const SPIRAL_CAPACITY = MAX_SPIRALS * PUFFS_PER_SPIRAL;

// Two vector attributes, since WebGPU allows few vertex buffers per pipeline.
export const SEAT_LANES = 4;
export const KEY_LANES = 2;

export interface SpiralLayout {
  // Per puff: (arm bearing turns, along, seed, tier fraction).
  readonly seats: Float32Array;
  // Per puff: (slot, column).
  readonly keys: Float32Array;
}

// Every slot is laid out identically and written once; centre, radius, strength
// and column grounds are uniforms.
export function writeSpiralLayout(): SpiralLayout {
  const seats = new Float32Array(SPIRAL_CAPACITY * SEAT_LANES);
  const keys = new Float32Array(SPIRAL_CAPACITY * KEY_LANES);

  let written = 0;
  for (let slot = 0; slot < MAX_SPIRALS; slot++) {
    const firstColumn = slot * COLUMNS_PER_SPIRAL;
    for (let arm = 0; arm < ARMS_PER_SPIRAL; arm++) {
      for (let index = 0; index < POSITIONS_PER_ARM; index++) {
        const along = alongAt(index);
        const stacked = tiersAt(along);
        for (let tier = 0; tier < stacked; tier++) {
          const seed = (written * GOLDEN_RATIO_CONJUGATE) % 1;
          const jitter = ((seed * SEED_HASH_TIER_JITTER) % 1) * CYCLONE_TIER_JITTER_FRACTION;
          seats.set([arm / ARMS_PER_SPIRAL, along, seed, (tier + jitter) / stacked], written * SEAT_LANES);
          keys.set([slot, firstColumn + arm * POSITIONS_PER_ARM + index], written * KEY_LANES);
          written++;
        }
      }
    }
  }

  return { seats, keys };
}
