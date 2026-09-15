import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  DECK_BASE_WORLD_Y,
  DECK_THICKNESS_WORLD_UNITS,
} from '../../../client/src/plugins/kit/cumulusDeck.ts';
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

export const CYCLONE_DECK_BASE_WORLD_Y = DECK_BASE_WORLD_Y;

export const CYCLONE_RIM_HEIGHT_MULTIPLE = 2;

export const CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS = DECK_THICKNESS_WORLD_UNITS;
export const CYCLONE_RIM_HEIGHT_WORLD_UNITS =
  DECK_THICKNESS_WORLD_UNITS * CYCLONE_RIM_HEIGHT_MULTIPLE;

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

export const CYCLONE_TIER_JITTER_FRACTION = 0.5;

const SEED_HASH_TIER_JITTER = 7.31;

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

export function towerHeightAt(along: number): number {
  return (
    CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS +
    (CYCLONE_RIM_HEIGHT_WORLD_UNITS - CYCLONE_EYEWALL_HEIGHT_WORLD_UNITS) * along
  );
}

export function tierRiseAt(along: number): number {
  const wall = 1 - Math.pow(along, CYCLONE_TOWER_FALLOFF_EXPONENT);
  return (
    CYCLONE_NOMINAL_RADIUS_WORLD_UNITS *
    PUFF_SIZE_RADIUS_FRACTION *
    (1 + CYCLONE_EYEWALL_PUFF_GROWTH * wall) *
    PUFF_SIZE_SEED_MIN
  );
}

export function tiersAt(along: number): number {
  return Math.round(towerHeightAt(along) / tierRiseAt(along)) + 1;
}

export function alongAt(index: number): number {
  return (index + 0.5) / POSITIONS_PER_ARM;
}

export const PUFFS_PER_ARM: number = (() => {
  let total = 0;
  for (let index = 0; index < POSITIONS_PER_ARM; index++) total += tiersAt(alongAt(index));
  return total;
})();
export const PUFFS_PER_SPIRAL = ARMS_PER_SPIRAL * PUFFS_PER_ARM;

export const SPIRAL_CAPACITY = MAX_SPIRALS * PUFFS_PER_SPIRAL;

export interface SpiralLayout {
  readonly slots: Float32Array;
  readonly arms: Float32Array;
  readonly alongs: Float32Array;
  readonly seeds: Float32Array;
  readonly rises: Float32Array;
}

// Every slot is laid out identically and written once: only the slot's centre,
// radius and strength change, and those are uniforms.
export function writeSpiralLayout(): SpiralLayout {
  const slots = new Float32Array(SPIRAL_CAPACITY);
  const arms = new Float32Array(SPIRAL_CAPACITY);
  const alongs = new Float32Array(SPIRAL_CAPACITY);
  const seeds = new Float32Array(SPIRAL_CAPACITY);
  const rises = new Float32Array(SPIRAL_CAPACITY);

  let written = 0;
  for (let slot = 0; slot < MAX_SPIRALS; slot++) {
    for (let arm = 0; arm < ARMS_PER_SPIRAL; arm++) {
      for (let index = 0; index < POSITIONS_PER_ARM; index++) {
        const along = alongAt(index);
        const tiers = tiersAt(along);
        const rise = tierRiseAt(along);
        for (let tier = 0; tier < tiers; tier++) {
          const seed = (written * GOLDEN_RATIO_CONJUGATE) % 1;
          slots[written] = slot;
          arms[written] = arm / ARMS_PER_SPIRAL;
          alongs[written] = along;
          seeds[written] = seed;
          rises[written] =
            tier * rise + ((seed * SEED_HASH_TIER_JITTER) % 1) * rise * CYCLONE_TIER_JITTER_FRACTION;
          written++;
        }
      }
    }
  }

  return { slots, arms, alongs, seeds, rises };
}
