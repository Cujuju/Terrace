import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_SECONDS } from '../protocol.ts';
import { DAWN_MINUTES, formatWorldTime } from '../client/formatTime.ts';
import { DayNightInterpolator, DEFAULT_INTERPOLATION_SECONDS } from '../client/interpolation.ts';

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

describe('interpolated calendar', () => {
  it('advances the calendar with the rendered midnight, including a nonzero genesis day', () => {
    const clock = new DayNightInterpolator();
    clock.receive({ phase: 0.74, day: 7, genesisDay: 20 });
    clock.advance(DEFAULT_INTERPOLATION_SECONDS);
    clock.receive({ phase: 0.76, day: 8, genesisDay: 20 });

    expect(clock.sampleClock().day).toBe(7);
    clock.advance(DEFAULT_INTERPOLATION_SECONDS);
    expect(clock.sampleClock()).toEqual({ phase: expect.closeTo(0.76), day: 8, genesisDay: 20 });
  });

  it('keeps the calendar day through dawn when the phase wraps', () => {
    const clock = new DayNightInterpolator();
    clock.receive({ phase: 0.99, day: 8, genesisDay: 20 });
    clock.advance(DEFAULT_INTERPOLATION_SECONDS);
    clock.receive({ phase: 0.01, day: 8, genesisDay: 20 });
    clock.advance(DEFAULT_INTERPOLATION_SECONDS / 2);
    expect(clock.sampleClock()).toEqual({ phase: expect.closeTo(0), day: 8, genesisDay: 20 });
  });

  it('samples elapsed calendar days after a gap rather than taking a phase shortcut', () => {
    const clock = new DayNightInterpolator();
    clock.receive({ phase: 0.1, day: 0, genesisDay: 0 });
    clock.advance(DEFAULT_INTERPOLATION_SECONDS);
    clock.receive({ phase: 0.2, day: 3, genesisDay: 0 });
    clock.advance(DEFAULT_INTERPOLATION_SECONDS);
    expect(clock.sampleClock()).toEqual({ phase: expect.closeTo(0.2), day: 3, genesisDay: 0 });
    clock.clear();
    expect(clock.sampleClock()).toEqual({ phase: 0, day: null, genesisDay: null });
  });
});
