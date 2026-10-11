export const CYCLONE_DAMAGE_EVENT_NAME = 'cyclone:damage';

export const FLORA_WIND_MIN_SEVERITY = 0.15;

export const FLORA_WIND_TREE_FELL_CHANCE_PER_SEVERITY_SECOND = 0.25;

export const FLORA_WIND_CROP_MIN_SEVERITY = FLORA_WIND_MIN_SEVERITY / 3;

export const FLORA_WIND_CROP_FLATTEN_CHANCE_PER_SEVERITY_SECOND = 1;

export const FLORA_WIND_CROP_REGROW_SECONDS = 60;

export function windEffectChance(
  severity: number,
  durationSeconds: number,
  chancePerSeveritySecond: number,
): number {
  const chance = severity * durationSeconds * chancePerSeveritySecond;
  return chance > 1 ? 1 : chance;
}
