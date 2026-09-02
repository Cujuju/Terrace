// Structural guards for untrusted JSON — the two shapes every wire parser and
// every persistence slice in this repo starts from.
//
// WHY THEY ARE HERE. `isFiniteNumber` existed ten times, byte-identical, across
// six plugin protocols, two persistence slices and the client's camera pose; the
// "parse every element or abandon the whole array" loop existed in five slices.
// Both are properties of how this project reads data it did not write, which is
// what shared/ is the single source of truth for — not of any one plugin.
//
// TOTAL, NOT PARTIAL. A saved blob or a broadcast may predate the code reading
// it, so a shape that does not parse is DISCARDED WHOLE rather than
// half-applied: half a snapshot is a world with a hole in it, and nothing
// downstream would know which half it got.

/**
 * A number, and a real one.
 *
 * `typeof value === 'number'` alone admits NaN and ±Infinity, which is the whole
 * reason this is not written inline: a NaN that survives a parse becomes a NaN
 * coordinate, and a NaN coordinate propagates silently through every comparison
 * it touches instead of throwing anywhere near the bad data.
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Parses an array of records through a per-item parser, or returns null.
 *
 * NULL MEANS "ABANDON THE LOAD", not "skip the bad one". A slice's records are
 * one world's state: dropping the third of forty storms would leave a world that
 * is neither the saved one nor an empty one, and nothing would say so. The
 * caller decides what abandoning costs — every slice that uses this documents
 * that cost in its own header.
 *
 * An EMPTY array parses to an empty array. "Nothing was saved" is a valid
 * snapshot of a quiet world, and treating it as a failure would discard the rest
 * of the slice with it.
 */
export function parseRecordArray<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: T[] = [];
  for (const item of value) {
    const record = parseItem(item);
    if (record === null) return null;
    parsed.push(record);
  }
  return parsed;
}
