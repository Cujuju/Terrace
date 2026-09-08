import { CA_SEED_PATTERNS_PER_ARRIVAL, attemptSeed, stepGeneration } from '../../server/life.ts';
import type { LiveCellRecord, PhantomWallWeight } from '../../server/life.ts';
import { isBuildableCell, type StructuresWorld } from '../../server/suitability.ts';
import { structureKey } from '../../protocol.ts';
import { createStructuresRng } from '../../server/rng.ts';
import { BAND_HEIGHT, CHUNK_SIZE, SEA_LEVEL } from '@terrace/shared';

const LAND_HEIGHT = 4 * BAND_HEIGHT;
const SEA_HEIGHT = SEA_LEVEL - BAND_HEIGHT;
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

export function archipelago(): StructuresWorld {
  return rectWorld(128, [
    [10, 10, 45, 45],
    [60, 20, 79, 39],
    [90, 70, 101, 81],
    [20, 90, 29, 99],
    [50, 100, 56, 106],
  ]);
}

export function lonePlateau(): StructuresWorld {
  return rectWorld(32, [[8, 8, 23, 23]]);
}

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
  { numerator: 2, denominator: 7 },
  { numerator: 1, denominator: 3 },
  { numerator: 3, denominator: 8 },
  { numerator: 1, denominator: 2 },
];

function pad(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

export interface SweepRow {
  readonly phantom: PhantomWallWeight;
  readonly died: number;
  readonly froze: number;
  readonly runs: readonly Run[];
}

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

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  console.log(
    `phantom wall fraction sweep — seeds ${SWEEP_SEED}…${SWEEP_SEED + SWEEP_ARRIVALS - 1}, ` +
      `${CA_SEED_PATTERNS_PER_ARRIVAL} patterns per arrival`,
  );
  report('ARCHIPELAGO', archipelago());
  report('LONE PLATEAU', lonePlateau());
}
