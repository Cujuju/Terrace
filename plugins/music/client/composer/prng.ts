// A tiny deterministic pseudo-random generator for the composer.
//
// WHY NOT Math.random. The composer's whole verification story is "the same
// seed renders the same PCM": the orchestrator hashes an OfflineAudioContext
// render and compares two runs. Math.random is seeded by the engine and cannot
// be pinned, so a single call to it anywhere in the note stream would make
// every render differ from every other and there would be nothing to check.
//
// WHY mulberry32 SPECIFICALLY. It is 32-bit integer state with a 2^32 period,
// four lines long, and its low-order bits are mixed — which matters here
// because a note picker consumes exactly those bits when it multiplies the
// value by a five-note scale length. A bare LCG has audible structure there.
// Anything stronger buys nothing: these values pick notes, not keys.

/** 2^32 — the modulus of the 32-bit state, and the divisor that maps it to [0, 1). */
const UINT32_MODULUS = 4294967296;

/** mulberry32's state increment: the 32-bit golden-ratio odd constant. */
const STATE_INCREMENT = 0x9e3779b9;

/** First multiplier of mulberry32's output mix (as published). */
const MIX_MULTIPLIER_A = 0x85ebca6b;

/** Second multiplier of mulberry32's output mix (as published). */
const MIX_MULTIPLIER_B = 0xc2b2ae35;

/** First xor-shift distance of the output mix. */
const MIX_SHIFT_A = 15;

/** Second xor-shift distance of the output mix. */
const MIX_SHIFT_B = 13;

/** Final xor-shift distance of the output mix. */
const MIX_SHIFT_C = 16;

/** The odd-forcing mask mulberry32 applies to its first multiplier. */
const MIX_ODD_MASK_A = 1;

/** The odd-forcing addend mulberry32 applies to its second multiplier. */
const MIX_ODD_MASK_B = 61;

/** A deterministic stream of numbers in [0, 1). */
export interface Prng {
  /** The next value in [0, 1). */
  next(): number;
}

/**
 * Creates the stream for `seed`. Any finite number is accepted; it is coerced
 * to a 32-bit unsigned integer, so `1` and `1.5` are the same stream and a
 * negative seed is legal.
 */
export function createPrng(seed: number): Prng {
  let state = Math.trunc(seed) >>> 0;
  return {
    next(): number {
      state = (state + STATE_INCREMENT) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> MIX_SHIFT_A), MIX_MULTIPLIER_A | MIX_ODD_MASK_A);
      mixed ^=
        mixed + Math.imul(mixed ^ (mixed >>> MIX_SHIFT_B), MIX_MULTIPLIER_B | MIX_ODD_MASK_B);
      return ((mixed ^ (mixed >>> MIX_SHIFT_C)) >>> 0) / UINT32_MODULUS;
    },
  };
}
