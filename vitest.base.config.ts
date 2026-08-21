import { defineConfig } from 'vitest/config';

/**
 * The workspace's shared Vitest settings. Every package that needs them has a
 * one-line `vitest.config.ts` re-exporting this; packages whose suites are fast
 * have no config at all and take Vitest's own defaults.
 *
 * WHY A PER-TEST BUDGET LONGER THAN VITEST'S 5 s DEFAULT.
 *
 * The slow suites in this repo are slow in their FIXTURES, not their
 * assertions. Their subject is terrain — a basin big enough to be a lair, a
 * shelf with open sea outside it, a forest at its settled density — so their
 * worlds have to be ground-sized, and a pass over one is a pass over every cell
 * of it. The 2026-08-21 re-sample put sixteen times the cells inside that same
 * ground (shared's WORLD_UNIT_CELLS), so every whole-world scan in the repo got
 * sixteen times more expensive without a single behaviour changing.
 *
 * WHY ONE PLACE. Measured after the re-sample, the affected tests land between
 * 5.1 s and 14.8 s. The ones over ten seconds were obvious; the ones just over
 * five were not — they pass when run alone and fail only under full-suite
 * parallel load, which is the worst way for a suite to fail, and they surfaced
 * one package at a time as each earlier one went green. Annotating each test as
 * it appeared would have been a queue of identical numbers with no shared
 * reason attached, and the next scan to cross the line would have failed the
 * same way again. The cost is a fact about the whole workspace, so it is stated
 * once, here.
 *
 * 120 s is an 8x margin over the slowest measurement, for a slower machine. It
 * is a RAIL against a hung test, not a budget anything is expected to approach;
 * what a suite actually costs is its reported duration, which this does not
 * change.
 *
 * Raised rather than shrunk, every time: the ground these tests cover IS the
 * contract — a smaller world stops being a lair, stops having a coastline,
 * stops having room for a forest — and sampling the scans instead would test
 * something other than what ships.
 */
export default defineConfig({
  test: {
    testTimeout: 120_000,
  },
});
