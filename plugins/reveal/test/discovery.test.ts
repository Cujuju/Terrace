// The shipped plugins/ folder, loaded the way the server loads it at boot.
//
// This covers the PACKAGING contract every shipped plugin is held to —
// directory layout, server entry point, export name, name matching directory —
// and the deterministic load order that IS the interceptor order. It lives in
// the reveal package because reveal is the flagship example, but it asserts on
// the whole folder.
//
// ONE CALL, ONE TEST (2026-09-06). It used to be two tests, and the second
// paid a second `discoverPlugins` — the real import of every shipped plugin —
// to assert that mana still had onIntent/onTick/onPlayerJoin and reveal still
// had onTerrainChanged. Those are per-callsite wiring checks, not contracts:
// each plugin's own suite drives those hooks through the real host, so a
// missing one fails dozens of behavioural tests long before a `typeof` would
// notice. What the typeof checks DID do was double the slowest test in the
// repo — and they were stale anyway, still naming onTerrainChanged as reveal's
// hook after its policy moved to onIntentApplied.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverPlugins } from '../../../server/src/plugins/discovery.ts';

/** …/plugins/reveal/test → …/plugins */
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Shipped plugin directories — what `discoverPlugins` will actually import. */
const SHIPPED_PLUGIN_COUNT = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter(
  (entry) => entry.isDirectory(),
).length;

/**
 * Wall-clock budget for ONE plugin's cold load, in milliseconds.
 *
 * This is the one suite that pays the REAL cost of the boot loader:
 * `discoverPlugins` dynamically imports the server half of every shipped
 * plugin, which on the owner's WSL2 checkout (`/mnt/e`, a drvfs mount) is
 * module resolution and type-stripping across a Windows filesystem. Measured
 * at roughly a second per plugin with other agents compiling in the same
 * checkout; the figure here is that with room to spare, because the failure
 * mode of guessing low is a flake that reads as "whichever commit is in the
 * tree broke it" and the cost of guessing high is only a slower failure on a
 * genuine break.
 *
 * Raised rather than mocked. What this file is for is that the shipped folder
 * really loads the way the server loads it at boot, so stubbing the import
 * would delete the test's whole subject.
 */
const PLUGIN_COLD_LOAD_BUDGET_MS = 3_500;

/**
 * The budget for the whole call — PER PLUGIN, not a flat number.
 *
 * THE FLAT NUMBER IS WHY THIS KEPT FLAKING. It was 30 s, written on
 * 2026-08-21 against thirteen shipped plugins; there are now twenty-six, so
 * the work doubled while the budget did not, and the test began timing out on
 * a busy machine (2026-09-06) with nothing wrong in the tree. A budget for
 * loading N plugins has to be a function of N, or every plugin added to this
 * repo quietly spends someone else's headroom.
 */
const PLUGIN_DISCOVERY_TIMEOUT_MS = SHIPPED_PLUGIN_COUNT * PLUGIN_COLD_LOAD_BUDGET_MS;

describe('shipped example plugins', () => {
  it('are discovered from plugins/ in alphabetical directory order', async () => {
    const loaded = await discoverPlugins(PLUGINS_DIR);

    // Properties, not an exhaustive folder listing: the shipped plugin set
    // grows over time, and this test must not fail because a NEW plugin was
    // added next to these two. What it guards is (a) both examples load, (b)
    // each plugin's name matches its directory, and (c) load order — which IS
    // the interceptor order — is the sorted directory order.
    const directories = loaded.map((entry) => entry.directory);
    expect(directories).toContain('mana');
    expect(directories).toContain('reveal');
    expect(directories).toEqual([...directories].sort());
    for (const entry of loaded) {
      expect(entry.plugin.name).toBe(entry.directory);
    }

    // AND MANA LOADS BEFORE REVEAL, stated outright because two plugins now
    // DEPEND on it rather than merely benefiting from it. Effect hooks run in
    // load order, so mana prices the chunks a stroke is about to open
    // (openedChunksFor, plugins/mana/server/index.ts) BEFORE reveal hands them
    // over: charge for the land, then grant it. Sorted order already implies
    // this while the directories are named 'mana' and 'reveal' — the assertion
    // is here so that a rename which quietly inverts them fails as a broken
    // contract instead of as free territory.
    expect(directories.indexOf('mana')).toBeLessThan(directories.indexOf('reveal'));

    // reveal is STATELESS since issue #17 (2026-08-19): its policy reads and
    // writes core's own per-token masks (WorldApi.unlockChunkForToken), so it
    // has nothing of its own left to persist. Asserted here rather than in a
    // second test because it needs no second load.
    const reveal = loaded.find((entry) => entry.directory === 'reveal');
    expect(reveal?.plugin.persistence).toBeUndefined();
  }, PLUGIN_DISCOVERY_TIMEOUT_MS);
});
