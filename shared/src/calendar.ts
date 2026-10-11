const MILLISECONDS_PER_SECOND = 1000;

export const DAY_LENGTH_SECONDS = 24 * 60;

export const DAY_LENGTH_MILLIS = DAY_LENGTH_SECONDS * MILLISECONDS_PER_SECOND;

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type Weekday = (typeof WEEKDAY_NAMES)[number];

export const DAYS_PER_WEEK = WEEKDAY_NAMES.length;

export const SETTLING_WEEKDAY = 0;

export const HOURS_PER_WORLD_DAY = 24;

export const DAWN_HOUR = 6;

const CALENDAR_LEAD_MILLIS = Math.floor((DAY_LENGTH_MILLIS * DAWN_HOUR) / HOURS_PER_WORLD_DAY);

export function dayOfSimMillis(simMillis: number): number {
  return Math.floor((simMillis + CALENDAR_LEAD_MILLIS) / DAY_LENGTH_MILLIS);
}

export function weekdayIndexOf(day: number): number {
  const index = day % DAYS_PER_WEEK;
  return index < 0 ? index + DAYS_PER_WEEK : index;
}

export function weekdayOf(day: number): Weekday {
  return WEEKDAY_NAMES[weekdayIndexOf(day)]!;
}

export function isSettlingDay(day: number): boolean {
  return weekdayIndexOf(day) === SETTLING_WEEKDAY;
}

export const WORLD_EPOCH_REAL_MILLIS = Date.UTC(2026, 0, 5);

export function simMillisAtRealTime(realMillis: number): number {
  if (!Number.isFinite(realMillis)) return 0;
  return Math.max(0, Math.floor(realMillis) - WORLD_EPOCH_REAL_MILLIS);
}

export function worldAgeDays(simMillis: number, genesisMillis: number): number {
  return Math.max(0, dayOfSimMillis(simMillis) - dayOfSimMillis(genesisMillis));
}
