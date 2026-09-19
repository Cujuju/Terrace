import {
  canonicaliseColumn,
  floorBandOfHeight,
  parsePackedSpans,
  SPAN_STRIDE,
  type Span,
} from '@terrace/shared';
import {
  LEGACY_BAND_SCHEME_VERSION,
  migrateFloorBand,
  migrateHeight,
} from './band-scheme-migration.ts';

const BYTES_PER_HEIGHT = 2;

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function swapBytesInPlace(bytes: Uint8Array): void {
  for (let i = 0; i + 1 < bytes.length; i += BYTES_PER_HEIGHT) {
    const low = bytes[i];
    bytes[i] = bytes[i + 1];
    bytes[i + 1] = low;
  }
}

export function encodeHeights(cells: Int16Array): Buffer {
  const buffer = Buffer.copyBytesFrom(cells);
  if (!HOST_IS_LITTLE_ENDIAN) swapBytesInPlace(buffer);
  return buffer;
}

export function decodeHeights(
  blob: Uint8Array,
  expectedCells: number,
  schemaVersion: number,
): Int16Array {
  const expectedBytes = expectedCells * BYTES_PER_HEIGHT;
  if (blob.byteLength !== expectedBytes) {
    throw new RangeError(
      `snapshot heightmap is ${blob.byteLength} bytes, expected ${expectedBytes} (${expectedCells} cells)`,
    );
  }

  const bytes = new Uint8Array(expectedBytes);
  bytes.set(blob);
  if (!HOST_IS_LITTLE_ENDIAN) swapBytesInPlace(bytes);
  const cells = new Int16Array(bytes.buffer, 0, expectedCells);
  if (schemaVersion <= LEGACY_BAND_SCHEME_VERSION) {
    for (let i = 0; i < cells.length; i++) cells[i] = migrateHeight(cells[i]!);
  }
  return cells;
}

const VALUES_PER_SPAN = SPAN_STRIDE;

const BYTES_PER_SPAN_RECORD_HEADER = 4 + 2;

const BYTES_PER_PACKED_SPAN = VALUES_PER_SPAN * BYTES_PER_HEIGHT;

/** Schema 1 packed a span's floor as a raw height; schema 2 packs it as a band. */
export const RAW_FLOOR_SCHEMA_VERSION = 1;

/** A record on disk holds a layered column; one span lives in the heightmap instead. */
const MIN_SPANS_PER_RECORD = 2;

/**
 * Schema 1's gap rule admitted a slab floored one band over the ground's cap.
 * The band rule draws that as one span, so repair reproduces what v1 drew.
 */
function repairRawFloorColumn(
  packedBands: readonly number[],
  context: string,
  cellIndex: number,
): Span[] {
  const spans: Span[] = [];
  for (let k = 0; k < packedBands.length; k += SPAN_STRIDE) {
    spans.push({ floorBand: packedBands[k]!, ceiling: packedBands[k + 1]! });
  }
  try {
    return canonicaliseColumn(spans);
  } catch (cause) {
    throw new RangeError(
      `${context}: schema ${RAW_FLOOR_SCHEMA_VERSION} cell ${cellIndex} does not repair into a ` +
        `column (${(cause as Error).message}); refusing to restore a corrupt world`,
      { cause },
    );
  }
}

export function encodeColumnSpans(
  columnSpans: ReadonlyMap<number, Int16Array>,
): Buffer {
  if (columnSpans.size === 0) return Buffer.alloc(0);

  const indices = Array.from(columnSpans.keys()).sort((a, b) => a - b);
  let totalBytes = 0;
  for (const i of indices) {
    totalBytes += BYTES_PER_SPAN_RECORD_HEADER + columnSpans.get(i)!.byteLength;
  }

  const buffer = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const i of indices) {
    const packed = columnSpans.get(i)!;
    buffer.writeInt32LE(i, offset);
    offset += 4;
    buffer.writeUInt16LE(packed.length / VALUES_PER_SPAN, offset);
    offset += 2;
    for (let k = 0; k < packed.length; k++) {
      buffer.writeInt16LE(packed[k]!, offset);
      offset += BYTES_PER_HEIGHT;
    }
  }
  return buffer;
}

export function decodeColumnSpans(
  blob: Uint8Array,
  expectedCells: number,
  context: string,
  schemaVersion: number,
): Map<number, Span[]> {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const spansByCell = new Map<number, Span[]>();
  const rawFloors = schemaVersion === RAW_FLOOR_SCHEMA_VERSION;

  let offset = 0;
  let previousCellIndex = -1;
  while (offset < blob.byteLength) {
    if (blob.byteLength - offset < BYTES_PER_SPAN_RECORD_HEADER) {
      throw new RangeError(
        `${context}: span table ends ${blob.byteLength - offset} bytes into a ` +
          `${BYTES_PER_SPAN_RECORD_HEADER}-byte record header; refusing to restore a corrupt world`,
      );
    }
    const cellIndex = view.getInt32(offset, true);
    offset += 4;
    const spanCount = view.getUint16(offset, true);
    offset += 2;
    if (cellIndex < 0 || cellIndex >= expectedCells) {
      throw new RangeError(
        `${context}: span table names cell ${cellIndex}, outside this ` +
          `${expectedCells}-cell world; refusing to restore a corrupt world`,
      );
    }
    if (cellIndex <= previousCellIndex) {
      throw new RangeError(
        `${context}: span table is not in ascending cell order (${cellIndex} after ` +
          `${previousCellIndex}); refusing to restore a corrupt world`,
      );
    }
    previousCellIndex = cellIndex;
    if (spanCount < MIN_SPANS_PER_RECORD) {
      throw new RangeError(
        `${context}: span table holds ${spanCount} span(s) for cell ${cellIndex}; a column on ` +
          `disk has at least two, or no record at all. Refusing to restore a corrupt world`,
      );
    }
    const spanBytes = spanCount * BYTES_PER_PACKED_SPAN;
    if (blob.byteLength - offset < spanBytes) {
      throw new RangeError(
        `${context}: span table ends early in cell ${cellIndex}'s ` +
          `${spanCount}-span record; refusing to restore a corrupt world`,
      );
    }
    const flat: number[] = [];
    for (let k = 0; k < spanCount; k++) {
      const floor = view.getInt16(offset, true);
      offset += BYTES_PER_HEIGHT;
      const ceiling = view.getInt16(offset, true);
      offset += BYTES_PER_HEIGHT;
      flat.push(rawFloors ? floorBandOfHeight(floor) : floor, ceiling);
    }
    let packed: readonly number[] = flat;
    if (rawFloors) {
      const repaired = repairRawFloorColumn(flat, context, cellIndex);
      // One span at bedrock is not layered; the heightmap already holds its ceiling.
      if (repaired.length < MIN_SPANS_PER_RECORD) continue;
      packed = repaired.flatMap((span) => [span.floorBand, span.ceiling]);
    }
    const parsed = parsePackedSpans(packed);
    if (parsed === null) {
      throw new RangeError(
        `${context}: span table holds a malformed ${spanCount}-span list for cell ` +
          `${cellIndex}; refusing to restore a corrupt world`,
      );
    }
    spansByCell.set(
      cellIndex,
      schemaVersion <= LEGACY_BAND_SCHEME_VERSION
        ? parsed.map((span) => ({
            floorBand: migrateFloorBand(span.floorBand),
            ceiling: migrateHeight(span.ceiling),
          }))
        : parsed,
    );
  }
  return spansByCell;
}
