// Contract test for the broadcast intensity rounding that moved out of
// weather's and storms' protocol.ts into shared/src/wire.ts, where the
// precision of a wire value belongs (#180's precedent).

import { describe, expect, it } from 'vitest';
import { BROADCAST_INTENSITY_DECIMALS, roundBroadcastIntensity } from '../src/index.ts';

describe('roundBroadcastIntensity', () => {
  it('keeps three decimals', () => {
    expect(BROADCAST_INTENSITY_DECIMALS).toBe(3);
    expect(roundBroadcastIntensity(0.123_456)).toBe(0.123);
    expect(roundBroadcastIntensity(0.123_5)).toBe(0.124);
  });

  it('clamps into [0, 1] — an intensity is a fraction of full strength', () => {
    expect(roundBroadcastIntensity(-0.4)).toBe(0);
    expect(roundBroadcastIntensity(1.4)).toBe(1);
  });
});
