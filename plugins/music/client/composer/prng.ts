const UINT32_MODULUS = 4294967296;

const STATE_INCREMENT = 0x9e3779b9;

const MIX_MULTIPLIER_A = 0x85ebca6b;

const MIX_MULTIPLIER_B = 0xc2b2ae35;

const MIX_SHIFT_A = 15;

const MIX_SHIFT_B = 13;

const MIX_SHIFT_C = 16;

const MIX_ODD_MASK_A = 1;

const MIX_ODD_MASK_B = 61;

export interface Prng {
  next(): number;
}

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
