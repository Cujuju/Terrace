export const CA_GENERATIONS_PER_TIER = 3;

export const STRUCTURE_UPGRADE_MIN_NEIGHBORS = 3;

function ageThresholdFor(nextStep: number): number {
  return nextStep * CA_GENERATIONS_PER_TIER;
}

/**
 * Is a settlement at `step` of its category chain old enough to take the next step? The first
 * step out of camp also needs neighbours, unless the settlement is blessed.
 */
export function isReadyToUpgrade(
  age: number,
  step: number,
  neighborCount: number,
  blessed = false,
): boolean {
  if (age < ageThresholdFor(step + 1)) return false;
  if (step >= 1) return true;
  return blessed || neighborCount >= STRUCTURE_UPGRADE_MIN_NEIGHBORS;
}
