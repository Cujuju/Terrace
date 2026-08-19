// Plugin discovery + host behaviour. Discovery runs against real fixture
// directories under test/fixtures, because the contract being tested IS the
// filesystem convention.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../src/config.ts';
import { PluginLoadError, discoverPlugins } from '../src/plugins/discovery.ts';
import { MAX_TERRAIN_CHANGE_DEPTH, PluginHost } from '../src/plugins/host.ts';
import type { TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import { namespacedMessageType } from '../src/plugins/world-api.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const WORLD_SIZE = 64;
const PLAYER = { id: 'session-1', name: 'Tester' };

describe('discoverPlugins', () => {
  it('loads server halves in deterministic alphabetical directory order', async () => {
    const loaded = await discoverPlugins(join(FIXTURES, 'plugins'));

    // a-first, b-second, d-named-differently — c-client-only has no server half.
    expect(loaded.map((entry) => entry.directory)).toEqual([
      'a-first',
      'b-second',
      'd-named-differently',
    ]);
    expect(loaded.map((entry) => entry.plugin.name)).toEqual([
      'first',
      'second',
      'named-differently',
    ]);
  });

  it('is stable across repeated discovery of the same directory', async () => {
    const first = await discoverPlugins(join(FIXTURES, 'plugins'));
    const second = await discoverPlugins(join(FIXTURES, 'plugins'));
    expect(second.map((entry) => entry.plugin.name)).toEqual(
      first.map((entry) => entry.plugin.name),
    );
  });

  it('returns nothing when the plugins directory does not exist', async () => {
    expect(await discoverPlugins(join(FIXTURES, 'does-not-exist'))).toEqual([]);
  });

  it('propagates a real I/O error instead of reporting it as "no plugins directory"', async () => {
    // "not-a-directory" is a plain file, so readdir() fails with ENOTDIR, not
    // ENOENT. Only ENOENT (directory genuinely absent) may resolve to [];
    // any other error is a misconfiguration (e.g. EACCES on a bad mount) and
    // must abort boot rather than silently come up with zero plugins.
    await expect(discoverPlugins(join(FIXTURES, 'not-a-directory'))).rejects.toThrow();
  });

  it('aborts on an illegal plugin name', async () => {
    await expect(discoverPlugins(join(FIXTURES, 'bad-name-plugins'))).rejects.toThrow(
      PluginLoadError,
    );
  });

  it('aborts on duplicate plugin names', async () => {
    await expect(discoverPlugins(join(FIXTURES, 'duplicate-plugins'))).rejects.toThrow(
      /duplicate plugin name "twice"/,
    );
  });

  it('aborts when a server entry exports no plugin', async () => {
    await expect(discoverPlugins(join(FIXTURES, 'no-plugin-export'))).rejects.toThrow(
      /no TerracePlugin export/,
    );
  });
});

describe('PluginHost', () => {
  it('invokes hooks in load order', () => {
    const calls: string[] = [];
    const make = (name: string): TerracePlugin => ({
      name,
      onWorldCreate: () => calls.push(`create:${name}`),
      onTick: () => calls.push(`tick:${name}`),
      onPlayerJoin: () => calls.push(`join:${name}`),
      onPlayerLeave: () => calls.push(`leave:${name}`),
    });

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [make('alpha'), make('beta')].map(asLoadedPlugin));

    host.worldCreate();
    host.tick(0.1);
    host.playerJoined(PLAYER);
    host.playerLeft(PLAYER);

    expect(calls).toEqual([
      'create:alpha',
      'create:beta',
      'tick:alpha',
      'tick:beta',
      'join:alpha',
      'join:beta',
      'leave:alpha',
      'leave:beta',
    ]);
  });

  it('keeps running when a plugin throws', () => {
    const calls: string[] = [];
    const broken: TerracePlugin = {
      name: 'broken',
      onTick(): void {
        throw new Error('boom');
      },
    };
    const healthy: TerracePlugin = { name: 'healthy', onTick: () => calls.push('tick') };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [broken, healthy].map(asLoadedPlugin));

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => host.tick(0.1)).not.toThrow();
    errors.mockRestore();

    expect(calls).toEqual(['tick']);
  });

  it('namespaces plugin messages so they cannot collide with core or each other', () => {
    const received: unknown[] = [];
    const plugin: TerracePlugin = {
      name: 'mana',
      messages: {
        spend: (_world: WorldApi, _player, payload) => received.push(payload),
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [plugin].map(asLoadedPlugin));
    const handlers = host.messageHandlers();

    expect(handlers.map(([type]) => type)).toEqual(['mana:spend']);
    expect(namespacedMessageType('mana', 'spend')).toBe('mana:spend');

    handlers[0][1](PLAYER, { amount: 3 });
    expect(received).toEqual([{ amount: 3 }]);
  });

  it('gives plugins a WorldApi whose edits broadcast filtered diffs and whose sends are namespaced', () => {
    let api: WorldApi | undefined;
    const plugin: TerracePlugin = {
      name: 'terraformer',
      onWorldCreate(world): void {
        api = world;
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    new PluginHost(world, [plugin].map(asLoadedPlugin)).worldCreate();

    expect(api).toBeDefined();
    if (!api) return;

    expect(api.worldSize).toBe(WORLD_SIZE);
    expect(api.isCellUnlocked(0, 0)).toBe(true);
    expect(api.isCellUnlocked(40, 40)).toBe(false);

    api.sculpt(4, 4, 1, 64);
    expect(world.heightAt(4, 4)).toBeGreaterThan(0);
    expect(sink.ofType('terrainDiff')).toHaveLength(1);

    expect(api.unlockChunk(1, 1)).toBe(true);
    expect(api.unlockChunk(1, 1)).toBe(false); // idempotent, no second stream
    expect(sink.ofType('chunkUnlock')).toHaveLength(1);

    api.broadcast('ready', { ok: true });
    expect(sink.ofType('terraformer:ready')).toHaveLength(1);

    api.sendTo(PLAYER.id, 'private', 1);
    const targeted = sink.ofType('terraformer:private');
    expect(targeted).toHaveLength(1);
    expect(targeted[0].target).toBe(PLAYER.id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // WorldApi.difficulty (added 2026-08-14). Core's job is to PUBLISH the world's
  // rating to plugins and nothing else — the mechanics belong to whoever reads
  // it — so what core owes a test is exactly: the number reaches the plugin, it
  // is the world's own, and it stays inside the documented band.
  // ──────────────────────────────────────────────────────────────────────────

  /** Boots one plugin on a world of the given difficulty and hands back its API. */
  function apiForDifficulty(difficulty?: number): WorldApi {
    let api: WorldApi | undefined;
    const plugin: TerracePlugin = {
      name: 'rater',
      onWorldCreate(world): void {
        api = world;
      },
    };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]], difficulty);
    new PluginHost(world, [plugin].map(asLoadedPlugin)).worldCreate();
    if (api === undefined) throw new Error('onWorldCreate was never called');
    return api;
  }

  it('exposes the world’s difficulty rating to plugins', () => {
    expect(apiForDifficulty(MIN_WORLD_DIFFICULTY).difficulty).toBe(MIN_WORLD_DIFFICULTY);
    expect(apiForDifficulty(MAX_WORLD_DIFFICULTY).difficulty).toBe(MAX_WORLD_DIFFICULTY);
    expect(apiForDifficulty(37).difficulty).toBe(37);
    // An unconfigured deployment: the plugin still sees a usable number.
    expect(apiForDifficulty().difficulty).toBe(DEFAULT_WORLD_DIFFICULTY);
  });

  it('never hands a plugin a difficulty outside the documented band', () => {
    // The env path cannot produce these (loadConfig clamps first); this is the
    // second layer, for every OTHER caller that builds a World directly.
    expect(apiForDifficulty(0).difficulty).toBe(MIN_WORLD_DIFFICULTY);
    expect(apiForDifficulty(10_000).difficulty).toBe(MAX_WORLD_DIFFICULTY);
    expect(apiForDifficulty(Number.NaN).difficulty).toBe(DEFAULT_WORLD_DIFFICULTY);
    expect(apiForDifficulty(50.4).difficulty).toBe(50);
  });

  it('stops a runaway onTerrainChanged → sculpt cascade', () => {
    let depth = 0;
    const runaway: TerracePlugin = {
      name: 'runaway',
      onWorldCreate(world): void {
        api = world;
      },
      onTerrainChanged(): void {
        depth++;
        api?.sculpt(4, 4, 1, 8);
      },
    };
    let api: WorldApi | undefined;

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [runaway].map(asLoadedPlugin));
    host.worldCreate();

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => api?.sculpt(4, 4, 1, 64)).not.toThrow();
    errors.mockRestore();

    // The guard fired: the cascade ran exactly to the cap and stopped there,
    // instead of recursing until the stack (or the tick) died.
    expect(depth).toBe(MAX_TERRAIN_CHANGE_DEPTH);
  });

  it('ignores snapshot slices belonging to plugins that are no longer installed', () => {
    const loaded: unknown[] = [];
    const plugin: TerracePlugin = {
      name: 'kept',
      persistence: {
        save: () => ({ n: 1 }),
        load: (data) => loaded.push(data),
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [plugin].map(asLoadedPlugin));

    expect(() =>
      host.restorePersistence({ kept: { n: 5 }, removed: { whatever: true } }),
    ).not.toThrow();
    expect(loaded).toEqual([{ n: 5 }]);
    expect(host.collectPersistence()).toEqual({ kept: { n: 1 } });
  });
});
