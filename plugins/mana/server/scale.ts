import { MAX_BRUSH_RADIUS, WORLD_UNIT_CELLS, cellsAcross } from '@terrace/shared';
import { sculptManaCost } from '../pricing.ts';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../../../server/src/config.ts';

export const MANA_PER_BAND_WORLD_UNIT_SQUARED = 6;
export const MANA_PER_BAND_CELL =
  MANA_PER_BAND_WORLD_UNIT_SQUARED / (WORLD_UNIT_CELLS * WORLD_UNIT_CELLS);

export const POINT_BRUSH_RADIUS_CELLS = cellsAcross(1);
export const MANA_COST_PER_MIN_RADIUS_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  POINT_BRUSH_RADIUS_CELLS,
  'soft',
  'stamp',
);

export const MANA_COST_PER_MAX_RADIUS_HARD_SCULPT = sculptManaCost(
  MANA_PER_BAND_CELL,
  MAX_BRUSH_RADIUS,
  'hard',
  'stamp',
);

export const MANA_CAPACITY = 5000;

export const FULL_POOL_MAX_RADIUS_HARD_STAMPS = Math.floor(
  MANA_CAPACITY / MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
);

export const MANA_REGEN_AT_DIFFICULTY_1 = 300;

export const MANA_REGEN_AT_DIFFICULTY_100 = 30;

export function manaRegenForDifficulty(difficulty: number): number {
  const rated = Number.isFinite(difficulty) ? difficulty : DEFAULT_WORLD_DIFFICULTY;
  const span = MAX_WORLD_DIFFICULTY - MIN_WORLD_DIFFICULTY;
  const t = Math.min(1, Math.max(0, (rated - MIN_WORLD_DIFFICULTY) / span));
  return (
    MANA_REGEN_AT_DIFFICULTY_1 +
    t * (MANA_REGEN_AT_DIFFICULTY_100 - MANA_REGEN_AT_DIFFICULTY_1)
  );
}

export const MANA_REGEN_ENV = 'MANA_REGEN_PER_S';

export const MAX_DRAINED_WAIT_S = 60;

export const MIN_FULL_REFILL_S = 1;

export const MIN_MANA_REGEN_PER_SECOND =
  MANA_COST_PER_MIN_RADIUS_SCULPT / MAX_DRAINED_WAIT_S;

export const MAX_MANA_REGEN_PER_SECOND = MANA_CAPACITY / MIN_FULL_REFILL_S;

export const MANA_INSTANT_REGEN_ENV = 'MANA_INSTANT_REGEN';

const MANA_INSTANT_REGEN_TRUTHY = new Set(['1', 'true', 'yes']);

export function instantRegenEnabled(raw: string | undefined): boolean {
  return raw !== undefined && MANA_INSTANT_REGEN_TRUTHY.has(raw.trim().toLowerCase());
}

export const MANA_INSTANT_REGEN_WARNING =
  `[mana] ${MANA_INSTANT_REGEN_ENV} is on — pools never drain. TEST SETTING; must not be on in a shipped world`;

export const MANA_REGEN_INVALID_WARNING = `[mana] ${MANA_REGEN_ENV} is not a positive finite number; falling back to this world's difficulty-derived rate`;

export const MANA_REGEN_CLAMPED_WARNING = `[mana] ${MANA_REGEN_ENV} clamped into [${MIN_MANA_REGEN_PER_SECOND}, ${MAX_MANA_REGEN_PER_SECOND}] mana/s`;

function clampManaRegenPerSecond(rate: number, onClamp?: () => void): number {
  if (rate < MIN_MANA_REGEN_PER_SECOND) {
    onClamp?.();
    return MIN_MANA_REGEN_PER_SECOND;
  }
  if (rate > MAX_MANA_REGEN_PER_SECOND) {
    onClamp?.();
    return MAX_MANA_REGEN_PER_SECOND;
  }
  return rate;
}

export function resolveManaRegenPerSecond(raw: string | undefined, difficulty: number): number {
  const derived = manaRegenForDifficulty(difficulty);

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return clampManaRegenPerSecond(derived);
  }

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(MANA_REGEN_INVALID_WARNING);
    return clampManaRegenPerSecond(derived);
  }

  return clampManaRegenPerSecond(parsed, () => {
    console.warn(MANA_REGEN_CLAMPED_WARNING);
  });
}
