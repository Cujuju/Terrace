import {
  applySculpt,
  drawnBandOfSample,
  heightAt,
  type CellDiff,
  type Heightmap,
  type SculptOptions,
} from '../../src/index.ts';

// FNV-1a/32, fed one Int32 at a time, low byte first. Integer-only (Math.imul,
// xor, shifts), fixed iteration order, no dependencies.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const BYTES_PER_INT32 = 4;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
const HASH_HEX_DIGITS = 8;

export function fnv1aOfInt32s(values: Iterable<number>): string {
  let hash = FNV_OFFSET_BASIS;
  for (const value of values) {
    for (let byte = 0; byte < BYTES_PER_INT32; byte++) {
      hash = (hash ^ ((value >>> (byte * BITS_PER_BYTE)) & BYTE_MASK)) >>> 0;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  }
  return hash.toString(16).padStart(HASH_HEX_DIGITS, '0');
}

/**
 * The one place this corpus writes a span. A packed pair is `[floor, ceiling]`
 * in raw heights today; a `{ floorBand, ceiling }` span shape re-points here.
 */
export function packedSpanPair(floor: number, ceiling: number): [number, number] {
  return [floor, ceiling];
}

/**
 * Grid size, every cell height, then each layered column in ascending index:
 * index, packed length, packed values. Packed spans go in as-is, so no span
 * field name reaches the hash.
 */
function* heightmapStream(map: Heightmap): Generator<number> {
  yield map.size;
  for (const height of map.cells) yield height;
  const layered = Array.from(map.columnSpans.keys()).sort((a, b) => a - b);
  yield layered.length;
  for (const index of layered) {
    const packed = map.columnSpans.get(index)!;
    yield index;
    yield packed.length;
    for (const value of packed) yield value;
  }
}

export function hashHeightmap(map: Heightmap): string {
  return fnv1aOfInt32s(heightmapStream(map));
}

const NO_SPANS: readonly number[] = [];

/**
 * The payload clients consume: cell count, then x, y, h, span count and the
 * spans of each cell, in the order applySculpt returned them.
 */
function* cellDiffStream(diff: readonly CellDiff[]): Generator<number> {
  yield diff.length;
  for (const cell of diff) {
    yield cell.x;
    yield cell.y;
    yield cell.h;
    const spans = cell.spans ?? NO_SPANS;
    yield spans.length;
    for (const value of spans) yield value;
  }
}

export function hashCellDiff(diff: readonly CellDiff[]): string {
  return fnv1aOfInt32s(cellDiffStream(diff));
}

/** A band named relative to the drawn band of the clicked cell's top ceiling. */
export interface BandFromClick {
  readonly fromClick: number;
}

export type ScriptBand = number | BandFromClick | null;

export interface StrokeScriptStep {
  readonly name: string;
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly amount: number;
  readonly tool: NonNullable<SculptOptions['tool']>;
  readonly profile?: NonNullable<SculptOptions['profile']>;
  readonly spill?: NonNullable<SculptOptions['spill']>;
  readonly anchor?: NonNullable<SculptOptions['anchor']>;
  readonly targetBand?: ScriptBand;
  readonly spanBand?: ScriptBand;
  readonly sweepFrom?: { readonly x: number; readonly y: number } | null;
}

export interface StrokeOutcome {
  readonly name: string;
  readonly changed: number;
  readonly diffHash: string;
  readonly hash: string;
}

function resolveBand(map: Heightmap, step: StrokeScriptStep, band: ScriptBand): number | null {
  if (band === null || band === undefined) return null;
  if (typeof band === 'number') return band;
  return drawnBandOfSample(heightAt(map, step.cx, step.cy)) + band.fromClick;
}

export function runStrokeScript(
  map: Heightmap,
  steps: readonly StrokeScriptStep[],
): StrokeOutcome[] {
  const outcomes: StrokeOutcome[] = [];
  for (const step of steps) {
    const diff = applySculpt(map, step.cx, step.cy, step.radius, step.amount, {
      tool: step.tool,
      profile: step.profile,
      spill: step.spill,
      anchor: step.anchor,
      targetBand: resolveBand(map, step, step.targetBand ?? null),
      spanBand: resolveBand(map, step, step.spanBand ?? null),
      sweepFrom: step.sweepFrom ?? null,
    });
    outcomes.push({
      name: step.name,
      changed: diff.length,
      diffHash: hashCellDiff(diff),
      hash: hashHeightmap(map),
    });
  }
  return outcomes;
}

const JSON_INDENT = 2;

/** Goldens are written and compared with LF, so a CRLF checkout cannot move one. */
export function goldenText(value: unknown): string {
  return `${JSON.stringify(value, null, JSON_INDENT).replaceAll('\r\n', '\n')}\n`;
}
