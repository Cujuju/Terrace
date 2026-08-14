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

    expect(loaded.map((entry) => entry.directory)).toEqual(['mana', 'reveal']);
    expect(loaded.map((entry) => entry.plugin.name)).toEqual(['mana', 'reveal']);
  });

  it('implement the hooks each one advertises', async () => {
    const byName = new Map(
      (await discoverPlugins(PLUGINS_DIR)).map((entry) => [entry.plugin.name, entry.plugin]),
    );

    const mana = byName.get('mana');
    expect(mana?.onIntent).toBeTypeOf('function');
    expect(mana?.onTick).toBeTypeOf('function');
    expect(mana?.onPlayerJoin).toBeTypeOf('function');

    const reveal = byName.get('reveal');
    expect(reveal?.onTerrainChanged).toBeTypeOf('function');
    expect(reveal?.persistence?.save).toBeTypeOf('function');
  });
});
