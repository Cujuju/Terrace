// The plugin's one seeded PRNG, used to pick CA seed patterns and their
// placement (life.ts) so the whole board's history is reproducible from one
// persisted sequence — exactly one generator, the same way flora and relics
// each keep exactly one.
//
// mulberry32, a COPY of flora's/relics' (own copy per plugin: every plugin
// must build and run with any other plugin deleted). Chosen over Math.random
// because Math.random cannot be seeded and therefore cannot be persisted or
// reproduced — a self-hoster reporting "my first town spawned in a weird spot"
// needs a reproducible run, and so do the tests.

export interface StructuresRng {
  /** Next value in [0, 1). */
  next(): number;
  /** Current internal state, for the persistence slice. */
  state(): number;
}

/** Seed for a fresh world that has never rolled a CA seed pattern. Fixed, not clock-derived — see the module note above for why. */
export const STRUCTURES_RNG_DEFAULT_SEED = 0x57a7e5;

export function createStructuresRng(seed: number): StructuresRng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    },
    state(): number {
      return a;
    },
  };
}
