export const MS_PER_SECOND = 1000;

export const MIN_PULSE_PERIOD_S = 0.25;
export const MAX_PULSE_PERIOD_S = 60;

function usable(value: number): boolean {
  return Number.isFinite(value);
}

export function fillFraction(displayed: number, capacity: number): number {
  if (!usable(displayed) || !usable(capacity) || capacity <= 0) return 0;
  if (displayed <= 0) return 0;
  return displayed >= capacity ? 1 : displayed / capacity;
}

export function isPoolFull(displayed: number, capacity: number): boolean {
  if (!usable(displayed) || !usable(capacity) || capacity <= 0) return false;
  return displayed >= capacity;
}

export const RATE_DECIMAL_THRESHOLD = 1;

export function formatRegenRate(regenPerSecond: number): string {
  if (!usable(regenPerSecond) || regenPerSecond <= 0) return '—';
  const shown =
    regenPerSecond < RATE_DECIMAL_THRESHOLD
      ? regenPerSecond.toFixed(1)
      : String(Math.round(regenPerSecond));
  return `+${shown}/s`;
}

export function formatSculptCost(cost: number): string {
  if (!usable(cost) || cost <= 0) return '—';
  return `−${Math.round(cost)}/use`;
}

export function pulsePeriodSeconds(cost: number, regenPerSecond: number): number {
  if (!usable(cost) || cost <= 0) return MAX_PULSE_PERIOD_S;
  if (!usable(regenPerSecond) || regenPerSecond <= 0) return MAX_PULSE_PERIOD_S;

  const period = cost / regenPerSecond;
  if (period < MIN_PULSE_PERIOD_S) return MIN_PULSE_PERIOD_S;
  if (period > MAX_PULSE_PERIOD_S) return MAX_PULSE_PERIOD_S;
  return period;
}
