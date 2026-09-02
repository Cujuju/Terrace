// Randomness, and this plugin's own SEAM into it.
//
// Nothing here is terrain math — no client reproduces any of it, the results
// travel to clients as authoritative system positions — so Math.random is fine
// (the determinism contract in CLAUDE.md governs shared/ terrain math, not plugin
// sim). The arithmetic itself lives in @terrace/shared; what stays here is the
// swappable source, because `fogRandom` and `setFogRandomSource` are what this
// plugin's suite installs a generator through.

import { createRandomSource } from '@terrace/shared';

const source = createRandomSource();

/** Returns a float in [0, 1). Handed to the disc engine as its source. */
export const fogRandom = source.random;

/**
 * TEST SEAM. Installs a random source; `null` restores Math.random.
 *
 * Deliberately NOT cleared by the plugin's own state reset: a suite installs a
 * seeded generator once and then resets sim state repeatedly, and having the
 * reset silently re-arm Math.random would make those tests flaky in a way that
 * looks like a sim bug.
 */
export const setFogRandomSource = source.setSource;
