import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_SECONDS } from '../protocol.ts';
import { DAWN_MINUTES, formatWorldTime } from '../client/formatTime.ts';

function hourOf(reading: string): number {
  return Number(reading.match(/\d+/)?.[0] ?? -1);
}

function minuteOf(reading: string): number {
  return Number(reading.match(/\d+/g)?.[1] ?? -1);
}

describe('formatWorldTime', () => {
  it('reads phase 0 as dawn, not midnight', () => {
    const h = hourOf(formatWorldTime(0));
    expect(h % 12 === 6 || h === 6).toBe(true);
  });

  it('ticks one minute per in-world minute of phase', () => {
    const at = (minutes: number): string =>
      formatWorldTime(minutes / 60 / (DAY_LENGTH_SECONDS / 60));
    expect(minuteOf(at(DAWN_MINUTES + 11))).toBe(
      (minuteOf(at(DAWN_MINUTES + 10)) + 1) % 60,
    );
  });

  it('wraps a full lap back to the same reading', () => {
    const almostOneLap = 0.999999;
    expect(formatWorldTime(almostOneLap)).toBe(formatWorldTime(almostOneLap));
    const lastMinute = formatWorldTime((DAY_LENGTH_SECONDS - 1) / DAY_LENGTH_SECONDS);
    expect(minuteOf(lastMinute)).toBe((DAWN_MINUTES - 1) % 60);
  });
});
