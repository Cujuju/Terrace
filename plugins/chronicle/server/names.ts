// Deterministic place names. The chronicle names WHERE things happened, but
// coordinates must never reach the wire (see protocol.ts's fog-of-war note) —
// so every chunk gets a stable invented name, derived from its coordinates by
// integer hashing alone. Same chunk, same name, on every server and every
// boot; no RNG, no state, nothing to persist.
//
// Names are PER CHUNK, deliberately: a settlement's cells wander within a
// neighbourhood as the CA churns, and stamping the name at chunk granularity
// keeps one place's saga lines using one name instead of a new name per cell.
// Two nearby chunks sharing a name (the combination space is 24 × 16 = 384)
// is harmless — real places share names too.

/**
 * First halves. The vocabulary is the same weathered-northern register the
 * worldgen names already use ("Frostwick Hollows"), so chronicle lines read
 * as the same world.
 */
const PLACE_PREFIXES = [
  'Harrow', 'Frost', 'Alder', 'Ember', 'Stone', 'Fen',
  'Gale', 'Moss', 'Thorn', 'Bram', 'Wolf', 'Raven',
  'Salt', 'Ash', 'Briar', 'Elm', 'Heath', 'Crag',
  'Mire', 'Dun', 'Loam', 'Rowan', 'Sedge', 'Tarn',
] as const;

/** Second halves. */
const PLACE_SUFFIXES = [
  'mere', 'wick', 'holt', 'fell', 'stead', 'combe',
  'ford', 'gate', 'moor', 'dale', 'strand', 'barrow',
  'cliff', 'reach', 'march', 'hollow',
] as const;

/**
 * 32-bit avalanche mix (fmix32 from MurmurHash3 — a published constant set,
 * chosen because it is the standard answer for "spread two small integers
 * over 32 bits", not tuned here). Math.imul keeps every step an exact int32
 * op, so the result is identical on every JS engine.
 */
function mix32(cx: number, cy: number): number {
  let h = (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** The stable invented name of chunk (cx, cy). */
export function placeName(cx: number, cy: number): string {
  const h = mix32(cx, cy);
  const prefix = PLACE_PREFIXES[h % PLACE_PREFIXES.length];
  // A DIFFERENT byte of the hash than the prefix used, so the two picks are
  // not correlated through a shared low-bits modulus.
  const suffix = PLACE_SUFFIXES[(h >>> 8) % PLACE_SUFFIXES.length];
  return `${prefix}${suffix}`;
}
