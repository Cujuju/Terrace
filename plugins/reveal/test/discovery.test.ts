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
  });

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
  });
});
