import { expect } from 'vitest';
import {
  BAND_HEIGHT,
  bandFloorHeight,
  bandLevelHeight,
  BEDROCK_FLOOR,
  CARVE_BANDS_PER_STROKE,
  cellX,
  cellY,
  chebyshevDistance,
  columnCoversBand,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  forEachFootprintOffset,
  isGapDrawn,
  isSpanDrawn,
  MAX_BAND,
  MAX_HEIGHT,
  MAX_STEP,
  MIN_BAND,
  MIN_HEIGHT,
  RELAX_SLACK,
  readSpans,
  sculptDisplacementUnits,
  spanCount,
  spanLowestBandHeight,
  topSpan,
  type CellDiff,
  type Heightmap,
  type SculptProfile,
  type SculptTool,
  type Span,
} from '../../src/index.ts';

// ---------------------------------------------------------------------------
// Span shape. The ONLY place this suite knows how a Span is built or read;
// re-point the functions here and every invariant below follows.
// ---------------------------------------------------------------------------

export function makeSpan(floor: number, ceiling: number): Span {
  return { floor, ceiling };
}

export function spanFloorOf(span: Span): number {
  return span.floor;
}

export function spanCeilingOf(span: Span): number {
  return span.ceiling;
}

/** Lowest band level the span draws as covered. */
export function spanBaseOf(span: Span): number {
  return spanLowestBandHeight(span);
}

/**
 * Lowest band the span holds material at a write level in, derived from its raw
 * floor alone — the independent side of the coverage invariant.
 */
export function spanBaseBandOf(span: Span): number {
  const floor = spanFloorOf(span);
  const band = drawnBandOfSample(floor);
  return bandLevelHeight(band) >= floor ? band : band + 1;
}

/** Highest band the span draws as covered, derived from its raw ceiling alone. */
export function spanCapBandOf(span: Span): number {
  return drawnBandOfSample(spanCeilingOf(span));
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

export function solidVolume(map: Heightmap): number {
  let total = 0;
  for (let i = 0; i < map.cells.length; i++) {
    if (!map.columnSpans.has(i)) total += map.cells[i]! - BEDROCK_FLOOR;
  }
  for (const i of map.columnSpans.keys()) {
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
  return spans.map((s) => `[${spanFloorOf(s)}, ${spanCeilingOf(s)})`).join(' ');
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
    if (spanFloorOf(spans[0]!) !== BEDROCK_FLOOR) {
      violations.push(`${where}: bottom span floors at ${spanFloorOf(spans[0]!)}, not ${BEDROCK_FLOOR}`);
    }
    for (let k = 0; k < spans.length; k++) {
      const span = spans[k]!;
      const floor = spanFloorOf(span);
      const ceiling = spanCeilingOf(span);
      if (!Number.isInteger(floor) || !Number.isInteger(ceiling)) {
        violations.push(`${where}: span ${k} is not integral`);
      }
      if (floor < MIN_HEIGHT || ceiling > MAX_HEIGHT) {
        violations.push(`${where}: span ${k} leaves [${MIN_HEIGHT}, ${MAX_HEIGHT}]`);
      }
      if (floor >= ceiling) violations.push(`${where}: span ${k} is empty`);
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

/** A rectangle of cells, inclusive on both corners. */
export type CellBox = readonly [number, number, number, number];

/** The box a diff wrote in, or null when nothing moved. */
export function diffBounds(diff: readonly CellDiff[]): CellBox | null {
  if (diff.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY, y0 = Number.POSITIVE_INFINITY, x1 = -1, y1 = -1;
  for (const cell of diff) {
    if (cell.x < x0) x0 = cell.x;
    if (cell.x > x1) x1 = cell.x;
    if (cell.y < y0) y0 = cell.y;
    if (cell.y > y1) y1 = cell.y;
  }
  return [x0, y0, x1, y1];
}

/** Span count per cell: a changed count means the grasped span did not survive. */
export function spanCountsOf(map: Heightmap, cells: Iterable<number>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const i of cells) counts.set(i, spanCount(map, cellX(map.size, i), cellY(map.size, i)));
  return counts;
}

/** Cells whose grasped span survived, so `cells[]` still holds the value relaxation left. */
export function graspStableCells(
  map: Heightmap,
  before: ReadonlyMap<number, number>,
): Set<number> {
  const stable = new Set<number>();
  for (const [i, was] of before) {
    if (was === spanCount(map, cellX(map.size, i), cellY(map.size, i))) stable.add(i);
  }
  return stable;
}

/** Relaxation stops dropping a span once its ceiling reaches its own lowest drawn band. */
function dropBound(map: Heightmap, i: number): boolean {
  if (!map.columnSpans.has(i)) return false;
  return map.cells[i]! <= spanBaseOf(topSpan(map, cellX(map.size, i), cellY(map.size, i)));
}

/**
 * A free smooth leaves the ground it scanned within the limit. Relaxation moves
 * each cell's grasped ceiling, which `cells[]` holds. Returns pairs held to it.
 */
export function expectGradientLimitOverSettled(
  map: Heightmap,
  stable: ReadonlySet<number>,
  box: CellBox,
  context = '',
): number {
  const [x0, y0, x1, y1] = box;
  const limit = MAX_STEP + RELAX_SLACK;
  const violations: string[] = [];
  let compared = 0;
  const pair = (i: number, j: number, label: string): void => {
    if (!stable.has(j)) return;
    const drop = map.cells[i]! - map.cells[j]!;
    if (drop > limit || drop < -limit) {
      // A bound that bites leaves the pair over-steep for the next stroke.
      if (dropBound(map, drop > 0 ? i : j)) return;
      violations.push(`${label} drops ${drop}, limit ${limit}`);
    }
    compared++;
  };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * map.size + x;
      if (!stable.has(i)) continue;
      if (x < x1) pair(i, i + 1, `(${x}, ${y})-(${x + 1}, ${y})`);
      if (y < y1) pair(i, i + map.size, `(${x}, ${y})-(${x}, ${y + 1})`);
    }
  }
  report(violations, context);
  return compared;
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

/** Air still open somewhere inside [lo, hi) after the stroke. */
function airRemainsBetween(spans: readonly Span[], lo: number, hi: number): boolean {
  let cursor = lo;
  for (const span of spans) {
    if (spanCeilingOf(span) <= cursor) continue;
    if (spanFloorOf(span) > cursor) return true;
    cursor = spanCeilingOf(span);
    if (cursor >= hi) return false;
  }
  return cursor < hi;
}

/** A drag never removes a gap that existed before it: air survives inside every one. */
export function expectGapsSurvive(
  map: Heightmap,
  before: ColumnSnapshot,
  context = '',
): void {
  const violations: string[] = [];
  for (const [i, was] of before) {
    if (was.length < 2) continue;
    const now = readSpans(map, cellX(map.size, i), cellY(map.size, i));
    for (let k = 1; k < was.length; k++) {
      const lo = spanCeilingOf(was[k - 1]!);
      const hi = spanFloorOf(was[k]!);
      if (airRemainsBetween(now, lo, hi)) continue;
      violations.push(
        `${at(map, i)}: gap [${lo}, ${hi}) went solid — ${describeColumn(was)} became ${describeColumn(now)}`,
      );
    }
  }
  report(violations, context);
}

/** Bands either side of a span's own edges that the coverage invariant probes. */
const COVERAGE_PROBE_BANDS = 1;

function spansCoverBand(spans: readonly Span[], band: number): boolean {
  for (const span of spans) {
    if (spanBaseBandOf(span) <= band && band <= spanCapBandOf(span)) return true;
  }
  return false;
}

/**
 * Drawn coverage is exactly the union of the spans' own band ranges, probed at
 * every span edge and one band either side of it.
 */
export function expectDrawnCoverageMatchesSpans(
  map: Heightmap,
  cells: Iterable<number>,
  context = '',
): void {
  const violations: string[] = [];
  for (const i of cells) {
    const x = cellX(map.size, i);
    const y = cellY(map.size, i);
    const spans = readSpans(map, x, y);
    for (const span of spans) {
      for (const edge of [spanBaseBandOf(span), spanCapBandOf(span)]) {
        for (let band = edge - COVERAGE_PROBE_BANDS; band <= edge + COVERAGE_PROBE_BANDS; band++) {
          if (band < MIN_BAND || band > MAX_BAND) continue;
          const drawn = columnCoversBand(map, x, y, band);
          if (drawn === spansCoverBand(spans, band)) continue;
          violations.push(
            `${at(map, i)} ${describeColumn(spans)}: band ${band} draws covered=${drawn}, spans say ${!drawn}`,
          );
        }
      }
    }
  }
  report(violations, context);
}

function footprintCellCount(radius: number): number {
  let cells = 0;
  forEachFootprintOffset(radius, () => {
    cells++;
  });
  return cells;
}

/**
 * Price is the brush's nominal volume: a fill pays its whole footprint, a carve
 * pays the bands it cuts, a graduated brush pays less than the fill.
 */
export function expectPriceMatchesBrushVolume(
  radius: number,
  tool: SculptTool,
  profile: SculptProfile,
  context = '',
): void {
  const cells = footprintCellCount(radius);
  const fill = cells * DEFAULT_SCULPT_AMOUNT;
  const price = sculptDisplacementUnits(radius, tool, profile);
  const violations: string[] = [];
  if (tool === 'carve') {
    const cut = cells * CARVE_BANDS_PER_STROKE * BAND_HEIGHT;
    if (price !== cut) violations.push(`carve over ${cells} cells prices ${price}, cuts ${cut}`);
  } else if (tool === 'smooth' || profile === 'soft') {
    // Graduated: the centre cell pays the full step, every other cell less.
    const graduated = cells === 1 ? price === fill : price > 0 && price < fill;
    if (!graduated) {
      violations.push(`graduated ${tool} over ${cells} cells prices ${price}, fill is ${fill}`);
    }
  } else if (price !== fill) {
    violations.push(`${tool} fill over ${cells} cells prices ${price}, not ${fill}`);
  }
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

/** The band range a carve grasped at `spanBand` is allowed to cut. */
export function carvedSlabRange(spanBand: number, bandsPerStroke: number): [number, number] {
  return [bandFloorHeight(spanBand - 1), bandFloorHeight(spanBand + bandsPerStroke - 1)];
}
