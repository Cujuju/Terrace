// THE PHANTOM-FRACTION SWEEP, kept alive by being run.
//
// support/phantomFractionSweep.ts is the runner that WALL_PHANTOM_NUMERATOR /
// WALL_PHANTOM_DENOMINATOR were chosen from (life.ts). It is a command-line
// tool, so nothing imported it — and a measurement tool that nothing imports
// stops compiling against the module it measures without anybody noticing,
// which is exactly how a load-bearing constant ends up justified by a script
// that no longer runs.
//
// This is a SMOKE RUN, not the sweep: two fractions, two arrivals, a fraction
// of the generations. It asserts the one thing the mechanism claims and the
// one thing the runner has to keep being able to do.
//
// WHAT IT DELIBERATELY DOES NOT ASSERT: the sweep's original verdict about
// which fraction keeps a lone plateau ALIVE AND UNFROZEN. Since buildings
// became permanent and clear their own square (life.ts, 2026-08-26), every
// board settles into a still life within a few generations whatever the
// fraction is, so "froze" no longer separates the fractions at all. Pinning
// the old verdict here would pin a reading of the board that the rules have
// since made meaningless. Re-run the full sweep before touching the constant.

import { describe, expect, it } from 'vitest';
import { WALL_PHANTOM_DENOMINATOR, WALL_PHANTOM_NUMERATOR } from '../server/life.ts';
import { lonePlateau, sweepFixture } from './support/phantomFractionSweep.ts';

/** Enough to separate the two fractions; far short of the real sweep's 200. */
const SMOKE_GENERATIONS = 40;
/** Two seeded arrivals — the smoke run's whole budget. */
const SMOKE_ARRIVALS = 2;

/** Hard walls: a wall slot is worth nothing, the behaviour the topology replaced. */
const NO_PHANTOM = { numerator: 0, denominator: WALL_PHANTOM_DENOMINATOR };
/** The shipped weight. */
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

    // The runner ran the fixture at all: a seeded arrival, and a board.
    expect(hardWalls.runs.length).toBe(SMOKE_ARRIVALS);
    expect(shipped.runs.length).toBe(SMOKE_ARRIVALS);

    // THE CLAIM ITSELF. A lone plateau is nearly all coastline, so pricing a
    // wall slot above zero is what keeps its cells from being permanently
    // under-neighboured — the whole reason topology.ts exists.
    expect(meanOf(shipped)).toBeGreaterThan(meanOf(hardWalls));
  });
});
