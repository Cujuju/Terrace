// The shipped plugins/ folder, loaded the way the server loads it at boot.
//
// This covers the packaging half of both example plugins — directory layout,
// server entry point, export name, name pattern, and the deterministic load
// order that IS the interceptor order. It lives in the reveal package because
// reveal is the flagship example, but it asserts on the whole folder.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverPlugins } from '../../../server/src/plugins/discovery.ts';

/** …/plugins/reveal/test → …/plugins */
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Wall-clock budget for a test that calls `discoverPlugins`, in milliseconds.
 *
 * Vitest's default is 5 s, and this is the one suite that pays the REAL cost
 * of the boot loader: `discoverPlugins` dynamically imports the server half of
 * every shipped plugin — thirteen of them — which on the owner's WSL2 checkout
 * (`/mnt/e`, a drvfs mount) is module resolution and type-stripping across a
 * Windows filesystem. Measured at ~5 s here for the FIRST call, which is what
 * matters: the second test in this file calls the same function and returns
 * almost instantly, because the module graph is already in the loader's cache.
 *
 * Raised rather than mocked. What this file is for is that the shipped folder
 * really loads the way the server loads it at boot, so stubbing the import
 * would delete the test's whole subject.
 *
 * 2026-08-21: added after this test failed on a busy machine and passed on an
 * idle one — a flake that reads as "whichever commit is in the tree broke it".
 */
const PLUGIN_DISCOVERY_TIMEOUT_MS = 30_000;

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
  }, PLUGIN_DISCOVERY_TIMEOUT_MS);

  it('implement the hooks each one advertises', async () => {
    const byName = new Map(
      (await discoverPlugins(PLUGINS_DIR)).map((entry) => [entry.plugin.name, entry.plugin]),
    );

    const mana = byName.get('mana');
    expect(mana?.onIntent).toBeTypeOf('function');
    expect(mana?.onTick).toBeTypeOf('function');
    expect(mana?.onPlayerJoin).toBeTypeOf('function');

    // reveal is STATELESS since issue #17 (2026-08-19): its per-player creep
    // policy reads and writes core's own per-token masks (WorldApi.
    // unlockChunkForToken), so it has nothing of its own left to persist.
    const reveal = byName.get('reveal');
    expect(reveal?.onTerrainChanged).toBeTypeOf('function');
    expect(reveal?.persistence).toBeUndefined();
    // Same budget as above. Usually fast (the loader's cache is warm by now),
    // but it is the same call and must not become the flake if it ever runs
    // first — vitest gives no ordering guarantee worth relying on here.
  }, PLUGIN_DISCOVERY_TIMEOUT_MS);
});
