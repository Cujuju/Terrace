import { describe, expect, it } from 'vitest';
import { WALL_PHANTOM_DENOMINATOR, WALL_PHANTOM_NUMERATOR } from '../server/life.ts';
import { lonePlateau, sweepFixture } from './support/phantomFractionSweep.ts';

const SMOKE_GENERATIONS = 40;
const SMOKE_ARRIVALS = 2;

const NO_PHANTOM = { numerator: 0, denominator: WALL_PHANTOM_DENOMINATOR };
const SHIPPED = { numerator: WALL_PHANTOM_NUMERATOR, denominator: WALL_PHANTOM_DENOMINATOR };

describe('the phantom-fraction sweep runner', () => {
  it('still drives the real rule, and still shows the phantom relieving starvation', () => {
    const [hardWalls, shipped] = sweepFixture(
      lonePlateau(),
      [NO_PHANTOM, SHIPPED],
      SMOKE_ARRIVALS,
      SMOKE_GENERATIONS,
    );

    const meanOf = (row: typeof hardWalls): number =>
      row.runs.reduce((sum, r) => sum + r.mean, 0) / row.runs.length;

    expect(hardWalls.runs.length).toBe(SMOKE_ARRIVALS);
    expect(shipped.runs.length).toBe(SMOKE_ARRIVALS);

    expect(meanOf(shipped)).toBeGreaterThan(meanOf(hardWalls));
  });
});
