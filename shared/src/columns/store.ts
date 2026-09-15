import { MAX_HEIGHT, MIN_HEIGHT, SEA_LEVEL } from '../constants.ts';
import { cellIndex, cellX, cellY, type Heightmap } from '../grid.ts';
import {
  BEDROCK_FLOOR,
  canonicaliseColumn,
  parsePackedSpans,
  SPAN_STRIDE,
  type Span,
} from './span.ts';

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

export function packColumnSpans(map: Heightmap, x: number, y: number): number[] | undefined {
  const packed = map.columnSpans.get(cellIndex(map, x, y));
  return packed === undefined ? undefined : Array.from(packed);
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
