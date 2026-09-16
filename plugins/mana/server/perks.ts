import { MANA_PER_BAND_CELL } from './scale.ts';

export const MANA_PERK_MIN_MULTIPLIER = 0.25;
export const MANA_PERK_MAX_MULTIPLIER = 4;

export const NEUTRAL_MANA_MULTIPLIER = 1;

export interface ManaPerk {
  readonly costMultiplier?: number;
  readonly regenMultiplier?: number;
}

interface EffectiveManaPerk {
  readonly costMultiplier: number;
  readonly regenMultiplier: number;
}

const NEUTRAL_PERK: EffectiveManaPerk = {
  costMultiplier: NEUTRAL_MANA_MULTIPLIER,
  regenMultiplier: NEUTRAL_MANA_MULTIPLIER,
};

const perksByPlayer = new Map<string, EffectiveManaPerk>();

function normalizeMultiplier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NEUTRAL_MANA_MULTIPLIER;
  if (value < MANA_PERK_MIN_MULTIPLIER) return MANA_PERK_MIN_MULTIPLIER;
  if (value > MANA_PERK_MAX_MULTIPLIER) return MANA_PERK_MAX_MULTIPLIER;
  return value;
}

export function setManaPerk(playerId: string, perk: ManaPerk): void {
  perksByPlayer.set(playerId, {
    costMultiplier: normalizeMultiplier(perk.costMultiplier),
    regenMultiplier: normalizeMultiplier(perk.regenMultiplier),
  });
}

export function clearManaPerk(playerId: string): void {
  perksByPlayer.delete(playerId);
}

export function clearAllManaPerks(): void {
  perksByPlayer.clear();
}

export function manaPerkOf(playerId: string): EffectiveManaPerk {
  return perksByPlayer.get(playerId) ?? NEUTRAL_PERK;
}

export function manaPerBandCellFor(playerId: string): number {
  return MANA_PER_BAND_CELL * manaPerkOf(playerId).costMultiplier;
}
