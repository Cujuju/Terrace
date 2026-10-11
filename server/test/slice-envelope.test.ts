import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK_SIZE } from '@terrace/shared';
import { describe, expect, it, vi } from 'vitest';
import { discoverPlugins } from '../src/plugins/discovery.ts';
import { PluginHost } from '../src/plugins/host.ts';
import type { PersistenceSlice, TerracePlugin } from '../src/plugins/types.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

const REPO_PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');

const WORLD_SIZE = CHUNK_SIZE * 4;

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

    host.restorePersistence({ kept: { n: 4 } });

    expect(loads).toEqual([{ data: { n: 4 }, fromVersion: 1 }]);
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

      state.n = 99;
      const first = JSON.stringify(host.collectPersistence());
      const second = JSON.stringify(host.collectPersistence());

      expect(first).toBe(JSON.stringify({ kept: { v: 4, data: { n: 9 } } }));
      expect(second).toBe(first);
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
    it('round-trips through every real slice unchanged', { timeout: 60_000 }, async () => {
      const loaded = await discoverPlugins(REPO_PLUGINS_DIR);
      const withSlices = loaded.filter((entry) => entry.plugin.persistence !== undefined);
      expect(withSlices.length).toBeGreaterThan(0);

      const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
      world.setSink(new RecordingSink());
      const host = new PluginHost(world, loaded);

      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      host.worldCreate();

      const legacy: Record<string, unknown> = {};
      for (const entry of withSlices) {
        legacy[entry.plugin.name] = structuredClone(entry.plugin.persistence?.save());
      }

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      host.restorePersistence(structuredClone(legacy));
      host.worldCreate();
      const parked = warn.mock.calls.map((call) => String(call[0]));
      const failures = errors.mock.calls.map((call) => String(call[0]));
      warn.mockRestore();
      errors.mockRestore();

      expect(parked.filter((line) => line.includes('was written by a newer'))).toEqual([]);
      expect(failures).toEqual([]);

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
