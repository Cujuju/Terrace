/**
 * The workspace's shared Vitest settings, as a PLAIN OBJECT.
 *
 * No `defineConfig` import here on purpose: this file sits at the workspace
 * root, vitest is a devDependency of each PACKAGE rather than of the root, and
 * `vitest/config` therefore does not resolve from here. Vite did not fail on
 * that — it warned, treated the import as external, and handed back a config
 * these settings were not in, so every suite silently ran on the 5 s default
 * this file exists to replace. Each package wraps this in its own
 * `defineConfig`, where the import resolves.
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
 * 5.1 s and 76 s. The slow ones were obvious; the ones just over five were not
 * — they pass when run alone and fail only under full-suite parallel load, and
 * they surfaced one package at a time as each earlier one went green.
 *
 * 300 s is a rail against a hung test, not a budget anything is expected to
 * approach; what a suite actually costs is its reported duration, which this
 * does not change. Tests whose own measurement needs more say so inline.
 *
 * Raised rather than shrunk, every time: the ground these tests cover IS the
 * contract — a smaller world stops being a lair, stops having a coastline,
 * stops having room for a forest — and sampling the scans instead would test
 * something other than what ships.
 */
export default {
  test: {
    testTimeout: 300_000,
  },
};
