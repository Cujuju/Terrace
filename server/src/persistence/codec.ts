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
