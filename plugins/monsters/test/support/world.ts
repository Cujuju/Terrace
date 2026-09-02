// Test worlds with real terrain, and a deterministic random source.
//
// The shipped harness (server/test/support/harness.ts) only builds FLAT worlds,
// which are entirely shallow water — no deep basin, so no lair. This adds the
// two things the monsters plugin needs to be tested at all: a height field,
// built through the same World.restore path a snapshot uses, and a seeded
// generator so the summon roll is reproducible in CI.

import { createSeededRng } from '@terrace/shared';

// The builder itself lives in core's test support now
// (server/test/support/world.ts). It was a byte-identical copy in five plugin
// suites; the "a plugin's tests must not depend on another plugin" rule it was
// kept under is about a NEIGHBOURING PLUGIN, and core's test support is what
// every one of those suites already reaches for.
export { worldWithTerrain } from '../../../../server/test/support/world.ts';

/**
 * A seeded uniform generator, for tests that need the summon roll to behave like
 * randomness without being random.
 *
 * Mulberry32 — a 32-bit state PRNG with an avalanche finaliser. The obvious
 * alternative, a plain LCG, was tried first and REJECTED on measurement: the
 * summon gate compares against a probability of 4.2e-4 per tick, so the only
 * thing under test is the very top of the generator's output range, and an LCG's
 * lattice structure there skewed the measured mean wait to 1.5× the configured
 * one. Mulberry32's finaliser mixes the high bits, and the same measurement
 * lands within a few percent. No dependency (this repo asks before adding one):
 * the generator is @terrace/shared's, which is where the eight lines this used
 * to inline went.
 */
export function seededRandom(seed: number): () => number {
  return createSeededRng(seed).next;
}
