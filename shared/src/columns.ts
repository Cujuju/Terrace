import { BAND_HEIGHT, MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL } from './constants.ts';
import { cellIndex, cellX, cellY, type Heightmap } from './grid.ts';
import {
  bandFloorHeight,
  bandLevelHeight,
  drawnBandOfSample,
  isHeightInBand,
} from './bands.ts';

export { bandFloorHeight, isHeightInBand } from './bands.ts';

export const BEDROCK_FLOOR = MIN_HEIGHT;

export interface Span {
  readonly floor: number;
  readonly ceiling: number;
}

const BEDROCK_REMNANT: Span = { floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + 1 };

const HEIGHT_UNIT = 1;

const SPAN_STRIDE = 2;

export function spanCount(map: Heightmap, x: number, y: number): number {
  const packed = map.columnSpans.get(cellIndex(map, x, y));
  return packed === undefined ? 1 : packed.length / SPAN_STRIDE;
}

export function spanAt(map: Heightmap, x: number, y: number, k: number): Span {
  const i = cellIndex(map, x, y);
  const packed = map.columnSpans.get(i);
  if (packed === undefined) {
    if (k !== 0) {
      throw new RangeError(`cell (${x}, ${y}) has 1 span, asked for span ${k}`);
    }
    return { floor: BEDROCK_FLOOR, ceiling: map.cells[i]! };
  }
  if (!Number.isInteger(k) || k < 0 || k >= packed.length / SPAN_STRIDE) {
    throw new RangeError(
      `cell (${x}, ${y}) has ${packed.length / SPAN_STRIDE} spans, asked for span ${k}`,
    );
  }
  return { floor: packed[k * SPAN_STRIDE]!, ceiling: packed[k * SPAN_STRIDE + 1]! };
}

export function topSpan(map: Heightmap, x: number, y: number): Span {
  return spanAt(map, x, y, spanCount(map, x, y) - 1);
}

export function seabedHeight(map: Heightmap, x: number, y: number): number {
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (span.ceiling <= SEA_LEVEL) continue;
    if (span.floor <= SEA_LEVEL) return span.ceiling;
    return k === 0 ? BEDROCK_FLOOR : spanAt(map, x, y, k - 1).ceiling;
  }
  return map.cells[cellIndex(map, x, y)]!;
}

export function setColumn(map: Heightmap, x: number, y: number, spans: readonly Span[]): void {
  if (spans.length === 0) {
    throw new RangeError(`cell (${x}, ${y}) needs at least one solid span`);
  }
  for (let k = 0; k < spans.length; k++) {
    const { floor, ceiling } = spans[k]!;
    if (!Number.isInteger(floor) || !Number.isInteger(ceiling)) {
      throw new RangeError(`cell (${x}, ${y}) span ${k} [${floor}, ${ceiling}) is not integral`);
    }
    if (floor < MIN_HEIGHT || ceiling > MAX_HEIGHT) {
      throw new RangeError(
        `cell (${x}, ${y}) span ${k} [${floor}, ${ceiling}) leaves [${MIN_HEIGHT}, ${MAX_HEIGHT}]`,
      );
    }
    if (floor >= ceiling) {
      throw new RangeError(`cell (${x}, ${y}) span ${k} [${floor}, ${ceiling}) is empty`);
    }
    if (k > 0 && spans[k - 1]!.ceiling >= floor) {
      throw new RangeError(
        `cell (${x}, ${y}) span ${k} starts at ${floor}, which does not clear span ${k - 1} ` +
          `ending at ${spans[k - 1]!.ceiling} — spans must ascend with a gap between them`,
      );
    }
  }
  if (spans[0]!.floor !== BEDROCK_FLOOR) {
    throw new RangeError(
      `cell (${x}, ${y}) has its bottom span floored at ${spans[0]!.floor}; a column floors at ` +
        `${BEDROCK_FLOOR} (a column standing on nothing needs the gap below it to be a span)`,
    );
  }
  const i = cellIndex(map, x, y);
  map.cells[i] = spans[spans.length - 1]!.ceiling;
  if (spans.length === 1) {
    map.columnSpans.delete(i);
    return;
  }
  const packed = new Int16Array(spans.length * SPAN_STRIDE);
  for (let k = 0; k < spans.length; k++) {
    packed[k * SPAN_STRIDE] = spans[k]!.floor;
    packed[k * SPAN_STRIDE + 1] = spans[k]!.ceiling;
  }
  map.columnSpans.set(i, packed);
}

export function resetColumns(
  map: Heightmap,
  x0: number,
  y0: number,
  width: number,
  height: number,
): void {
  if (map.columnSpans.size === 0) return;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      map.columnSpans.delete(cellIndex(map, x, y));
    }
  }
}

export function clearColumns(map: Heightmap): void {
  map.columnSpans.clear();
}

export function assertSingleSpanWorld(map: Heightmap, context: string): void {
  if (map.columnSpans.size === 0) return;
  const first = map.columnSpans.keys().next().value as number;
  throw new Error(
    `${context}: ${map.columnSpans.size} column(s) hold more than one span — ` +
      `first at (${cellX(map.size, first)}, ${cellY(map.size, first)}). ` +
      `This path carries one height per cell and cannot express a layered column.`,
  );
}

/** Canonical drawn cap of a span: the write level of its ceiling's drawn band. */
export function spanCapHeight(span: Span): number {
  return bandLevelHeight(drawnBandOfSample(span.ceiling));
}

/**
 * Lowest write level at or above a span's floor: the ceiling of the level
 * grid the span reaches. A span is drawn exactly when this clears its cap,
 * which holds exactly when the span covers some band (see
 * spanIndexCoveringBand).
 */
export function spanLowestBandHeight(span: Span): number {
  const level = bandLevelHeight(drawnBandOfSample(span.floor));
  return level >= span.floor ? level : bandLevelHeight(drawnBandOfSample(span.floor) + 1);
}

export function spanUndersideHeight(span: Span): number {
  return spanLowestBandHeight(span) - BAND_HEIGHT;
}

export function isSpanDrawn(span: Span): boolean {
  return spanLowestBandHeight(span) <= spanCapHeight(span);
}

export function isGapDrawn(lower: Span, upper: Span): boolean {
  return spanUndersideHeight(upper) > spanCapHeight(lower);
}

export const OPEN_COLUMN_SAMPLE = BEDROCK_FLOOR - BAND_HEIGHT;

export function spanIndexCoveringBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number | null {
  const threshold = bandLevelHeight(band);
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    if (span.floor <= threshold && threshold <= spanCapHeight(span)) return k;
  }
  return null;
}

export function spanIndexBelowBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number | null {
  if (columnCoversBand(map, x, y, band)) return null;
  const threshold = bandFloorHeight(band);
  let below: number | null = null;
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    if (spanAt(map, x, y, k).ceiling < threshold) below = k;
  }
  return below;
}

export type BandFill =
  | { readonly kind: 'extend'; readonly spanIndex: number }
  | { readonly kind: 'overhang' };

export function bandFillAt(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): BandFill | null {
  // Drag-fill admission is material reach, not drawn coverage: skip only when
  // solid material already meets/exceeds the write level. A ceiling that
  // merely touches a drawn band floor still needs fill toward the target
  // (lane/drag-fill restores the pre-lane predicate; drawn coverage in
  // spanIndexCoveringBand stays render-sense for picking/carving).
  const threshold = bandLevelHeight(band);
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (span.floor <= threshold && threshold <= span.ceiling) return null;
  }
  let below: number | null = null;
  for (let k = 0; k < count; k++) {
    if (spanAt(map, x, y, k).ceiling < threshold) below = k;
  }
  const firstAbove = below === null ? 0 : below + 1;
  if (firstAbove < count) return { kind: 'overhang' };
  if (below === null) return null;
  return { kind: 'extend', spanIndex: below };
}

export function applyBandFill(
  map: Heightmap,
  x: number,
  y: number,
  fill: BandFill,
  ceiling: number,
): void {
  if (fill.kind === 'extend') {
    moveSpanCeiling(map, x, y, fill.spanIndex, ceiling);
    return;
  }
  const floor = Math.max(BEDROCK_FLOOR, ceiling - BAND_HEIGHT + HEIGHT_UNIT);
  if (floor >= ceiling) return;
  const spans = readSpans(map, x, y);
  let at = spans.length;
  for (let k = 0; k < spans.length; k++) {
    if (spans[k]!.floor > floor) {
      at = k;
      break;
    }
  }
  spans.splice(at, 0, { floor, ceiling });
  setColumn(map, x, y, canonicaliseColumn(spans));
}

export function highestCeilingBelow(
  map: Heightmap,
  x: number,
  y: number,
  threshold: number,
): number | null {
  let best: number | null = null;
  const count = spanCount(map, x, y);
  for (let k = 0; k < count; k++) {
    const { ceiling } = spanAt(map, x, y, k);
    if (ceiling < threshold) best = ceiling;
  }
  return best;
}

export function spansHaveCapAtBand(spans: readonly Span[], band: number): boolean {
  for (const span of spans) if (isHeightInBand(span.ceiling, band)) return true;
  return false;
}

export function columnCoversBand(map: Heightmap, x: number, y: number, band: number): boolean {
  return spanIndexCoveringBand(map, x, y, band) !== null;
}

export function columnSampleAtBand(map: Heightmap, x: number, y: number, band: number): number {
  const threshold = bandLevelHeight(band);
  const count = spanCount(map, x, y);
  let below = OPEN_COLUMN_SAMPLE;
  for (let k = 0; k < count; k++) {
    const span = spanAt(map, x, y, k);
    if (!isSpanDrawn(span)) continue;
    if (span.floor <= threshold && threshold <= spanCapHeight(span)) return span.ceiling;
    if (span.ceiling < threshold) below = span.ceiling;
  }
  return below;
}

export function anyColumnLayered(
  map: Heightmap,
  x0: number,
  y0: number,
  width: number,
  height: number,
): boolean {
  if (map.columnSpans.size === 0) return false;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      if (map.columnSpans.has(cellIndex(map, x, y))) return true;
    }
  }
  return false;
}

export function readSpans(map: Heightmap, x: number, y: number): Span[] {
  const count = spanCount(map, x, y);
  const spans: Span[] = [];
  for (let k = 0; k < count; k++) spans.push(spanAt(map, x, y, k));
  return spans;
}

function canonicaliseColumn(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (let k = 0; k < spans.length; k++) {
    const span = spans[k]!;
    if (!isSpanDrawn(span)) continue;
    const last = out.length === 0 ? undefined : out[out.length - 1]!;
    if (last !== undefined && !isGapDrawn(last, span)) {
      out[out.length - 1] = { floor: last.floor, ceiling: span.ceiling };
      continue;
    }
    out.push(span);
  }
  return out.length === 0 ? [BEDROCK_REMNANT] : out;
}

export function moveSpanCeiling(
  map: Heightmap,
  x: number,
  y: number,
  k: number,
  newCeiling: number,
): void {
  const spans = readSpans(map, x, y);
  if (!Number.isInteger(k) || k < 0 || k >= spans.length) {
    throw new RangeError(`cell (${x}, ${y}) has ${spans.length} span(s), asked to move span ${k}`);
  }
  const target = spans[k]!;
  if (newCeiling <= target.floor) {
    spans.splice(k, 1);
  } else {
    spans[k] = { floor: target.floor, ceiling: newCeiling };
  }
  setColumn(map, x, y, canonicaliseColumn(spans));
}

export function carveRange(map: Heightmap, x: number, y: number, lo: number, hi: number): void {
  if (lo >= hi) return;
  const spans = readSpans(map, x, y);
  const cut: Span[] = [];
  for (let k = 0; k < spans.length; k++) {
    const span = spans[k]!;
    if (hi <= span.floor || lo >= span.ceiling) {
      cut.push(span);
      continue;
    }
    if (span.floor < lo) cut.push({ floor: span.floor, ceiling: lo });
    if (hi < span.ceiling) cut.push({ floor: hi, ceiling: span.ceiling });
  }
  setColumn(map, x, y, canonicaliseColumn(cut));
}

export function canSpreadBandToSpan(
  map: Heightmap,
  cx: number,
  cy: number,
  band: number,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      if (columnCoversBand(map, nx, ny, band)) return true;
    }
  }
  return false;
}

export function canCarveBandAt(map: Heightmap, cx: number, cy: number, band: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
      if (!columnCoversBand(map, nx, ny, band)) return true;
    }
  }
  return false;
}

export function packColumnSpans(map: Heightmap, x: number, y: number): number[] | undefined {
  const packed = map.columnSpans.get(cellIndex(map, x, y));
  return packed === undefined ? undefined : Array.from(packed);
}

export function parsePackedSpans(flat: readonly number[]): Span[] | null {
  if (flat.length % SPAN_STRIDE !== 0) return null;
  const count = flat.length / SPAN_STRIDE;
  if (count < 2) return null;
  const spans: Span[] = [];
  for (let k = 0; k < count; k++) {
    const floor = flat[k * SPAN_STRIDE]!;
    const ceiling = flat[k * SPAN_STRIDE + 1]!;
    if (!Number.isInteger(floor) || !Number.isInteger(ceiling)) return null;
    if (floor < MIN_HEIGHT || ceiling > MAX_HEIGHT) return null;
    if (floor >= ceiling) return null;
    if (k > 0 && spans[k - 1]!.ceiling >= floor) return null;
    spans.push({ floor, ceiling });
  }
  if (spans[0]!.floor !== BEDROCK_FLOOR) return null;
  return spans;
}

export function applyPackedSpans(
  map: Heightmap,
  x: number,
  y: number,
  flat: readonly number[] | undefined,
): boolean {
  if (flat === undefined) {
    map.columnSpans.delete(cellIndex(map, x, y));
    return true;
  }
  const spans = parsePackedSpans(flat);
  if (spans === null) {
    map.columnSpans.delete(cellIndex(map, x, y));
    return false;
  }
  setColumn(map, x, y, spans);
  return true;
}

export function assertSingleSpanChunk(
  map: Heightmap,
  x0: number,
  y0: number,
  width: number,
  height: number,
  context: string,
): void {
  if (map.columnSpans.size === 0) return;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      if (!map.columnSpans.has(cellIndex(map, x, y))) continue;
      throw new Error(
        `${context}: column (${x}, ${y}) holds more than one span. ` +
          `This path carries one height per cell and cannot express a layered column.`,
      );
    }
  }
}
