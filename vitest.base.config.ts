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
 * 30 s is a rail against a hung test, not a budget anything is expected to
 * approach; what a suite actually costs is its reported duration, which this
 * does not change. Tests whose own measurement needs more say so inline.
 *
 * Owner, 2026-09-02: 30 s, down from 300 s, after a workspace run sat for
 * 26 minutes on a hung package. A test that legitimately needs longer states
 * its own `{ timeout }` inline, where the reader can see why.
 *
 * Raised rather than shrunk, every time: the ground these tests cover IS the
 * contract — a smaller world stops being a lair, stops having a coastline,
 * stops having room for a forest — and sampling the scans instead would test
 * something other than what ships.
 */
export default {
  test: {
    testTimeout: 30_000,
    // THE SAME RAIL FOR A FIXTURE AS FOR AN ASSERTION (2026-09-04). Vitest's
    // hook budget is a separate 10 s default, and everything the note above
    // says about slow fixtures applies to the hooks that BUILD them — more so,
    // since a `beforeAll` is where a suite puts the world it did not want to
    // build five times. The wildlife suite's settled population is documented
    // at "about eight seconds of wall clock" and was therefore one species away
    // from failing on a rail nobody had set deliberately; adding the wolf
    // spent that margin. Matching the two numbers is the fix: a suite that may
    // spend 30 s proving something may spend 30 s setting it up.
    hookTimeout: 30_000,
    // NODE RUNS THE MODULES, NOT VITE (owner decision 2026-09-02). Vite's
    // default pipeline re-transforms every file of the import graph and
    // executes it through its module runner, once per test file: measured on
    // the monsters suite at 11-26 s of import for a graph Node's own type
    // stripping loads in 1.5 s. With the runner off, transform is zero and
    // the tests themselves run faster too (8.7 s -> 3.3 s). The cost is the
    // rule shared/ already lives under, now repo-wide: erasable syntax only
    // (no enums, namespaces or constructor parameter properties), and no
    // vite-only features in tests (aliases, import.meta.env, CSS imports).
    // Experimental in vitest 4.1; verified per package on 2026-09-02.
    experimental: {
      viteModuleRunner: false,
    },
    // One module graph per worker rather than one per test file. Suites that
    // hold module-level state reset it themselves (monsters'
    // resetMonstersState); a suite that assumed a fresh module per file would
    // show up as an order-dependent failure.
    isolate: false,
  },
};
