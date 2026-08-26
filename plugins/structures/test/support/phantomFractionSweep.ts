// THE MEASUREMENT BEHIND WALL_PHANTOM_NUMERATOR / WALL_PHANTOM_DENOMINATOR.
//
// A RUNNER FIRST, kept in the repo so the constant's justification can be
// re-derived rather than believed:
//
//   node --experimental-strip-types \
//     plugins/structures/test/support/phantomFractionSweep.ts
//
// It runs THE REAL RULE (life.ts's own stepGeneration and GenerationSurvey,
// with the phantom fraction as their only variable — the one reason
// PhantomWallWeight is a parameter at all) over two fixtures shaped like the
// live world, with no seeding and no stirring during the run, and reports what
// each fraction does to the board. Backstops are switched off on purpose: the
// question is whether the RULE sustains a settlement, not whether a weekly
// arrival can keep re-founding one.
//
// IT IS ALSO IMPORTED BY A TEST (../phantom-fraction-sweep.test.ts), which
// runs a two-fraction smoke over the smaller fixture. That is what keeps this
// file compiling and honest: a runner nothing imports rots silently against
// the module it is supposed to be measuring, and the fraction it measured is
// load-bearing. Hence the exports below and the argv guard at the bottom —
// importing this file measures nothing until you ask it to.
//
// THE FIXTURES.
//   * ARCHIPELAGO — 128×128 of sea with five plateaus in it, from a 36-cell
//     headland down to a 7-cell rock (~8.5% of the board buildable after the
//     footprint survey erodes each plateau). That is the shape the live world
//     measured at: 19 of 429 unlocked chunks with any buildable cell.
//   * LONE PLATEAU — one 16-cell island, the case the choice rule is stated
//     against: the smallest fraction that keeps it alive without saturating it.
//
// THE COLUMNS, all averaged over the SWEEP_ARRIVALS runs of one fraction. `mean` and
// `max` are live-cell counts across a run; `final` is the count at the last
// generation; `fill` is final live ÷ buildable cells, i.e. how much of the
// available ground has been paved over; `died` counts runs that reached zero
// live cells; `froze` counts runs that reached a STILL LIFE (a generation
// identical to the one before it — an oscillator is not frozen), and `froze@`
// is the average generation at which those did. A fraction "keeps the plateau
// alive" only with 0 in BOTH died and froze.

import { CA_SEED_PATTERNS_PER_ARRIVAL, attemptSeed, stepGeneration } from '../../server/life.ts';
import type { LiveCellRecord, PhantomWallWeight } from '../../server/life.ts';
import { isBuildableCell, type StructuresWorld } from '../../server/suitability.ts';
import { structureKey } from '../../protocol.ts';
import { createStructuresRng } from '../../server/rng.ts';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL } from '@terrace/shared';

const LAND_HEIGHT = 4 * BAND_HEIGHT;
const SEA_HEIGHT = SEA_LEVEL - BAND_HEIGHT;
/** Generations per run, for the full command-line sweep. */
const SWEEP_GENERATIONS = 200;
const SWEEP_SEED = 20260825;

type Rect = readonly [number, number, number, number];

function rectWorld(size: number, rects: readonly Rect[]): StructuresWorld {
  const chunksPerEdge = size / CHUNK_SIZE;
  return {
    worldSize: size,
    chunksPerEdge,
    heightAt(x: number, y: number): number {
      for (const [x0, y0, x1, y1] of rects) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return LAND_HEIGHT;
      }
      return SEA_HEIGHT;
    },
    isChunkUnlocked: () => true,
    isCellUnlocked: () => true,
  };
}

function buildableCount(world: StructuresWorld): number {
  let n = 0;
  for (let y = 0; y < world.worldSize; y++) {
    for (let x = 0; x < world.worldSize; x++) {
      if (isBuildableCell(world, x, y)) n++;
    }
  }
  return n;
}

function sameBoard(a: ReadonlyMap<number, LiveCellRecord>, b: ReadonlyMap<number, LiveCellRecord>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

interface Run {
  readonly mean: number;
  readonly max: number;
  readonly final: number;
  readonly frozen: number | null;
  readonly dead: number | null;
  readonly fill: number;
}

function run(
  world: StructuresWorld,
  seedCells: ReadonlyArray<readonly [number, number]>,
  phantom: PhantomWallWeight,
  buildable: number,
  generations: number,
): Run {
  let live: ReadonlyMap<number, LiveCellRecord> = new Map(
    seedCells.map(([x, y]) => [structureKey(x, y), { age: 0, tier: 0 }] as const),
  );
  let total = 0;
  let max = 0;
  let frozen: number | null = null;
  let dead: number | null = null;
  for (let g = 1; g <= generations; g++) {
    const next = stepGeneration(world, live, phantom).nextLive;
    if (frozen === null && sameBoard(next, live)) frozen = g;
    live = next;
    total += live.size;
    if (live.size > max) max = live.size;
    if (dead === null && live.size === 0) dead = g;
  }
  return {
    mean: total / generations,
    max,
    final: live.size,
    frozen,
    dead,
    fill: buildable === 0 ? 0 : live.size / buildable,
  };
}

/** The five-plateau world: a sea with one headland, three islands and a rock. */
export function archipelago(): StructuresWorld {
  return rectWorld(128, [
    [10, 10, 45, 45],
    [60, 20, 79, 39],
    [90, 70, 101, 81],
    [20, 90, 29, 99],
    [50, 100, 56, 106],
  ]);
}

/** One 16×16 island, alone in the sea. */
export function lonePlateau(): StructuresWorld {
  return rectWorld(32, [[8, 8, 23, 23]]);
}

/**
 * ONE MONDAY'S ARRIVAL, from the real seeder. Different RNG seeds put
 * different patterns in different places, which is the whole reason the sweep
 * runs several: one arrival's fate is a coin flip, and a constant chosen off
 * one coin flip is a constant chosen off nothing.
 */
const SWEEP_ARRIVALS = 8;

function arrival(world: StructuresWorld, index: number): Array<readonly [number, number]> {
  const rng = createStructuresRng(SWEEP_SEED + index);
  const planted = attemptSeed(world, new Map<number, LiveCellRecord>(), rng) ?? [];
  if (planted.length === 0) throw new Error('fixture seeded nothing — the sweep would measure noise');
  return planted.map((c) => [c.x, c.y] as const);
}

const FRACTIONS: readonly PhantomWallWeight[] = [
  { numerator: 0, denominator: 4 },
  { numerator: 1, denominator: 8 },
  { numerator: 1, denominator: 6 },
  { numerator: 1, denominator: 5 },
  { numerator: 1, denominator: 4 },
  // 2/7 and 3/8 bracket 1/3 deliberately: they are the nearest fractions
  // either side of the point where THREE wall slots — an ordinary straight
  // coastline — are together worth one whole live neighbour.
  { numerator: 2, denominator: 7 },
  { numerator: 1, denominator: 3 },
  { numerator: 3, denominator: 8 },
  { numerator: 1, denominator: 2 },
];

function pad(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/** One fraction's result over one fixture: every arrival, and the two verdicts. */
export interface SweepRow {
  readonly phantom: PhantomWallWeight;
  /** Runs that reached zero live cells. */
  readonly died: number;
  /** Runs that reached a still life (an oscillator does not count). */
  readonly froze: number;
  readonly runs: readonly Run[];
}

/**
 * One fixture, every fraction — the sweep's actual measurement, split out from
 * the printing so a test can assert it rather than read it (see the header).
 */
export function sweepFixture(
  world: StructuresWorld,
  fractions: readonly PhantomWallWeight[],
  arrivals: number,
  generations: number,
): SweepRow[] {
  const buildable = buildableCount(world);
  const seeds = Array.from({ length: arrivals }, (_, i) => arrival(world, i));
  return fractions.map((phantom) => {
    const runs = seeds.map((seed) => run(world, seed, phantom, buildable, generations));
    return {
      phantom,
      died: runs.filter((r) => r.dead !== null).length,
      froze: runs.filter((r) => r.frozen !== null).length,
      runs,
    };
  });
}

function report(name: string, world: StructuresWorld): void {
  const buildable = buildableCount(world);
  const rows = sweepFixture(world, FRACTIONS, SWEEP_ARRIVALS, SWEEP_GENERATIONS);
  console.log(
    `\n${name} — ${buildable} buildable cells, ${SWEEP_ARRIVALS} arrivals × ` +
      `${SWEEP_GENERATIONS} generations, no seeding or stirring during the run`,
  );
  console.log('  fraction   mean   max  final   fill   died  froze  froze@');
  console.log('  ────────  ─────  ────  ─────  ─────  ─────  ─────  ──────');
  for (const { phantom, died, runs } of rows) {
    const avg = (pick: (r: Run) => number): number =>
      runs.reduce((sum, r) => sum + pick(r), 0) / runs.length;
    const froze = runs.filter((r) => r.frozen !== null);
    console.log(
      '  ' +
        pad(`${phantom.numerator}/${phantom.denominator}`, 8) +
        pad(avg((r) => r.mean).toFixed(1), 7) +
        pad(avg((r) => r.max).toFixed(0), 6) +
        pad(avg((r) => r.final).toFixed(1), 7) +
        pad(`${(avg((r) => r.fill) * 100).toFixed(1)}%`, 7) +
        pad(`${died}/${SWEEP_ARRIVALS}`, 7) +
        pad(`${froze.length}/${SWEEP_ARRIVALS}`, 7) +
        pad(
          froze.length === 0
            ? '—'
            : (froze.reduce((s, r) => s + (r.frozen ?? 0), 0) / froze.length).toFixed(0),
          8,
        ),
    );
  }
}

// RUN ONLY WHEN RUN — never on import. The test that keeps this file alive
// imports it for `sweepFixture`, and a 200-generation sweep of two fixtures on
// every import would be minutes of console noise on every test run.
if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  console.log(
    `phantom wall fraction sweep — seeds ${SWEEP_SEED}…${SWEEP_SEED + SWEEP_ARRIVALS - 1}, ` +
      `${CA_SEED_PATTERNS_PER_ARRIVAL} patterns per arrival`,
  );
  report('ARCHIPELAGO', archipelago());
  report('LONE PLATEAU', lonePlateau());
}
