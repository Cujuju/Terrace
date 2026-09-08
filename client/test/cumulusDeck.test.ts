import { describe, expect, it } from 'vitest';
import {
  DECK_TIERS,
  PUFF_COVERAGE_OVERLAP,
  puffsForCoverage,
  tierPopulations,
} from '../src/plugins/kit/cumulusDeck.ts';

describe('puffsForCoverage', () => {
  it('closes the disc: count times a puff’s area is the overlap factor', () => {
    for (const size of [0.08, 0.12, 0.13, 0.2]) {
      const count = puffsForCoverage(size);
      expect(count * size * size).toBeGreaterThanOrEqual(PUFF_COVERAGE_OVERLAP);
    }
  });

  it('grows as the puff shrinks — the coupling the constant states', () => {
    expect(puffsForCoverage(0.08)).toBeGreaterThan(puffsForCoverage(0.12));
    expect(puffsForCoverage(0.12)).toBeGreaterThan(puffsForCoverage(0.13));
  });

  it('is a whole number of puffs', () => {
    expect(Number.isInteger(puffsForCoverage(0.12))).toBe(true);
  });
});

describe('tierPopulations', () => {
  it('deals out every puff, so none is built and never placed', () => {
    for (const total of [1, 7, 119, 139, 1000]) {
      const counts = tierPopulations(total, DECK_TIERS);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(total);
    }
  });

  it('thins upward — the dome, stated as a population', () => {
    const counts = tierPopulations(139, DECK_TIERS);
    for (let tier = 1; tier < counts.length; tier++) {
      expect(counts[tier]!).toBeLessThanOrEqual(counts[tier - 1]!);
    }
    expect(counts[counts.length - 1]!).toBeLessThan(counts[0]!);
  });

  it('gives every tier something to draw at the shipped counts', () => {
    for (const count of tierPopulations(119, DECK_TIERS)) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it('puts a single-tier deck entirely in its base', () => {
    expect(tierPopulations(50, 1)).toEqual([50]);
  });
});
