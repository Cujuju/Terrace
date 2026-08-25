// On-disk encoding for the heightmap blob.
//
// CRITICAL CODE (persistence path). The stored format is defined as
// LITTLE-ENDIAN Int16, row-major — not "whatever this machine's byte order is".
// A world.db must stay readable if it is copied between hosts, and a snapshot
// silently reinterpreted with the wrong byte order would not fail: it would
// come back as plausible-looking garbage terrain, which is far worse.
//
// Every realistic host is little-endian, so the common path is a straight copy;
// the byte-swapping branch exists so the format claim is actually true.

import { parsePackedSpans, type Span } from '@terrace/shared';

const BYTES_PER_HEIGHT = 2;

/** True on x86/ARM (i.e. everywhere this will realistically run). */
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Swaps the two bytes of every Int16 in place. Big-endian hosts only. */
function swapBytesInPlace(bytes: Uint8Array): void {
  for (let i = 0; i + 1 < bytes.length; i += BYTES_PER_HEIGHT) {
    const low = bytes[i];
    bytes[i] = bytes[i + 1];
    bytes[i + 1] = low;
  }
}

/** Serializes heights to a little-endian Int16 buffer (always a copy). */
export function encodeHeights(cells: Int16Array): Buffer {
  const buffer = Buffer.copyBytesFrom(cells);
  if (!HOST_IS_LITTLE_ENDIAN) swapBytesInPlace(buffer);
  return buffer;
}

/**
 * Reads a little-endian Int16 buffer back into a fresh Int16Array.
 * `expectedCells` guards against a truncated or foreign blob: a length mismatch
 * means the snapshot does not belong to this world size, and continuing would
 * misalign every row.
 */
export function decodeHeights(blob: Uint8Array, expectedCells: number): Int16Array {
  const expectedBytes = expectedCells * BYTES_PER_HEIGHT;
  if (blob.byteLength !== expectedBytes) {
    throw new RangeError(
      `snapshot heightmap is ${blob.byteLength} bytes, expected ${expectedBytes} (${expectedCells} cells)`,
    );
  }

  // Copy first: the source may be a view into a pooled Buffer, and the Int16
  // view below must own aligned, stable memory.
  const bytes = new Uint8Array(expectedBytes);
  bytes.set(blob);
  if (!HOST_IS_LITTLE_ENDIAN) swapBytesInPlace(bytes);
  return new Int16Array(bytes.buffer, 0, expectedCells);
}

// ---------------------------------------------------------------------------
// The span side table (`Heightmap.columnSpans`) — the world's layered columns.
// See shared/src/columns.ts for why the table exists and why ABSENT MEANS ONE
// SPAN is the contract every reader and writer of it must keep.
// ---------------------------------------------------------------------------
//
// The same LITTLE-ENDIAN discipline as the heights blob above, because both
// blobs travel inside the same world.db and stand or fall together: a database
// copied between hosts must stay readable, and a span table silently
// reinterpreted with the wrong byte order would come back as terrain that
// violates the canonical form — worse than garbage, because it would look like
// a plausible cave until a player fell through it.
//
// FORMAT: a sequence of records, each
//
//     [cellIndex: Int32][spanCount: Uint16][(floor, ceiling): Int16 × spanCount]
//
// with records in ASCENDING cellIndex order. Ascending is REQUIRED, not
// cosmetic: `Map` iterates in insertion order, which two hosts carving the
// same world can legitimately differ on (columns.ts, "Determinism"), so the
// encoder sorts by key — that sort is what makes the on-disk bytes a function
// of the WORLD rather than of the order it happened to be carved in, and it is
// what lets the decoder treat an out-of-order record as corruption instead of
// as merely unusual.
//
// An EMPTY table encodes to a ZERO-LENGTH blob: nobody has carved anything,
// which is the state every world spends most of its life in, and it must cost
// nothing. (A present record never describes fewer than TWO spans — a lone
// span IS the absent case, and writing it out would give one column two
// encodings, which is the determinism break columns.ts forbids. The decoder
// refuses such a record outright.)

/** A flattened span is `[floor, ceiling]`: two values, whatever the container. */
const VALUES_PER_SPAN = 2;

/** Bytes per record header: one Int32 cellIndex plus one Uint16 spanCount. */
const BYTES_PER_SPAN_RECORD_HEADER = 4 + 2;

/** Bytes per packed span: one Int16 floor plus one Int16 ceiling. */
const BYTES_PER_PACKED_SPAN = 2 * BYTES_PER_HEIGHT;

/**
 * Serializes the span side table to a little-endian record blob (always a
 * copy — nothing here aliases the caller's arrays).
 *
 * Takes the MAP ITSELF rather than a Heightmap: the writer already holds the
 * live table (`World.spansForPersistence` hands it out at the same trust level
 * as `cells`), and re-walking the grid to re-derive it would be work whose
 * only product is the same entries in the same order.
 */
export function encodeColumnSpans(
  columnSpans: ReadonlyMap<number, Int16Array>,
): Buffer {
  if (columnSpans.size === 0) return Buffer.alloc(0);

  // Ascending cellIndex, sorted HERE rather than assumed: insertion order is
  // not a fact about the world (see the format comment above).
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

/**
 * Reads a span-table blob back into canonical span lists keyed by cell index.
 *
 * THE TRUST BOUNDARY for this blob, and deliberately FATAL where
 * `parsePackedSpans` itself returns null: a chunk payload or wire diff costs
 * one cell when it lies, but a snapshot is the whole world, and continuing
 * past a malformed record here would silently drop or invent terrain the
 * moment the world is restored. Every refusal names `context` — which the
 * persistence caller fills in with the snapshot id — so the self-hoster's log
 * says WHICH row is broken, exactly like the height-corruption path in
 * snapshot-store.ts.
 *
 * Refuses, in one walk: a truncated header, a truncated span list, a spanCount
 * of 0 or 1 (see the format comment above — a lone span must never be on
 * disk), a cellIndex outside the world, a NON-ASCENDING or duplicate
 * cellIndex, and anything `parsePackedSpans` rejects (odd length, empty or
 * overlapping spans, a lone span again, a bottom span off BEDROCK_FLOOR).
 * Strict ascent doubles as the duplicate check: a repeated index cannot also
 * be greater than the one before it.
 */
export function decodeColumnSpans(
  blob: Uint8Array,
  expectedCells: number,
  context: string,
): Map<number, Span[]> {
  // DataView rather than typed-array reads: the blob may be a view into a
  // larger pooled Buffer (better-sqlite3 hands back standalone ones today, but
  // the format claim — little-endian, exact bounds — must not depend on that),
  // and DataView reads are little-endian BY CONSTRUCTION on every host, which
  // retires the byte-swap question entirely for the multi-byte fields.
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const spansByCell = new Map<number, Span[]>();

  let offset = 0;
  // Below every real cell index, so the FIRST record's ascent check is a
  // comparison against a sentinel rather than a special case.
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
    // 0 or 1 BEFORE reading the spans: a count of 1 would otherwise "decode"
    // fine and quietly double-encode a one-span column (see the format comment
    // above), which is precisely the failure the check exists to prevent.
    if (spanCount < 2) {
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
    for (let k = 0; k < spanCount * VALUES_PER_SPAN; k++) {
      flat.push(view.getInt16(offset, true));
      offset += BYTES_PER_HEIGHT;
    }
    // One gate for everything semantic — range, emptiness, ascent, gaps, the
    // bedrock floor — reused rather than re-implemented, so the disk format
    // cannot drift from the canonical form columns.ts defines.
    const spans = parsePackedSpans(flat);
    if (spans === null) {
      throw new RangeError(
        `${context}: span table holds a malformed ${spanCount}-span list for cell ` +
          `${cellIndex}; refusing to restore a corrupt world`,
      );
    }
    spansByCell.set(cellIndex, spans);
  }
  return spansByCell;
}
