// The hold-repeat ramp (client/src/input/sculptInput.ts, repeatDelayMs).
//
// These pin the CONTRACT the owner's 2026-08-19 report asked for — "start slow
// and progressively speed up" — plus the wire-rate invariant the rest of the
// client derives from it, rather than the arithmetic of any one step.

import { describe, expect, it } from 'vitest';
import {
  SCULPT_REPEAT_DELAY_MS,
  SCULPT_REPEAT_INTERVAL_MS,
  SCULPT_REPEAT_RAMP_FACTOR,
} from '../src/config.ts';
import { repeatDelayMs } from '../src/input/sculptInput.ts';

describe('repeatDelayMs', () => {
  it('starts at the full hold delay', () => {
    expect(repeatDelayMs(0)).toBe(SCULPT_REPEAT_DELAY_MS);
  });

  it('is monotonically non-increasing — it may only ever speed up', () => {
    for (let i = 1; i < 50; i++) {
      expect(repeatDelayMs(i)).toBeLessThanOrEqual(repeatDelayMs(i - 1));
    }
  });

  it('never dips below the floor, however long the hold', () => {
    // THE WIRE-RATE INVARIANT: terrain/prediction.ts sizes its in-flight cap
    // from SCULPT_REPEAT_INTERVAL_MS, and the server's 100 ms tick assumes no
    // more than one intent per tick. A ramp that undershot the floor would
    // quietly break both.
    for (let i = 0; i < 1000; i++) {
      expect(repeatDelayMs(i)).toBeGreaterThanOrEqual(SCULPT_REPEAT_INTERVAL_MS);
    }
  });

  it('reaches the floor and stays there', () => {
    expect(repeatDelayMs(999)).toBe(SCULPT_REPEAT_INTERVAL_MS);
    expect(repeatDelayMs(1000)).toBe(SCULPT_REPEAT_INTERVAL_MS);
  });

  it('decays by the ramp factor while above the floor', () => {
    const first = repeatDelayMs(0);
    const second = repeatDelayMs(1);
    expect(second).toBeGreaterThan(SCULPT_REPEAT_INTERVAL_MS); // still ramping
    expect(second).toBeCloseTo(first * SCULPT_REPEAT_RAMP_FACTOR, 6);
  });

  it('gives a deliberate click time to end before the second intent', () => {
    // A deliberate mouse click is press-to-release in ~80-150 ms, and a slow
    // one still lands under 300 ms — so one click must mean one band.
    const SLOWEST_DELIBERATE_CLICK_MS = 300;
    expect(repeatDelayMs(0)).toBeGreaterThan(SLOWEST_DELIBERATE_CLICK_MS);
  });

  it('reaches full speed within a couple of seconds of holding', () => {
    // The other half of the brief: a sustained hold must not feel sluggish.
    const FULL_SPEED_DEADLINE_MS = 2000;
    let elapsed = 0;
    let repeats = 0;
    while (repeatDelayMs(repeats) > SCULPT_REPEAT_INTERVAL_MS) {
      elapsed += repeatDelayMs(repeats);
      repeats++;
      expect(repeats).toBeLessThan(100); // ramp must terminate
    }
    expect(elapsed).toBeLessThan(FULL_SPEED_DEADLINE_MS);
  });
});
