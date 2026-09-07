// How the two example plugins are PACKAGED — the handful of facts that are
// about mana and reveal specifically, and that no other suite states.
//
// WHAT THIS FILE USED TO BE, AND WHY IT ISN'T (2026-09-06). It called the real
// `discoverPlugins` against the real plugins/ folder, which dynamically
// imports the server half of all twenty-six shipped plugins — 15–30 s on the
// owner's drvfs checkout, the slowest test in the repo, and a recurring
// timeout flake that read as "whichever commit is in the tree broke it".
//
// It bought three things, and it was the wrong place for all three:
//
//   * THE LOADER'S OWN CONTRACT — deterministic alphabetical order, a plugin
//     whose name differs from its directory, a missing plugins/ directory, a
//     real I/O error. Already covered, on four cheap fixtures, by
//     server/test/plugin-host.test.ts's own `discoverPlugins` suite. Testing
//     it a second time against twenty-six real plugins asserts nothing the
//     fixtures do not, at a hundred times the cost.
//   * FACTS ABOUT THESE TWO PLUGINS — mana loads before reveal, reveal
//     persists nothing. Neither one needs the other twenty-four imported:
//     the order is a fact about two directory NAMES, and the persistence is a
//     fact about one module this file can import directly.
//   * "EVERY SHIPPED PLUGIN STILL IMPORTS" — the only assertion that genuinely
//     needed the whole folder. Deliberately dropped rather than moved here: a
//     plugin that fails to import cannot be missed, because `discoverPlugins`
//     raises PluginLoadError and the server refuses to boot on it. Paying a
//     ninety-second ceiling in a package suite to pre-detect a failure that is
//     already loud, immediate and unmissable at boot is the wrong trade. If it
//     is ever wanted back, it belongs in a boot smoke test run once, not in
//     the suite of one plugin that happens to sit next to it.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { plugin as manaPlugin } from '../../mana/server/index.ts';
import { plugin as revealPlugin } from '../server/index.ts';

/** …/plugins/reveal/test → …/plugins */
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The shipped plugin directories, in the order the loader sorts them. */
const shippedDirectories = (): string[] =>
  readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

describe('the example plugins as shipped', () => {
  it("names each plugin after its own directory", () => {
    const directories = shippedDirectories();
    expect(directories).toContain('mana');
    expect(directories).toContain('reveal');
    expect(manaPlugin.name).toBe('mana');
    expect(revealPlugin.name).toBe('reveal');
  });

  it('loads mana before reveal, so the land is charged for before it is granted', () => {
    // Load order IS effect-hook order (server/src/plugins/discovery.ts sorts
    // directories by raw name), and two plugins now DEPEND on this one rather
    // than merely benefiting from it: mana prices the chunks a stroke is about
    // to open (openedChunksFor, plugins/mana/server/index.ts) inside the same
    // effect phase in which reveal hands them over. Charge, then grant.
    //
    // Sorted order already implies this while the directories are named 'mana'
    // and 'reveal'. The assertion is here so that a rename which quietly
    // inverts them fails as a broken contract instead of as free territory.
    const directories = shippedDirectories();
    expect(directories.indexOf('mana')).toBeLessThan(directories.indexOf('reveal'));
  });

  it('keeps reveal stateless', () => {
    // Since issue #17 (2026-08-19) reveal's policy reads and writes core's own
    // per-token masks (WorldApi.unlockChunkForToken), so it has nothing of its
    // own left to persist — and a persistence slice appearing here would mean
    // the policy had quietly grown state that a restart has to carry.
    expect(revealPlugin.persistence).toBeUndefined();
  });
});
