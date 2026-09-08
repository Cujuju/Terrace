import { afterEach, describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { MAX_BRUSH_RADIUS, WORLD_UNIT_CELLS } from '@terrace/shared';

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

const EXAMPLE_REGEN_PER_SECOND = MANA_REGEN_AT_DIFFICULTY_100;

const UNCLAMPED_REGEN_PER_SECOND =
  MANA_COST_PER_MAX_RADIUS_HARD_SCULPT / (MAX_PULSE_PERIOD_S / 2);

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
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, EXAMPLE_REGEN_PER_SECOND),
    ).toBeCloseTo(
      Math.max(MIN_PULSE_PERIOD_S, MANA_COST_PER_MIN_RADIUS_SCULPT / EXAMPLE_REGEN_PER_SECOND),
      10,
    );
    expect(pulsePeriodSeconds(25, 5)).toBe(5);
  });

  it('halves when the world regenerates twice as fast', () => {
    expect(pulsePeriodSeconds(25, 2)).toBe(pulsePeriodSeconds(25, 1) / 2);
  });

  it('stretches 45× when the player picks up the biggest hard brush', () => {
    const point = pulsePeriodSeconds(
      MANA_COST_PER_MIN_RADIUS_SCULPT,
      UNCLAMPED_REGEN_PER_SECOND,
    );
    const plateau = pulsePeriodSeconds(
      MANA_COST_PER_MAX_RADIUS_HARD_SCULPT,
      UNCLAMPED_REGEN_PER_SECOND,
    );
    expect(plateau / point).toBeCloseTo(
      MANA_COST_PER_MAX_RADIUS_HARD_SCULPT / MANA_COST_PER_MIN_RADIUS_SCULPT,
      10,
    );
    expect(plateau).toBeGreaterThan(point);
  });

  it('tracks the cost, so a cheaper sculpt pulses sooner', () => {
    expect(pulsePeriodSeconds(13, 20)).toBeLessThan(pulsePeriodSeconds(25, 20));
  });

  it('stays inside the legible band at the extremes of the configurable range', () => {
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, MAX_MANA_REGEN_PER_SECOND),
    ).toBe(MIN_PULSE_PERIOD_S);
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, MIN_MANA_REGEN_PER_SECOND),
    ).toBeCloseTo(60, 6);
    expect(
      pulsePeriodSeconds(MANA_COST_PER_MIN_RADIUS_SCULPT, MIN_MANA_REGEN_PER_SECOND),
    ).toBeLessThanOrEqual(MAX_PULSE_PERIOD_S);
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

describe('current-brush cost', () => {
  const POOL = {
    balance: MANA_CAPACITY,
    capacity: MANA_CAPACITY,
    manaPerBandCell: MANA_PER_BAND_CELL,
    regenPerSecond: EXAMPLE_REGEN_PER_SECOND,
  };

  afterEach(() => {
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

      setBrushRadius(MAX_BRUSH_RADIUS);
      expect(currentBrushCost()).toBe(
        sculptManaCost(MANA_PER_BAND_CELL, MAX_BRUSH_RADIUS, 'soft', 'stamp'),
      );

      setBrushProfile('hard');
      expect(currentBrushCost()).toBe(MANA_COST_PER_MAX_RADIUS_HARD_SCULPT);
      expect(currentBrushCost()).toBe(
        sculptManaCost(MANA_PER_BAND_CELL, MAX_BRUSH_RADIUS, 'soft', 'stamp'),
      );

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
      const pointPeriod = pulsePeriodSeconds(currentBrushCost(), UNCLAMPED_REGEN_PER_SECOND);

      setBrushRadius(MAX_BRUSH_RADIUS);
      setBrushProfile('hard');
      const plateauPeriod = pulsePeriodSeconds(currentBrushCost(), UNCLAMPED_REGEN_PER_SECOND);

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

      setManaPool({ ...POOL, manaPerBandCell: MANA_PER_BAND_CELL * 0.5 });
      expect(currentBrushCost()).toBe(Math.ceil(standard / 2));
      dispose();
    });
  });
});

describe('brush price readout', () => {
  it('prints the price as a per-use debit', () => {
    expect(formatSculptCost(MANA_COST_PER_MIN_RADIUS_SCULPT)).toBe('−14/use');
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
    expect(formatRegenRate(EXAMPLE_REGEN_PER_SECOND)).toBe('+30/s');
    expect(formatRegenRate(19.7)).toBe('+20/s');
    expect(formatRegenRate(1)).toBe('+1/s');
  });

  it('never rounds a world that IS refilling down to +0/s', () => {
    expect(formatRegenRate(MIN_MANA_REGEN_PER_SECOND)).toBe('+0.2/s');
    expect(formatRegenRate(0.05)).toBe('+0.1/s');
  });

  it('shows a dash rather than a confident wrong number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatRegenRate(bad)).toBe('—');
    }
  });
});
