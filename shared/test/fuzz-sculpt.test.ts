import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CARVE_BANDS_PER_STROKE,
  cellIndex,
  columnCoversBand,
  createHeightmap,
  createSeededRng,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  forEachFootprintOffset,
  forEachLineCell,
  heightAt,
  inBounds,
  MAX_BAND,
  MAX_HEIGHT,
  MIN_BAND,
  quantizeToBand,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  sculptOptionsOf,
  sculptReachCells,
  SEA_LEVEL,
  sculptDisplacementUnits,
  setColumn,
  validateSculptIntent,
  type CellDiff,
  type Heightmap,
  type SculptIntent,
  type SculptProfile,
  type SculptTool,
} from '../src/index.ts';
import {
  allCells,
  carvedSlabRange,
  cellsWithin,
  cloneHeightmap,
  expectCarveCutsOnlyNamedSlabs,
  expectColumnsCanonical,
  expectDrawnCoverageContainsMaterial,
  expectGapsSurvive,
  expectGradientLimitOverDiff,
  expectHeightSumConserved,
  expectPriceIndependentOfTerrain,
  expectSculptDeterministic,
  expectSolidVolumeConserved,
  expectStrokeWithinReach,
  heightSum,
  makeSpan,
  snapshotColumns,
  solidVolume,
} from './support/invariants.ts';

const FUZZ_SEED = 0x7e44ace;
const FUZZ_STROKES = 400;
const FUZZ_WORLD_SIZE = 48;
const FUZZ_MAX_RADIUS = 5;
const FUZZ_MAX_SWEEP_CELLS = 6;

/** How often a stroke is replayed on a clone to pin that the math is deterministic. */
const FUZZ_DETERMINISM_EVERY = 3;

/** How often a free-anchor library smooth runs, the path the conservation laws hold on. */
const FUZZ_FREE_SMOOTH_EVERY = 5;

/** Cells past the stroke's reach that the per-stroke sweep still inspects. */
const INSPECTION_MARGIN_CELLS = 2;

const SPAN_BAND_SHARE = 0.5;
const SWEEP_SHARE = 0.3;

type Random = () => number;

function pick<T>(random: Random, from: readonly T[]): T {
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))]!;
}

function pickInt(random: Random, lo: number, hi: number): number {
  return lo + Math.min(hi - lo, Math.floor(random() * (hi - lo + 1)));
}

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

const FLAT_BANDS = 4;
const NOISE_BANDS = 8;
const TERRACE_TREAD_CELLS = 6;
const SHORE_SLOPE_PER_CELL = 6;

function flatWorld(size: number): Heightmap {
  const map = createHeightmap(size);
  map.cells.fill(FLAT_BANDS * BAND_HEIGHT);
  return map;
}

function noiseWorld(size: number): Heightmap {
  const map = createHeightmap(size);
  const rng = createSeededRng(FUZZ_SEED ^ size);
  for (let i = 0; i < map.cells.length; i++) {
    map.cells[i] = Math.floor(rng.next() * NOISE_BANDS * BAND_HEIGHT);
  }
  return map;
}

function terracedWorld(size: number): Heightmap {
  const map = createHeightmap(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      map.cells[cellIndex(map, x, y)] = Math.floor(x / TERRACE_TREAD_CELLS) * BAND_HEIGHT;
    }
  }
  return map;
}

function shorelineWorld(size: number): Heightmap {
  const map = createHeightmap(size);
  const shore = Math.floor(size / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      map.cells[cellIndex(map, x, y)] = (x - shore) * SHORE_SLOPE_PER_CELL;
    }
  }
  return map;
}

const ARCH_BASE_BANDS_ABOVE_SEA = 1;
const ARCH_ROOF_OPENING_BANDS = 5;
const ARCH_CREST_BANDS = 9;
const ARCH_TUNNEL_HALF_WIDTH_CELLS = 5;

/** The server's arch fixture, rebuilt here: a mound with a tunnel cut through it. */
function archWorld(size: number): Heightmap {
  const map = createHeightmap(size);
  const centre = Math.floor(size / 2);
  const base = quantizeToBand(SEA_LEVEL + ARCH_BASE_BANDS_ABOVE_SEA * BAND_HEIGHT);
  const roofFloor = base + ARCH_ROOF_OPENING_BANDS * BAND_HEIGHT;
  const radius = Math.floor(size / 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      if (dx * dx + dy * dy > radius * radius) continue;
      const top = base + ARCH_CREST_BANDS * BAND_HEIGHT;
      if (Math.abs(dx) <= ARCH_TUNNEL_HALF_WIDTH_CELLS) {
        setColumn(map, x, y, [makeSpan(BEDROCK_FLOOR, base), makeSpan(roofFloor, top)]);
      } else {
        setColumn(map, x, y, [makeSpan(BEDROCK_FLOOR, top)]);
      }
    }
  }
  return map;
}

const STACK_GROUND_BANDS = 3;
const STACK_GAP_BANDS = 3;
const STACK_SLAB_BANDS = 1;
const STACK_STOREYS = 3;

/** A column of stacked slabs: several drawn gaps in one cell, stepped across the map. */
function stackedTerraceWorld(size: number): Heightmap {
  const map = createHeightmap(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ground = (STACK_GROUND_BANDS + Math.floor(x / TERRACE_TREAD_CELLS)) * BAND_HEIGHT;
      const spans = [makeSpan(BEDROCK_FLOOR, ground)];
      let top = ground;
      for (let storey = 0; storey < STACK_STOREYS; storey++) {
        const floor = top + STACK_GAP_BANDS * BAND_HEIGHT;
        top = floor + STACK_SLAB_BANDS * BAND_HEIGHT;
        if (top > MAX_HEIGHT) break;
        spans.push(makeSpan(floor, top));
      }
      setColumn(map, x, y, spans);
    }
  }
  return map;
}

const WORLDS: readonly (readonly [string, (size: number) => Heightmap])[] = [
  ['flat', flatWorld],
  ['noise', noiseWorld],
  ['terraced', terracedWorld],
  ['shoreline', shorelineWorld],
  ['arch', archWorld],
  ['stacked', stackedTerraceWorld],
];

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

function coveredBandAt(map: Heightmap, x: number, y: number, random: Random): number {
  const here = drawnBandOfSample(heightAt(map, x, y));
  for (let tries = 0; tries < BAND_HEIGHT; tries++) {
    const band = here - Math.floor(random() * BAND_HEIGHT);
    if (band >= MIN_BAND && band <= MAX_BAND && columnCoversBand(map, x, y, band)) return band;
  }
  return Math.min(MAX_BAND, Math.max(MIN_BAND, here));
}

function makeIntent(map: Heightmap, random: Random): SculptIntent {
  const tool = pick(random, SCULPT_TOOLS);
  const profile = pick(random, SCULPT_PROFILES);
  const x = pickInt(random, 0, map.size - 1);
  const y = pickInt(random, 0, map.size - 1);
  const radius = pickInt(random, 1, FUZZ_MAX_RADIUS);
  const dir: 1 | -1 = tool === 'carve' ? -1 : random() < 0.5 ? 1 : -1;
  const intent: SculptIntent = { type: 'sculpt', x, y, radius, dir, tool, profile };
  if (tool === 'drag') {
    const targetBand = Math.min(
      MAX_BAND,
      Math.max(MIN_BAND, drawnBandOfSample(heightAt(map, x, y)) + pickInt(random, -1, 1)),
    );
    const swept = random() < SWEEP_SHARE;
    return {
      ...intent,
      targetBand,
      ...(swept
        ? {
            fromX: Math.min(map.size - 1, Math.max(0, x + pickInt(random, -FUZZ_MAX_SWEEP_CELLS, FUZZ_MAX_SWEEP_CELLS))),
            fromY: Math.min(map.size - 1, Math.max(0, y + pickInt(random, -FUZZ_MAX_SWEEP_CELLS, FUZZ_MAX_SWEEP_CELLS))),
          }
        : {}),
    };
  }
  if (tool === 'carve' || random() < SPAN_BAND_SHARE) {
    return { ...intent, spanBand: coveredBandAt(map, x, y, random) };
  }
  return intent;
}

function sweptOrigins(map: Heightmap, intent: SculptIntent): (readonly [number, number])[] {
  if (intent.fromX === undefined || intent.fromY === undefined) return [[intent.x, intent.y]];
  const cells: (readonly [number, number])[] = [];
  forEachLineCell(intent.fromX, intent.fromY, intent.x, intent.y, (x, y) => cells.push([x, y]));
  return cells;
}

function footprintCells(map: Heightmap, cx: number, cy: number, radius: number): Set<number> {
  const cells = new Set<number>();
  forEachFootprintOffset(radius, (dx, dy) => {
    const x = cx + dx;
    const y = cy + dy;
    if (inBounds(map, x, y)) cells.add(cellIndex(map, x, y));
  });
  return cells;
}

function inspected(map: Heightmap, intent: SculptIntent, reach: number): number[] {
  const cells = new Set<number>();
  for (const [ox, oy] of sweptOrigins(map, intent)) {
    for (const i of cellsWithin(map, ox, oy, reach + INSPECTION_MARGIN_CELLS)) cells.add(i);
  }
  return Array.from(cells);
}

// ---------------------------------------------------------------------------
// The fuzzer
// ---------------------------------------------------------------------------

function strokeContext(world: string, index: number, label: string, detail: unknown): string {
  return (
    `seed ${FUZZ_SEED} world "${world}" stroke ${index} ${label}\n` +
    `  repro: FUZZ_SEED=${FUZZ_SEED} world=${world} stroke=${index}\n` +
    `  ${JSON.stringify(detail)}`
  );
}

function priceOf(intent: SculptIntent): number {
  return sculptDisplacementUnits(
    intent.radius,
    intent.tool as SculptTool,
    intent.profile as SculptProfile,
  );
}

function runWireStroke(
  map: Heightmap,
  intent: SculptIntent,
  world: string,
  index: number,
): void {
  const context = strokeContext(world, index, 'wire', intent);
  const options = sculptOptionsOf(intent);
  const reach = sculptReachCells(intent.radius, options.profile, options.tool, options.anchor);
  const watched = inspected(map, intent, reach);
  const before = snapshotColumns(map, watched);
  const priceBefore = priceOf(intent);

  const replay = index % FUZZ_DETERMINISM_EVERY === 0 ? cloneHeightmap(map) : null;
  const amount = DEFAULT_SCULPT_AMOUNT * intent.dir;
  const diff = applySculpt(map, intent.x, intent.y, intent.radius, amount, options);

  if (replay !== null) {
    const replayDiff = applySculpt(replay, intent.x, intent.y, intent.radius, amount, options);
    expectSculptDeterministic(map, diff, replay, replayDiff, context);
  }

  expectColumnsCanonical(map, watched, context);
  expectDrawnCoverageContainsMaterial(map, watched, context);
  expectStrokeWithinReach(map, diff, sweptOrigins(map, intent), reach, context);
  expectPriceIndependentOfTerrain(
    intent.radius,
    intent.tool as SculptTool,
    intent.profile as SculptProfile,
    priceBefore,
    context,
  );

  if (options.tool === 'carve' && options.spanBand !== null) {
    const [lo, hi] = carvedSlabRange(options.spanBand, CARVE_BANDS_PER_STROKE);
    const footprint = footprintCells(map, intent.x, intent.y, intent.radius);
    expectCarveCutsOnlyNamedSlabs(map, before, diff, footprint, lo, hi, context);
  }
  if (options.tool === 'drag') expectGapsSurvive(map, before, context);
}

function runFreeSmooth(map: Heightmap, random: Random, world: string, index: number): void {
  const x = pickInt(random, 0, map.size - 1);
  const y = pickInt(random, 0, map.size - 1);
  const radius = pickInt(random, 1, FUZZ_MAX_RADIUS);
  const dir = random() < 0.5 ? 1 : -1;
  const stroke = { tool: 'smooth', anchor: 'free', spill: 'free', x, y, radius, dir } as const;
  const context = strokeContext(world, index, 'free smooth', stroke);
  const layered = map.columnSpans.size > 0;
  const sumBefore = heightSum(map);
  const volumeBefore = solidVolume(map);
  const reach = sculptReachCells(radius, 'hard', 'smooth', 'free');

  const diff = applySculpt(map, x, y, radius, DEFAULT_SCULPT_AMOUNT * dir, {
    tool: 'smooth',
    anchor: 'free',
    spill: 'free',
  });

  if (layered || map.columnSpans.size > 0) {
    expectSolidVolumeConserved(volumeBefore, map, context);
  } else {
    expectHeightSumConserved(sumBefore, map, context);
    expectGradientLimitOverDiff(map, diff, context);
  }
  const intent: SculptIntent = { type: 'sculpt', x, y, radius, dir, tool: 'smooth' };
  expectStrokeWithinReach(map, diff, sweptOrigins(map, intent), reach, context);
  expectColumnsCanonical(map, inspected(map, intent, reach), context);
}

describe('seeded sculpt fuzzer', () => {
  it.each(WORLDS.map(([name]) => name))('every invariant holds across %s', (name) => {
    const build = WORLDS.find(([world]) => world === name)![1];
    const map = build(FUZZ_WORLD_SIZE);
    const every = allCells(map);
    expectColumnsCanonical(map, every, `world "${name}" as built`);

    const random = createSeededRng(FUZZ_SEED).next;
    let applied = 0;
    for (let index = 0; index < FUZZ_STROKES; index++) {
      if (index % FUZZ_FREE_SMOOTH_EVERY === 0) {
        runFreeSmooth(map, random, name, index);
        continue;
      }
      const candidate = makeIntent(map, random);
      const intent = validateSculptIntent(candidate, map.size);
      expect(intent, `world "${name}" stroke ${index} built an invalid intent: ${JSON.stringify(candidate)}`)
        .not.toBeNull();
      runWireStroke(map, intent!, name, index);
      applied++;
    }

    expect(applied).toBeGreaterThan(0);
    expectColumnsCanonical(map, every, `world "${name}" after ${FUZZ_STROKES} strokes`);
    expectDrawnCoverageContainsMaterial(map, every, `world "${name}" after ${FUZZ_STROKES} strokes`);
  });
});
