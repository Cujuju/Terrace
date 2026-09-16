import { expect } from 'vitest';
import {
  bandFloorHeight,
  bandLevelHeight,
  BEDROCK_BAND,
  cellX,
  cellY,
  chebyshevDistance,
  columnCoversBand,
  createHeightmap,
  floorBandOfHeight,
  isGapDrawn,
  isSpanDrawn,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_HEIGHT,
  RELAX_SLACK,
  readSpans,
  CARVE_DEFAULT_DEPTH_BANDS,
  sculptDisplacementUnits,
  spanCapBand,
  spanCapHeight,
  type CellDiff,
  type Heightmap,
  type SculptProfile,
  type SculptTool,
  type Span,
} from '../../src/index.ts';

// ---------------------------------------------------------------------------
// Span shape. The ONLY place this suite knows how a Span is built or read;
// re-point these functions and every invariant below follows.
// ---------------------------------------------------------------------------

/** `floor` is a raw height: the band it stands in is what the span records. */
export function makeSpan(floor: number, ceiling: number): Span {
  return { floorBand: floorBandOfHeight(floor), ceiling };
}

/** Raw height the span's material starts at: the bottom of its floor band. */
export function spanFloorOf(span: Span): number {
  return bandFloorHeight(span.floorBand);
}

export function spanFloorBandOf(span: Span): number {
  return span.floorBand;
}

export function spanCeilingOf(span: Span): number {
  return span.ceiling;
}

/** Highest band level the span draws as covered. */
export function spanCapOf(span: Span): number {
  return spanCapHeight(span);
}

/** Lowest band level the span draws as covered. */
export function spanBaseOf(span: Span): number {
  return bandLevelHeight(span.floorBand);
}

export function spanIsDrawn(span: Span): boolean {
  return isSpanDrawn(span);
}

export function gapIsDrawn(lower: Span, upper: Span): boolean {
  return isGapDrawn(lower, upper);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export type ColumnSnapshot = ReadonlyMap<number, readonly Span[]>;

export function snapshotColumns(map: Heightmap, cells: Iterable<number>): ColumnSnapshot {
  const out = new Map<number, readonly Span[]>();
  for (const i of cells) out.set(i, readSpans(map, cellX(map.size, i), cellY(map.size, i)));
  return out;
}

export function allCells(map: Heightmap): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.cells.length; i++) out.push(i);
  return out;
}

export function cellsWithin(map: Heightmap, cx: number, cy: number, reach: number): number[] {
  const out: number[] = [];
  const x0 = Math.max(0, cx - reach);
  const x1 = Math.min(map.size - 1, cx + reach);
  const y0 = Math.max(0, cy - reach);
  const y1 = Math.min(map.size - 1, cy + reach);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * map.size + x);
  return out;
}

export function heightSum(map: Heightmap): number {
  let total = 0;
  for (let i = 0; i < map.cells.length; i++) total += map.cells[i]!;
  return total;
}

export function solidVolume(map: Heightmap): number {
  let total = 0;
  for (let i = 0; i < map.cells.length; i++) {
    for (const span of readSpans(map, cellX(map.size, i), cellY(map.size, i))) {
      total += spanCeilingOf(span) - spanFloorOf(span);
    }
  }
  return total;
}

export function cloneHeightmap(map: Heightmap): Heightmap {
  const copy = createHeightmap(map.size);
  copy.cells.set(map.cells);
  for (const [i, packed] of map.columnSpans) copy.columnSpans.set(i, packed.slice());
  return copy;
}

const MAX_REPORTED_VIOLATIONS = 4;

function report(violations: readonly string[], context: string): void {
  expect(violations.slice(0, MAX_REPORTED_VIOLATIONS), context).toEqual([]);
}

function at(map: Heightmap, i: number): string {
  return `(${cellX(map.size, i)}, ${cellY(map.size, i)})`;
}

function describeColumn(spans: readonly Span[]): string {
  return spans.map((s) => `[band ${spanFloorBandOf(s)}, ${spanCeilingOf(s)}]`).join(' ');
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** Every column is canonical: floored at bedrock, ascending, every span and every gap drawn. */
export function expectColumnsCanonical(
  map: Heightmap,
  cells: Iterable<number>,
  context = '',
): void {
  const violations: string[] = [];
  for (const i of cells) {
    const spans = readSpans(map, cellX(map.size, i), cellY(map.size, i));
    const where = `${at(map, i)} ${describeColumn(spans)}`;
    if (spans.length === 0) {
      violations.push(`${where}: no span at all`);
      continue;
    }
    if (spanFloorBandOf(spans[0]!) !== BEDROCK_BAND) {
      violations.push(
        `${where}: bottom span floors in band ${spanFloorBandOf(spans[0]!)}, not ${BEDROCK_BAND}`,
      );
    }
    for (let k = 0; k < spans.length; k++) {
      const span = spans[k]!;
      const floorBand = spanFloorBandOf(span);
      const ceiling = spanCeilingOf(span);
      if (!Number.isInteger(floorBand) || !Number.isInteger(ceiling)) {
        violations.push(`${where}: span ${k} is not integral`);
      }
      if (floorBand < BEDROCK_BAND) {
        violations.push(`${where}: span ${k} floors below the bedrock band ${BEDROCK_BAND}`);
      }
      if (ceiling < MIN_HEIGHT || ceiling > MAX_HEIGHT) {
        violations.push(`${where}: span ${k} caps outside [${MIN_HEIGHT}, ${MAX_HEIGHT}]`);
      }
      if (!spanIsDrawn(span)) violations.push(`${where}: span ${k} is not drawn`);
      if (k > 0 && !gapIsDrawn(spans[k - 1]!, span)) {
        violations.push(`${where}: spans ${k - 1} and ${k} have no drawn gap — they should be one span`);
      }
    }
    const top = spanCeilingOf(spans[spans.length - 1]!);
    if (map.cells[i] !== top) {
      violations.push(`${where}: cells[] holds ${map.cells[i]}, top ceiling is ${top}`);
    }
  }
  report(violations, context);
}

/** A stroke writes only inside sculptReachCells() of the cells it swept. */
export function expectStrokeWithinReach(
  map: Heightmap,
  diff: readonly CellDiff[],
  origins: readonly (readonly [number, number])[],
  reach: number,
  context = '',
): void {
  const violations: string[] = [];
  for (const cell of diff) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const [ox, oy] of origins) {
      const d = chebyshevDistance(ox, oy, cell.x, cell.y);
      if (d < nearest) nearest = d;
    }
    if (nearest > reach) {
      violations.push(`(${cell.x}, ${cell.y}) is ${nearest} cells from the sweep, reach is ${reach}`);
    }
  }
  report(violations, context);
}

/**
 * Wherever a smooth settled, no pair is steeper than the limit. Bounded to the
 * diff's own box: the cascade stops growing once a ring is quiet.
 */
export function expectGradientLimitOverDiff(
  map: Heightmap,
  diff: readonly CellDiff[],
  context = '',
): void {
  if (diff.length === 0) return;
  let x0 = map.size, y0 = map.size, x1 = -1, y1 = -1;
  for (const cell of diff) {
    if (cell.x < x0) x0 = cell.x;
    if (cell.x > x1) x1 = cell.x;
    if (cell.y < y0) y0 = cell.y;
    if (cell.y > y1) y1 = cell.y;
  }
  const limit = MAX_STEP + RELAX_SLACK;
  const violations: string[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * map.size + x;
      if (x < x1 && Math.abs(map.cells[i]! - map.cells[i + 1]!) > limit) {
        violations.push(`(${x}, ${y})-(${x + 1}, ${y}) drops ${map.cells[i]! - map.cells[i + 1]!}, limit ${limit}`);
      }
      if (y < y1 && Math.abs(map.cells[i]! - map.cells[i + map.size]!) > limit) {
        violations.push(`(${x}, ${y})-(${x}, ${y + 1}) drops ${map.cells[i]! - map.cells[i + map.size]!}, limit ${limit}`);
      }
    }
  }
  report(violations, context);
}

/** A smooth only moves height between neighbours: the whole-map sum is unchanged. */
export function expectHeightSumConserved(before: number, map: Heightmap, context = ''): void {
  const after = heightSum(map);
  const violations = after === before ? [] : [`height sum moved by ${after - before}`];
  report(violations, context);
}

/** A smooth never creates or destroys material: the whole-map solid volume is unchanged. */
export function expectSolidVolumeConserved(before: number, map: Heightmap, context = ''): void {
  const after = solidVolume(map);
  const violations = after === before ? [] : [`solid volume moved by ${after - before}`];
  report(violations, context);
}

function removedIntervals(before: readonly Span[], after: readonly Span[]): [number, number][] {
  const gaps: [number, number][] = [];
  for (const span of before) {
    let cursor = spanFloorOf(span);
    const end = spanCeilingOf(span);
    for (const kept of after) {
      const lo = Math.max(cursor, spanFloorOf(kept));
      const hi = Math.min(end, spanCeilingOf(kept));
      if (lo >= hi) continue;
      if (lo > cursor) gaps.push([cursor, lo]);
      cursor = hi;
    }
    if (cursor < end) gaps.push([cursor, end]);
  }
  return gaps;
}

/** A carve touches only its footprint, removes material only inside the slabs it names, and adds none. */
export function expectCarveCutsOnlyNamedSlabs(
  map: Heightmap,
  before: ColumnSnapshot,
  diff: readonly CellDiff[],
  footprint: ReadonlySet<number>,
  lo: number,
  hi: number,
  context = '',
): void {
  const violations: string[] = [];
  for (const cell of diff) {
    const i = cell.y * map.size + cell.x;
    if (!footprint.has(i)) {
      violations.push(`${at(map, i)} changed but lies outside the carve footprint`);
      continue;
    }
    const was = before.get(i);
    if (was === undefined) continue;
    const now = readSpans(map, cell.x, cell.y);
    for (const [from, to] of removedIntervals(was, now)) {
      if (from < lo || to > hi) {
        violations.push(`${at(map, i)}: carve removed [${from}, ${to}) outside the named [${lo}, ${hi})`);
      }
    }
    for (const [from, to] of removedIntervals(now, was)) {
      violations.push(`${at(map, i)}: carve ADDED material at [${from}, ${to})`);
    }
  }
  report(violations, context);
}

/** A drag never removes a gap that existed before it: no column loses a span. */
export function expectGapsSurvive(
  map: Heightmap,
  before: ColumnSnapshot,
  context = '',
): void {
  const violations: string[] = [];
  for (const [i, was] of before) {
    const now = readSpans(map, cellX(map.size, i), cellY(map.size, i));
    if (now.length < was.length) {
      violations.push(
        `${at(map, i)}: ${was.length} span(s) ${describeColumn(was)} became ` +
          `${now.length} — ${describeColumn(now)}`,
      );
    }
  }
  report(violations, context);
}

/**
 * A column draws as covered EXACTLY the bands its spans hold. One predicate
 * decides both now, so containment alone no longer pins anything.
 */
export function expectDrawnCoverageMatchesMaterial(
  map: Heightmap,
  cells: Iterable<number>,
  context = '',
): void {
  const violations: string[] = [];
  for (const i of cells) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const spans = readSpans(map, x, y);
    if (spans.length === 0) continue;
    const held = new Set<number>();
    for (const span of spans) {
      for (let band = spanFloorBandOf(span); band <= spanCapBand(span); band++) held.add(band);
    }
    const lowest = spanFloorBandOf(spans[0]!) - 1;
    const highest = spanCapBand(spans[spans.length - 1]!) + 1;
    for (let band = lowest; band <= highest; band++) {
      const drawn = columnCoversBand(map, x, y, band);
      if (drawn === held.has(band)) continue;
      violations.push(
        `${at(map, i)} ${describeColumn(spans)}: band ${band} drawn=${drawn}, material=${held.has(band)}`,
      );
    }
  }
  report(violations, context);
}

/** Price is a pure function of (radius, tool, profile, depth): terrain can never move it. */
export function expectPriceIndependentOfTerrain(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile,
  expected: number,
  context = '',
  depthBands: number = CARVE_DEFAULT_DEPTH_BANDS,
): void {
  const now = sculptDisplacementUnits(radius, tool, profile, depthBands);
  const violations = now === expected ? [] : [`price is ${now}, was ${expected} for the same arguments`];
  report(violations, context);
}

/** The same intent on the same world gives the same diff and the same columns, every time. */
export function expectSculptDeterministic(
  a: Heightmap,
  aDiff: readonly CellDiff[],
  b: Heightmap,
  bDiff: readonly CellDiff[],
  context = '',
): void {
  const violations: string[] = [];
  if (JSON.stringify(aDiff) !== JSON.stringify(bDiff)) {
    violations.push(`diffs differ: ${JSON.stringify(aDiff)} vs ${JSON.stringify(bDiff)}`);
  }
  for (let i = 0; i < a.cells.length && violations.length < MAX_REPORTED_VIOLATIONS; i++) {
    const x = cellX(a.size, i);
    const y = cellY(a.size, i);
    const left = describeColumn(readSpans(a, x, y));
    const right = describeColumn(readSpans(b, x, y));
    if (left !== right) violations.push(`${at(a, i)}: ${left} vs ${right}`);
  }
  report(violations, context);
}

/** The raw range a carve grasped at `spanBand` may cut: its slabs, and nothing under them. */
export function carvedSlabRange(spanBand: number, depthBands: number): [number, number] {
  return [bandLevelHeight(spanBand - 1), bandFloorHeight(spanBand + depthBands)];
}
