import { DAY_LENGTH_SECONDS } from '../protocol.ts';
import { DAWN_HOUR, weekdayOf } from '@terrace/shared';
import type { WorldClockReading } from '../../../client/src/plugins/hudPanels.ts';

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const WORLD_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

let lastTotalMinutes = -1;
let lastFormatted = '';

export const DAWN_MINUTES = DAWN_HOUR * MINUTES_PER_HOUR;

export function formatWorldTime(phase: number): string {
  const totalMinutes = Math.floor(phase * DAY_LENGTH_SECONDS) + DAWN_MINUTES;
  if (totalMinutes === lastTotalMinutes) return lastFormatted;
  const hour = Math.floor(totalMinutes / MINUTES_PER_HOUR) % HOURS_PER_DAY;
  const minute = totalMinutes % MINUTES_PER_HOUR;
  const instant = new Date(Date.UTC(2000, 0, 1, hour, minute));
  lastTotalMinutes = totalMinutes;
  lastFormatted = WORLD_TIME_FORMAT.format(instant);
  return lastFormatted;
}

export function worldClockReading(
  phase: number,
  day: number | null,
  genesisDay: number | null,
): WorldClockReading {
  const wholeMinutes = Math.floor(phase * DAY_LENGTH_SECONDS);
  const known = day !== null && genesisDay !== null;
  return {
    phase: wholeMinutes / DAY_LENGTH_SECONDS,
    time: formatWorldTime(phase),
    weekday: known ? weekdayOf(day + genesisDay) : null,
    day: known ? day + 1 : null,
  };
}
