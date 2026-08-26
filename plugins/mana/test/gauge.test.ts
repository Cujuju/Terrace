// The gauge's display arithmetic, tested without a DOM.
//
// This is the half of the HUD that can actually be wrong in a way tests can
// catch: the component is markup, but the smoothing, the clamping and the
// pulse-period derivation are numbers, and the pulse period in particular is a
// CLAIM TO THE PLAYER — "one grain = one more sculpt" — that must hold for
// every rate a deployment can configure.

import { afterEach, describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { MAX_BRUSH_RADIUS, WORLD_UNIT_CELLS } from '@terrace/shared';

/**
 * The brush the HUD starts on — the ladder's first rung, one world unit of
 * ground (client/src/state/hudState.ts's BRUSH_RADII). NOT shared's
 * MIN_BRUSH_RADIUS since the 2026-08-21 re-sample: that is the protocol's
 * one-CELL floor, which no picker offers, so a gauge test driven by it would
 * be reading a brush no player can select.
 */
const POINT_BRUSH_RADIUS = 1 * WORLD_UNIT_CELLS;
import {
  setBrushProfile,
  setBrushRadius,
} from '../../../client/src/state/hudState.ts';
import {
  MAX_PULSE_PERIOD_S,
  MIN_PULSE_PERIOD_S,
  fillFraction,
  formatRegenRate,
  formatSculptCost,
  isPoolFull,
  pulsePeriodSeconds,
} from '../client/gauge.ts';
import { currentBrushCost, setManaPool } from '../client/state.ts';
import { sculptManaCost } from '../pricing.ts';
import {
  MANA_CAPACITY,
  MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
  MANA_COST_PER_MIN_RADIUS_SCULPT,
  MANA_PER_BAND_CELL,
  MANA_REGEN_AT_DIFFICULTY_100,
  MAX_MANA_REGEN_PER_SECOND,
  MIN_MANA_REGEN_PER_SECOND,
} from '../server/index.ts';

/**
 * A concrete, plausible world rate for the examples below. The gauge has no
 * default rate of its own — it animates whatever the balance push carries — so
 * this is a stand-in, and the punishing anchor (20/s) is used because it is the
 * whole number the readout examples in this file were written against.
 */
const EXAMPLE_REGEN_PER_SECOND = MANA_REGEN_AT_DIFFICULTY_100;

describe('fill level', () => {
  it('is the fraction of the vessel, clamped to it', () => {
    const half = MANA_CAPACITY / 2;
    expect(fillFraction(half, MANA_CAPACITY)).toBe(0.5);
    expect(fillFraction(0, MANA_CAPACITY)).toBe(0);
    expect(fillFraction(MANA_CAPACITY, MANA_CAPACITY)).toBe(1);
    expect(fillFraction(MANA_CAPACITY * 1.5, MANA_CAPACITY)).toBe(1);
    expect(fillFraction(-1, MANA_CAPACITY)).toBe(0);
    expect(fillFraction(half, 0)).toBe(0);
  });

  it('reports fullness, which is what pauses the cue', () => {
    expect(isPoolFull(MANA_CAPACITY, MANA_CAPACITY)).toBe(true);
    expect(isPoolFull(MANA_CAPACITY - 0.1, MANA_CAPACITY)).toBe(false);
    expect(isPoolFull(Number.NaN, MANA_CAPACITY)).toBe(false);
  });
});

describe('pulse period — the rate readout', () => {
  it('is one CURRENT-BRUSH sculpt worth of regen, in seconds', () => {
    // The point brush at 20/s: 7 mana at 20/s = 0.35 s per grain.
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, EXAMPLE_REGEN_PER_SECOND),
    ).toBeCloseTo(MANA_COST_PER_MIN_RADIUS_SCULPT / EXAMPLE_REGEN_PER_SECOND, 10);
    expect(pulsePeriodSeconds(25, 5)).toBe(5);
  });

  it('halves when the world regenerates twice as fast', () => {
    // The animation IS the rate: double the rate, double the grain frequency.
    expect(pulsePeriodSeconds(25, 2)).toBe(pulsePeriodSeconds(25, 1) / 2);
  });

  it('stretches 45× when the player picks up the biggest hard brush', () => {
    // Volume pricing made this the headline case: the same world, the same
    // regen, but the wait between sculpts is the wait for 45 band-cells.
    const point = pulsePeriodSeconds(
      MANA_COST_PER_MIN_RADIUS_SCULPT,
      EXAMPLE_REGEN_PER_SECOND,
    );
    const plateau = pulsePeriodSeconds(
      MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
      EXAMPLE_REGEN_PER_SECOND,
    );
    expect(plateau / point).toBeCloseTo(
      MANA_COST_PER_MAX_RADIUS_HARD_SCULPT / MANA_COST_PER_MIN_RADIUS_SCULPT,
      10,
    );
    expect(plateau).toBeGreaterThan(point);
  });

  it('tracks the cost, so a cheaper sculpt pulses sooner', () => {
    // Cost is not a constant: it is per-player (perks) AND per-brush (volume).
    expect(pulsePeriodSeconds(13, 20)).toBeLessThan(pulsePeriodSeconds(25, 20));
  });

  it('stays inside the legible band at the extremes of the configurable range', () => {
    // Fastest world the server will accept: the true period is ~7 ms, which
    // would read as flicker rather than as grains.
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, MAX_MANA_REGEN_PER_SECOND),
    ).toBe(MIN_PULSE_PERIOD_S);
    // Slowest world: the true period is the full drained wait, still legible.
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, MIN_MANA_REGEN_PER_SECOND),
    ).toBeCloseTo(60, 6);
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, MIN_MANA_REGEN_PER_SECOND),
    ).toBeLessThanOrEqual(MAX_PULSE_PERIOD_S);
    // ...and the most expensive brush in the slowest world is clamped rather
    // than drawn as a grain that takes three quarters of an hour to fall.
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT, MIN_MANA_REGEN_PER_SECOND),
    ).toBe(MAX_PULSE_PERIOD_S);
  });

  it('degrades an unusable rate or cost to the slowest period', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, bad)).toBe(MAX_PULSE_PERIOD_S);
      expect(pulsePeriodSeconds(bad, EXAMPLE_REGEN_PER_SECOND)).toBe(MAX_PULSE_PERIOD_S);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE BRUSH PRICE READOUT. Since volume pricing the gauge shows what the brush
// in the player's hand costs, and times its falling-grain cue by it. Both are
// derived from the HUD's live brush signals, so the claim worth testing is that
// they RE-DERIVE — a value frozen in a component-body const is the project's
// standard Solid failure and would silently show the price of whatever brush
// happened to be selected at mount.
// ────────────────────────────────────────────────────────────────────────────

describe('current-brush cost', () => {
  /** A pool exactly as the server pushes it: a rate, not a price. */
  const POOL = {
    balance: MANA_CAPACITY,
    capacity: MANA_CAPACITY,
    manaPerBandCell: MANA_PER_BAND_CELL,
    regenPerSecond: EXAMPLE_REGEN_PER_SECOND,
  };

  afterEach(() => {
    // Module-scope signals: leave the HUD as this suite found it.
    setManaPool(null);
    setBrushRadius(POINT_BRUSH_RADIUS);
    setBrushProfile('soft');
  });

  it('is zero when the server has declared no economy', () => {
    setManaPool(null);
    expect(currentBrushCost()).toBe(0);
  });

  it('re-derives when the player changes brush, without a new push', () => {
    createRoot((dispose) => {
      setManaPool(POOL);
      setBrushRadius(POINT_BRUSH_RADIUS);
      setBrushProfile('soft');
      expect(currentBrushCost()).toBe(MANA_COST_PER_MIN_RADIUS_SCULPT);

      // Radius alone.
      setBrushRadius(MAX_BRUSH_RADIUS);
      expect(currentBrushCost()).toBe(
        sculptManaCost(MANA_PER_BAND_CELL, MAX_BRUSH_RADIUS, 'soft', 'stamp'),
      );

      // Profile alone — same radius, sheer edges, more rock.
      setBrushProfile('hard');
      expect(currentBrushCost()).toBe(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);
      expect(currentBrushCost()).toBeGreaterThan(
        sculptManaCost(MANA_PER_BAND_CELL, MAX_BRUSH_RADIUS, 'soft', 'stamp'),
      );

      // And back down again: nothing here is sticky. BOTH dials have to go
      // back — the point brush covers a world unit of ground since the
      // 2026-08-21 re-sample, so soft and hard are no longer the same stroke on
      // it the way they were on a single cell.
      setBrushRadius(POINT_BRUSH_RADIUS);
      setBrushProfile('soft');
      expect(currentBrushCost()).toBe(MANA_COST_PER_MIN_RADIUS_SCULPT);
      dispose();
    });
  });

  it('re-times the grain cue with the brush', () => {
    createRoot((dispose) => {
      setManaPool(POOL);
      setBrushRadius(POINT_BRUSH_RADIUS);
      setBrushProfile('soft');
      const pointPeriod = pulsePeriodSeconds(currentBrushCost(), POOL.regenPerSecond);

      setBrushRadius(MAX_BRUSH_RADIUS);
      setBrushProfile('hard');
      const plateauPeriod = pulsePeriodSeconds(currentBrushCost(), POOL.regenPerSecond);

      expect(plateauPeriod).toBeGreaterThan(pointPeriod);
      expect(plateauPeriod / pointPeriod).toBeCloseTo(
        MANA_COST_PER_MAX_RADIUS_HARD_SCULPT / MANA_COST_PER_MIN_RADIUS_SCULPT,
        10,
      );
      dispose();
    });
  });

  it('tracks a perk arriving on the wire, at the same brush', () => {
    createRoot((dispose) => {
      setBrushRadius(MAX_BRUSH_RADIUS);
      setBrushProfile('hard');
      setManaPool(POOL);
      const standard = currentBrushCost();

      // A relic halves this player's rate; the server pushes the new rate.
      setManaPool({ ...POOL, manaPerBandCell: MANA_PER_BAND_CELL * 0.5 });
      expect(currentBrushCost()).toBe(Math.ceil(standard / 2));
      dispose();
    });
  });
});

describe('brush price readout', () => {
  it('prints the price as a per-use debit', () => {
    expect(formatSculptCost(MANA_COST_PER_MIN_RADIUS_SCULPT)).toBe('−7/use');
    expect(formatSculptCost(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT)).toBe('−281/use');
  });

  it('shows a dash rather than claiming sculpting is free', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatSculptCost(bad)).toBe('—');
    }
  });
});

describe('numeric rate readout', () => {
  it('shows whole units at playable rates', () => {
    expect(formatRegenRate(EXAMPLE_REGEN_PER_SECOND)).toBe('+20/s');
    expect(formatRegenRate(19.7)).toBe('+20/s');
    expect(formatRegenRate(1)).toBe('+1/s');
  });

  it('never rounds a world that IS refilling down to +0/s', () => {
    // The band's floor is now 6/60 = 0.1 mana/s (one point stamp a minute).
    expect(formatRegenRate(MIN_MANA_REGEN_PER_SECOND)).toBe('+0.1/s');
    expect(formatRegenRate(0.05)).toBe('+0.1/s');
  });

  it('shows a dash rather than a confident wrong number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatRegenRate(bad)).toBe('—');
    }
  });
});
