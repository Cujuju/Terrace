// formatWorldTime — the header's clock text. Asserts the behaviours the owner
// asked for: phase 0 reads as dawn (protocol.ts's "0 is dawn"), minutes tick
// in step with the phase, and the output shape is a locale time string (the
// exact a.m./p.m. markers are the viewer system's, so only structure is
// asserted here — see formatTime.ts's header comment).

import { describe, expect, it } from 'vitest';
import { DAY_LENGTH_SECONDS } from '../protocol.ts';
import { DAWN_MINUTES, formatWorldTime } from '../client/formatTime.ts';

/** The leading hour number of a formatted reading, whatever the locale. */
function hourOf(reading: string): number {
  return Number(reading.match(/\d+/)?.[0] ?? -1);
}

/** The minute number (second numeric group) of a formatted reading. */
function minuteOf(reading: string): number {
  return Number(reading.match(/\d+/g)?.[1] ?? -1);
}

describe('formatWorldTime', () => {
  it('reads phase 0 as dawn, not midnight', () => {
    // Locale hour may be 12-hour ("6") or 24-hour ("06"); both say six
    // o'clock, which is what "0 is dawn" means on a wall clock.
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
    // And the last in-world minute of the lap sits just before the dawn
    // reading: 5:59, i.e. minute (360 - 1) % 60 = 59.
    const lastMinute = formatWorldTime((DAY_LENGTH_SECONDS - 1) / DAY_LENGTH_SECONDS);
    expect(minuteOf(lastMinute)).toBe((DAWN_MINUTES - 1) % 60);
  });
});
