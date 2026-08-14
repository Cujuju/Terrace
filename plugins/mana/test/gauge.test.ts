// The gauge's display arithmetic, tested without a DOM.
//
// This is the half of the HUD that can actually be wrong in a way tests can
// catch: the component is markup, but the smoothing, the clamping and the
// pulse-period derivation are numbers, and the pulse period in particular is a
// CLAIM TO THE PLAYER — "one grain = one more sculpt" — that must hold for
// every rate a deployment can configure.

import { describe, expect, it } from 'vitest';
import {
  MAX_DISPLAY_STEP_S,
  MAX_PULSE_PERIOD_S,
  MIN_PULSE_PERIOD_S,
  advanceDisplayBalance,
  fillFraction,
  formatRegenRate,
  isPoolFull,
  pulsePeriodSeconds,
  syncedDisplayBalance,
} from '../client/gauge.ts';
import {
  DEFAULT_MANA_REGEN_PER_SECOND,
  MANA_CAPACITY,
  MANA_COST_PER_SCULPT,
  MAX_MANA_REGEN_PER_SECOND,
  MIN_MANA_REGEN_PER_SECOND,
} from '../server/index.ts';

describe('display advance', () => {
  it('advances at exactly the pushed rate', () => {
    // dt values here are inside MAX_DISPLAY_STEP_S; the cap has its own test.
    expect(advanceDisplayBalance(100, MANA_CAPACITY, 20, 0.2)).toBe(104);
    expect(advanceDisplayBalance(100, MANA_CAPACITY, 20, 0.05)).toBe(101);
    // A slower world visibly trickles: same frame, a twentieth of the gain.
    expect(advanceDisplayBalance(100, MANA_CAPACITY, 1, 0.2)).toBe(100.2);
  });

  it('never advances past capacity', () => {
    expect(advanceDisplayBalance(MANA_CAPACITY - 1, MANA_CAPACITY, 20, 1)).toBe(MANA_CAPACITY);
    expect(advanceDisplayBalance(MANA_CAPACITY, MANA_CAPACITY, 20, 1)).toBe(MANA_CAPACITY);
  });

  it('caps a single frame step, so a backgrounded tab cannot invent a full pool', () => {
    // A tab hidden for an hour reports one enormous frame on return. Only
    // MAX_DISPLAY_STEP_S of it is trusted; the next server push does the rest.
    const hugeCapacity = 1_000_000;
    expect(advanceDisplayBalance(0, hugeCapacity, 20, 3600)).toBe(20 * MAX_DISPLAY_STEP_S);
    // A step at the cap is still taken in full — the cap must not truncate the
    // frames a genuinely slow machine produces.
    expect(advanceDisplayBalance(0, hugeCapacity, 20, MAX_DISPLAY_STEP_S)).toBe(
      20 * MAX_DISPLAY_STEP_S,
    );
  });

  it('freezes rather than corrupts when an input is unusable', () => {
    for (const dt of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      expect(advanceDisplayBalance(100, MANA_CAPACITY, 20, dt)).toBe(100);
    }
    for (const rate of [Number.NaN, 0, -20, Number.POSITIVE_INFINITY]) {
      expect(advanceDisplayBalance(100, MANA_CAPACITY, rate, 0.2)).toBe(100);
    }
    expect(advanceDisplayBalance(100, 0, 20, 0.2)).toBe(100);
    expect(advanceDisplayBalance(Number.NaN, MANA_CAPACITY, 20, 0.2)).toBe(0);
  });
});

describe('resync', () => {
  it('takes the pushed balance wholesale', () => {
    // Whatever the smoothing had climbed to, an authoritative push replaces it —
    // including downwards, which is what a local gate debit looks like.
    expect(syncedDisplayBalance(310, MANA_CAPACITY)).toBe(310);
    expect(syncedDisplayBalance(0, MANA_CAPACITY)).toBe(0);
  });

  it('clamps a balance that could not be drawn', () => {
    expect(syncedDisplayBalance(MANA_CAPACITY + 50, MANA_CAPACITY)).toBe(MANA_CAPACITY);
    expect(syncedDisplayBalance(-5, MANA_CAPACITY)).toBe(0);
    expect(syncedDisplayBalance(Number.NaN, MANA_CAPACITY)).toBe(0);
    expect(syncedDisplayBalance(10, 0)).toBe(0);
  });

  it('round-trips advance → resync: the local estimate is never sticky', () => {
    const smoothed = advanceDisplayBalance(300, MANA_CAPACITY, 20, 0.2);
    expect(smoothed).toBeGreaterThan(300);
    // Server says 275 (the player spent while the estimate was climbing).
    expect(syncedDisplayBalance(275, MANA_CAPACITY)).toBe(275);
  });
});

describe('fill level', () => {
  it('is the fraction of the vessel, clamped to it', () => {
    expect(fillFraction(300, 600)).toBe(0.5);
    expect(fillFraction(0, 600)).toBe(0);
    expect(fillFraction(600, 600)).toBe(1);
    expect(fillFraction(900, 600)).toBe(1);
    expect(fillFraction(-1, 600)).toBe(0);
    expect(fillFraction(300, 0)).toBe(0);
  });

  it('reports fullness, which is what pauses the cue', () => {
    expect(isPoolFull(600, 600)).toBe(true);
    expect(isPoolFull(599.9, 600)).toBe(false);
    expect(isPoolFull(Number.NaN, 600)).toBe(false);
  });
});

describe('pulse period — the rate readout', () => {
  it('is one sculpt worth of regen, in seconds', () => {
    expect(pulsePeriodSeconds(MANA_COST_PER_SCULPT, DEFAULT_MANA_REGEN_PER_SECOND)).toBe(1.25);
    expect(pulsePeriodSeconds(25, 5)).toBe(5);
  });

  it('halves when the world regenerates twice as fast', () => {
    // The animation IS the rate: double the rate, double the grain frequency.
    expect(pulsePeriodSeconds(25, 2)).toBe(pulsePeriodSeconds(25, 1) / 2);
  });

  it('tracks the cost too, so a cheaper sculpt pulses sooner', () => {
    // Not an assumption that cost is constant: it is per-player (perks) and may
    // stop being flat-per-sculpt entirely.
    expect(pulsePeriodSeconds(13, 20)).toBeLessThan(pulsePeriodSeconds(25, 20));
  });

  it('stays inside the legible band at the extremes of the configurable range', () => {
    // Fastest world the server will accept: the true period is ~42 ms, which
    // would read as flicker rather than as grains.
    expect(pulsePeriodSeconds(MANA_COST_PER_SCULPT, MAX_MANA_REGEN_PER_SECOND)).toBe(
      MIN_PULSE_PERIOD_S,
    );
    // Slowest world: the true period is the full drained wait, still legible.
    expect(pulsePeriodSeconds(MANA_COST_PER_SCULPT, MIN_MANA_REGEN_PER_SECOND)).toBeCloseTo(60, 6);
    expect(pulsePeriodSeconds(MANA_COST_PER_SCULPT, MIN_MANA_REGEN_PER_SECOND)).toBeLessThanOrEqual(
      MAX_PULSE_PERIOD_S,
    );
  });

  it('degrades an unusable rate or cost to the slowest period', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pulsePeriodSeconds(MANA_COST_PER_SCULPT, bad)).toBe(MAX_PULSE_PERIOD_S);
      expect(pulsePeriodSeconds(bad, DEFAULT_MANA_REGEN_PER_SECOND)).toBe(MAX_PULSE_PERIOD_S);
    }
  });
});

describe('numeric rate readout', () => {
  it('shows whole units at playable rates', () => {
    expect(formatRegenRate(DEFAULT_MANA_REGEN_PER_SECOND)).toBe('+20/s');
    expect(formatRegenRate(19.7)).toBe('+20/s');
    expect(formatRegenRate(1)).toBe('+1/s');
  });

  it('never rounds a world that IS refilling down to +0/s', () => {
    expect(formatRegenRate(MIN_MANA_REGEN_PER_SECOND)).toBe('+0.4/s');
    expect(formatRegenRate(0.05)).toBe('+0.1/s');
  });

  it('shows a dash rather than a confident wrong number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatRegenRate(bad)).toBe('—');
    }
  });
});
