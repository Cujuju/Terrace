import { MAX_STRUCTURE_TIER } from '../protocol.ts';

export const CA_GENERATIONS_PER_TIER = 3;

export const STRUCTURE_UPGRADE_MIN_NEIGHBORS = 3;

function ageThresholdFor(nextTier: number): number {
  return nextTier * CA_GENERATIONS_PER_TIER;
}

export function maybeAdvanceTier(
  age: number,
  tier: number,
  neighborCount: number,
  blessed = false,
): number {
  if (tier >= MAX_STRUCTURE_TIER) return tier;
  if (age < ageThresholdFor(tier + 1)) return tier;
  if (tier >= 1) return tier + 1;
  if (!blessed && neighborCount < STRUCTURE_UPGRADE_MIN_NEIGHBORS) return tier;
  return tier + 1;
}
