// The plugin's one seeded PRNG, used to pick CA seed patterns and their
// placement (life.ts) so the whole board's history is reproducible from one
// persisted sequence — exactly one generator, the same way flora and relics
// each keep exactly one.
//
// mulberry32, from @terrace/shared — imported now rather than copied per
// plugin. The "own copy per plugin" rule is about a plugin depending on a
// NEIGHBOUR; shared/ is core, so this plugin still builds and runs with every
// other plugin deleted. Chosen over Math.random because Math.random cannot be
// seeded and therefore cannot be persisted or reproduced — a self-hoster
// reporting "my first town spawned in a weird spot" needs a reproducible run,
// and so do the tests.

import { createSeededRng } from '@terrace/shared';

export interface StructuresRng {
  /** Next value in [0, 1). */
  next(): number;
  /** Current internal state, for the persistence slice. */
  state(): number;
}

/** Seed for a fresh world that has never rolled a CA seed pattern. Fixed, not clock-derived — see the module note above for why. */
export const STRUCTURES_RNG_DEFAULT_SEED = 0x57a7e5;

export function createStructuresRng(seed: number): StructuresRng {
  return createSeededRng(seed);
}
