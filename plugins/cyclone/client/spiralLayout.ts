import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  DECK_BASE_WORLD_Y,
  DECK_THICKNESS_WORLD_UNITS,
  PUFF_COVERAGE_OVERLAP,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
import { MAX_GROUND_WORLD_Y } from '../../../client/src/plugins/kit/precipitation.ts';
import { SEA_SURFACE_WORLD_Y } from '../../../client/src/config.ts';
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

// A column is one stack of puffs on one arm; every column stands on its own ground.
export const COLUMNS_PER_SPIRAL = ARMS_PER_SPIRAL * POSITIONS_PER_ARM;
export const COLUMN_CAPACITY = MAX_SPIRALS * COLUMNS_PER_SPIRAL;

export const ARM_WRAP_TURNS = 0.85;

// The outflow shield rides where the ordinary cloud deck tops out; the eye wall climbs to meet it.
export const CYCLONE_SHIELD_WORLD_Y = DECK_BASE_WORLD_Y + DECK_THICKNESS_WORLD_UNITS;
export const CYCLONE_EYEWALL_TOP_WORLD_Y = CYCLONE_SHIELD_WORLD_Y;

// A rim band keeps half a deck of cloud over the highest ground, so no band sinks into a summit.
export const CYCLONE_RIM_HEADROOM_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS / 2;
export const CYCLONE_RIM_TOP_WORLD_Y = MAX_GROUND_WORLD_Y + CYCLONE_RIM_HEADROOM_WORLD_UNITS;

// The lowest surface a wall stands on is the sea; columns carry enough tiers to reach it.
export const CYCLONE_WALL_FLOOR_WORLD_Y = SEA_SURFACE_WORLD_Y;

export const CYCLONE_TOWER_FALLOFF_EXPONENT = 0.5;

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

// The shield overhangs the walls by this fraction of the storm radius.
export const CYCLONE_SHIELD_OVERHANG_FRACTION = 0.3;
export const CYCLONE_SHIELD_RADIUS_FRACTION = 1 + CYCLONE_SHIELD_OVERHANG_FRACTION;

export const CYCLONE_SHIELD_PUFF_SIZE_FRACTION = 0.14;

// The shield's largest puff still clears the eye, so the eye stays open through the top.
export const CYCLONE_SHIELD_INNER_RADIUS_FRACTION =
  CYCLONE_EYE_RADIUS_FRACTION +
  CYCLONE_SHIELD_PUFF_SIZE_FRACTION * (PUFF_SIZE_SEED_MIN + PUFF_SIZE_SEED_SPAN);

// One layer of puffs, each lifted or dropped by up to this much of its half-width.
export const CYCLONE_SHIELD_THICKNESS_PUFF_HALF_WIDTHS = 0.5;

export const SHIELD_PUFFS_PER_SPIRAL = Math.ceil(
  (PUFF_COVERAGE_OVERLAP *
    (CYCLONE_SHIELD_RADIUS_FRACTION * CYCLONE_SHIELD_RADIUS_FRACTION -
      CYCLONE_SHIELD_INNER_RADIUS_FRACTION * CYCLONE_SHIELD_INNER_RADIUS_FRACTION)) /
    (CYCLONE_SHIELD_PUFF_SIZE_FRACTION * CYCLONE_SHIELD_PUFF_SIZE_FRACTION),
);

const SEED_HASH_TIER_JITTER = 7.31;

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;
const GOLDEN_ANGLE_TURNS = GOLDEN_RATIO_CONJUGATE;

// The eyewall profile: 1 at the eyewall, 0 at the rim.
export function wallAt(along: number): number {
  return 1 - Math.pow(along, CYCLONE_TOWER_FALLOFF_EXPONENT);
}

export function towerTopAt(along: number): number {
  return (
    CYCLONE_RIM_TOP_WORLD_Y +
    (CYCLONE_EYEWALL_TOP_WORLD_Y - CYCLONE_RIM_TOP_WORLD_Y) * wallAt(along)
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
  return Math.round((towerTopAt(along) - CYCLONE_WALL_FLOOR_WORLD_Y) / tierRiseAt(along)) + 1;
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

export const WALL_PUFFS_PER_ARM: number = (() => {
  let total = 0;
  for (let index = 0; index < POSITIONS_PER_ARM; index++) total += tiersAt(alongAt(index));
  return total;
})();
export const WALL_PUFFS_PER_SPIRAL = ARMS_PER_SPIRAL * WALL_PUFFS_PER_ARM;

export const PUFFS_PER_SPIRAL = WALL_PUFFS_PER_SPIRAL + SHIELD_PUFFS_PER_SPIRAL;

export const SPIRAL_CAPACITY = MAX_SPIRALS * PUFFS_PER_SPIRAL;

// Two vector attributes, since WebGPU allows few vertex buffers per pipeline.
export const SEAT_LANES = 4;
export const KEY_LANES = 3;

export interface SpiralLayout {
  // Per puff: (arm bearing turns, along, seed, tier fraction).
  readonly seats: Float32Array;
  // Per puff: (slot, column, shield flag).
  readonly keys: Float32Array;
}

// Every slot is laid out identically and written once; centre, radius, strength
// and column grounds are uniforms. A shield puff's bearing and radial seat ride the arm/along lanes.
export function writeSpiralLayout(): SpiralLayout {
  const seats = new Float32Array(SPIRAL_CAPACITY * SEAT_LANES);
  const keys = new Float32Array(SPIRAL_CAPACITY * KEY_LANES);

  let written = 0;
  function seat(
    slot: number,
    column: number,
    bearing: number,
    along: number,
    seed: number,
    tier: number,
    shield: number,
  ): void {
    seats.set([bearing, along, seed, tier], written * SEAT_LANES);
    keys.set([slot, column, shield], written * KEY_LANES);
    written++;
  }

  for (let slot = 0; slot < MAX_SPIRALS; slot++) {
    const firstColumn = slot * COLUMNS_PER_SPIRAL;
    for (let arm = 0; arm < ARMS_PER_SPIRAL; arm++) {
      for (let index = 0; index < POSITIONS_PER_ARM; index++) {
        const along = alongAt(index);
        const stacked = tiersAt(along);
        for (let tier = 0; tier < stacked; tier++) {
          const seed = (written * GOLDEN_RATIO_CONJUGATE) % 1;
          const jitter = ((seed * SEED_HASH_TIER_JITTER) % 1) * CYCLONE_TIER_JITTER_FRACTION;
          seat(
            slot,
            firstColumn + arm * POSITIONS_PER_ARM + index,
            arm / ARMS_PER_SPIRAL,
            along,
            seed,
            (tier + jitter) / stacked,
            0,
          );
        }
      }
    }
    for (let index = 0; index < SHIELD_PUFFS_PER_SPIRAL; index++) {
      const seed = (written * GOLDEN_RATIO_CONJUGATE) % 1;
      seat(
        slot,
        firstColumn,
        (index * GOLDEN_ANGLE_TURNS) % 1,
        Math.sqrt((index + 0.5) / SHIELD_PUFFS_PER_SPIRAL),
        seed,
        (seed * SEED_HASH_TIER_JITTER) % 1,
        1,
      );
    }
  }

  return { seats, keys };
}
