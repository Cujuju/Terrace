export const CYCLONE_DAMAGE_EVENT_NAME = 'cyclone:damage';

export const STRUCTURES_WIND_MIN_SEVERITY = 0.35;

export const STRUCTURES_WIND_DEMOLISH_CHANCE_PER_SEVERITY_SECOND = 0.08;

export const STRUCTURES_WIND_TIER_RESISTANCE = 0.5;

export function windDemolishChance(
  severity: number,
  durationSeconds: number,
  tier: number,
): number {
  const chance =
    severity *
    durationSeconds *
    STRUCTURES_WIND_DEMOLISH_CHANCE_PER_SEVERITY_SECOND *
    Math.pow(STRUCTURES_WIND_TIER_RESISTANCE, tier);
  return chance > 1 ? 1 : chance;
}
