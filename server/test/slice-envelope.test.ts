// THE SLICE VERSION ENVELOPE — contract tests, at the host, not per plugin.
//
// The contract these prove (docs/plans/plugin-hot-unload.md §3.3):
//
//   1. The host wraps every save as `{ v, data }`, so a plugin that never
//      versioned its own format has a version anyway.
//   2. A stored value with no envelope is read as version 1 and handed to
//      `load(data, 1)` — this is 100 % of the bytes on every existing world
//      file, so getting it wrong would bring every plugin up EMPTY on the
//      first boot after the change.
//   3. `load(data, fromVersion)` gets the version the bytes were written
//      under, so a plugin can migrate across N versions.
//   4. A stored version HIGHER than the code's is PARKED: `load` is not
//      called, the plugin runs stateless, and the bytes are re-emitted
//      verbatim — for the life of the session, not just one snapshot. One
//      snapshot passes even with the bug this rule replaces (the enabled
//      plugin's own empty save overwriting the parked bytes), so every
//      parking test here checks TWO consecutive snapshots.
//   5. A plugin may refuse a slice it cannot read; a refusal parks it the
//      same way, which is what closes the gap for a pre-envelope blob whose
//      own self-described version is ahead of the code.
//   6. A `load` that THROWS parks identically (issue #206). The plugin did not
//      choose to decline, but it is in the same position as one that did: it
//      holds none of the stored state, so its own empty save must not reach
//      the slice key. §3.5 of the plan lists throw and refuse as one row.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK_SIZE } from '@terrace/shared';
import { describe, expect, it, vi } from 'vitest';
import { discoverPlugins } from '../src/plugins/discovery.ts';
import { PluginHost } from '../src/plugins/host.ts';
import type { PersistenceSlice, TerracePlugin } from '../src/plugins/types.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

/** The repo's real plugins/ directory — this file's own location, two up. */
const REPO_PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');

const WORLD_SIZE = CHUNK_SIZE * 4;

/** A plugin whose slice records every load it is handed. */
function recordingPlugin(
  name: string,
  version: number,
  options: { refuseFrom?: number; throwFrom?: number } = {},
): { plugin: TerracePlugin; loads: Array<{ data: unknown; fromVersion: number }>; state: { n: number } } {
  const loads: Array<{ data: unknown; fromVersion: number }> = [];
  const state = { n: 0 };
  const persistence: PersistenceSlice = {
    version,
    save: () => ({ n: state.n }),
    load: (data, fromVersion) => {
      if (options.refuseFrom !== undefined && fromVersion === options.refuseFrom) return 'refuse';
      // A malformed slice this build cannot parse — the accidental sibling of a
      // refusal, and the case issue #206 was filed against.
      if (options.throwFrom !== undefined && fromVersion === options.throwFrom) {
        throw new Error('malformed slice');
      }
      loads.push({ data, fromVersion });
      const parsed = data as { n?: unknown };
      state.n = typeof parsed.n === 'number' ? parsed.n : 0;
      return undefined;
    },
  };
  return { plugin: { name, persistence }, loads, state };
}

function hostFor(plugins: readonly TerracePlugin[]): PluginHost {
  const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
  return new PluginHost(world, plugins.map(asLoadedPlugin));
}

describe('slice version envelope', () => {
  it('wraps every save in the host envelope, version included', () => {
    const { plugin, state } = recordingPlugin('kept', 3);
    state.n = 7;
    const host = hostFor([plugin]);

    expect(host.collectPersistence()).toEqual({ kept: { v: 3, data: { n: 7 } } });
  });

  it('hands load the version the bytes were written under', () => {
    const { plugin, loads } = recordingPlugin('kept', 3);
    const host = hostFor([plugin]);

    host.restorePersistence({ kept: { v: 2, data: { n: 5 } } });

    expect(loads).toEqual([{ data: { n: 5 }, fromVersion: 2 }]);
  });

  it('reads a value with no envelope as version 1', () => {
    const { plugin, loads } = recordingPlugin('kept', 3);
    const host = hostFor([plugin]);

    // Exactly the shape every world file on disk holds today: the plugin's own
    // save value, stored verbatim with no version anywhere.
    host.restorePersistence({ kept: { n: 4 } });

    expect(loads).toEqual([{ data: { n: 4 }, fromVersion: 1 }]);
  });

  it('rewrites a pre-envelope slice in envelope form on the next save', () => {
    const { plugin } = recordingPlugin('kept', 3);
    const host = hostFor([plugin]);

    host.restorePersistence({ kept: { n: 4 } });

    expect(host.collectPersistence()).toEqual({ kept: { v: 3, data: { n: 4 } } });
  });

  describe('downgrade (stored version ahead of the code)', () => {
    it('does not call load, and the plugin runs stateless', () => {
      const { plugin, loads, state } = recordingPlugin('kept', 3);
      const host = hostFor([plugin]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ kept: { v: 4, data: { n: 9 } } });
      warn.mockRestore();

      expect(loads).toEqual([]);
      expect(state.n).toBe(0);
    });

    it('re-emits the parked bytes byte-identically over TWO consecutive snapshots', () => {
      const { plugin, state } = recordingPlugin('kept', 3);
      const host = hostFor([plugin]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ kept: { v: 4, data: { n: 9 } } });
      warn.mockRestore();

      // The plugin is running, and would happily save its own empty state —
      // the write-suppress set is what stops it reaching the slice key.
      state.n = 99;
      const first = JSON.stringify(host.collectPersistence());
      const second = JSON.stringify(host.collectPersistence());

      expect(first).toBe(JSON.stringify({ kept: { v: 4, data: { n: 9 } } }));
      expect(second).toBe(first);
    });

    it('warns exactly once for a parked slice, not once per snapshot', () => {
      const { plugin } = recordingPlugin('kept', 3);
      const host = hostFor([plugin]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ kept: { v: 4, data: { n: 9 } } });
      host.collectPersistence();
      host.collectPersistence();
      const calls = warn.mock.calls.length;
      warn.mockRestore();

      expect(calls).toBe(1);
    });

    it('leaves every other plugin\'s slice alone', () => {
      const ahead = recordingPlugin('ahead', 3);
      const fine = recordingPlugin('fine', 1);
      fine.state.n = 2;
      const host = hostFor([ahead.plugin, fine.plugin]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ ahead: { v: 4, data: { n: 9 } }, fine: { v: 1, data: { n: 2 } } });
      warn.mockRestore();

      expect(host.collectPersistence()).toEqual({
        ahead: { v: 4, data: { n: 9 } },
        fine: { v: 1, data: { n: 2 } },
      });
    });
  });

  describe('a plugin refusing a slice it cannot read', () => {
    it('reports the slice as parked', () => {
      const { plugin } = recordingPlugin('picky', 2, { refuseFrom: 1 });
      const host = hostFor([plugin]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ picky: { legacy: true } });
      warn.mockRestore();

      expect(host.isSliceParked('picky')).toBe(true);
    });

    it('parks it and re-emits it byte-identically over TWO consecutive snapshots', () => {
      // Refuses anything written under version 1 — the case a pre-envelope
      // blob whose own self-described version is ahead of the code produces.
      const { plugin, state } = recordingPlugin('picky', 2, { refuseFrom: 1 });
      const host = hostFor([plugin]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ picky: { legacy: true } });
      warn.mockRestore();

      state.n = 42;
      const first = JSON.stringify(host.collectPersistence());
      const second = JSON.stringify(host.collectPersistence());

      expect(first).toBe(JSON.stringify({ picky: { legacy: true } }));
      expect(second).toBe(first);
    });
  });

  // ISSUE #206: `load` used to run through `safely`, which swallows a throw and
  // returns undefined — indistinguishable there from a successful void return.
  // The slice was therefore never parked, and the plugin's own post-throw empty
  // save replaced the recoverable bytes at the next snapshot, ~60 s after boot.
  describe('a plugin whose load() THROWS on a malformed slice', () => {
    it('reports the slice as parked', () => {
      const { plugin } = recordingPlugin('brittle', 1, { throwFrom: 1 });
      const host = hostFor([plugin]);

      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ brittle: { broken: true } });
      warn.mockRestore();
      errors.mockRestore();

      expect(host.isSliceParked('brittle')).toBe(true);
    });

    it('re-emits the stored bytes byte-identically over TWO consecutive snapshots', () => {
      const { plugin, state } = recordingPlugin('brittle', 1, { throwFrom: 1 });
      const host = hostFor([plugin]);

      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ brittle: { broken: true } });
      warn.mockRestore();
      errors.mockRestore();

      // The plugin came up empty and is running; only write-suppression keeps
      // its empty save off the slice key.
      state.n = 77;
      const first = JSON.stringify(host.collectPersistence());
      const second = JSON.stringify(host.collectPersistence());

      expect(first).toBe(JSON.stringify({ brittle: { broken: true } }));
      expect(second).toBe(first);
    });

    it('still counts the throw as a fault, so the reload gate keeps seeing it', () => {
      const { plugin } = recordingPlugin('brittle', 1, { throwFrom: 1 });
      const host = hostFor([plugin]);

      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ brittle: { broken: true } });
      const logged = errors.mock.calls.map((call) => call.map(String).join(' '));
      warn.mockRestore();
      errors.mockRestore();

      expect(host.faultCount('brittle')).toBe(1);
      expect(logged.filter((line) => line.includes('threw in persistence.load'))).toHaveLength(1);
    });

    it('leaves a healthy sibling loading and saving normally', () => {
      const brittle = recordingPlugin('brittle', 1, { throwFrom: 1 });
      const fine = recordingPlugin('fine', 1);
      const host = hostFor([brittle.plugin, fine.plugin]);

      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence({ brittle: { broken: true }, fine: { v: 1, data: { n: 3 } } });
      warn.mockRestore();
      errors.mockRestore();

      expect(host.isSliceParked('fine')).toBe(false);
      expect(fine.loads).toEqual([{ data: { n: 3 }, fromVersion: 1 }]);
      expect(host.collectPersistence()).toEqual({
        brittle: { broken: true },
        fine: { v: 1, data: { n: 3 } },
      });
    });
  });

  describe('a pre-envelope snapshot of the real plugins', () => {
    // A generous timeout, not a slow test: this one importing SIXTEEN real
    // plugin modules off a WSL2 drvfs mount is what costs the seconds.
    it('round-trips through every real slice unchanged', { timeout: 60_000 }, async () => {
      const loaded = await discoverPlugins(REPO_PLUGINS_DIR);
      const withSlices = loaded.filter((entry) => entry.plugin.persistence !== undefined);
      // If this ever reads zero, the assertions below prove nothing.
      expect(withSlices.length).toBeGreaterThan(0);

      const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
      world.setSink(new RecordingSink());
      const host = new PluginHost(world, loaded);

      // A world the plugins have actually opened, so the slices below hold
      // something rather than being sixteen empty objects.
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      host.worldCreate();

      // A PRE-ENVELOPE SNAPSHOT: each plugin's own save value stored RAW, which
      // is exactly what every world file written before this change holds.
      const legacy: Record<string, unknown> = {};
      for (const entry of withSlices) {
        legacy[entry.plugin.name] = structuredClone(entry.plugin.persistence?.save());
      }

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // load + worldCreate, in that order — the pair a boot and a rollback both
      // replay (see PersistenceSlice's re-runnable contract).
      host.restorePersistence(structuredClone(legacy));
      host.worldCreate();
      const parked = warn.mock.calls.map((call) => String(call[0]));
      const failures = errors.mock.calls.map((call) => String(call[0]));
      warn.mockRestore();
      errors.mockRestore();

      // NOTHING may refuse or throw on its own pre-envelope bytes: that is the
      // "restart; the world comes back from SQLite intact" criterion.
      expect(parked.filter((line) => line.includes('was written by a newer'))).toEqual([]);
      expect(failures).toEqual([]);

      // And what comes back out is what went in, now enveloped.
      const saved = host.collectPersistence();
      for (const entry of withSlices) {
        const name = entry.plugin.name;
        expect(saved[name]).toEqual({
          v: entry.plugin.persistence?.version,
          data: legacy[name],
        });
      }
    });
  });
});
