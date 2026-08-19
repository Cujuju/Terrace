// Plugin discovery + host behaviour. Discovery runs against real fixture
// directories under test/fixtures, because the contract being tested IS the
// filesystem convention.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CellDiff, SculptIntent } from '@terrace/shared';
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
import type { Player } from '../src/player.ts';
import type { World } from '../src/world/world.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from './support/harness.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const WORLD_SIZE = 64;
const PLAYER = { id: 'session-1', token: 'token-1', name: 'Tester' };

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
  // Per-player unlock primitives (issue #17): unlockChunkForToken is the new
  // WorldApi write; isChunkVisibleTo/isCellVisibleTo are the read primitives
  // added for the planned fog-of-war follow-up (nothing calls them yet — see
  // their doc comments in plugins/types.ts and world.ts).
  // ──────────────────────────────────────────────────────────────────────────

  it('exposes unlockChunkForToken and the per-player visibility reads on WorldApi', () => {
    let api: WorldApi | undefined;
    const plugin: TerracePlugin = {
      name: 'territory',
      onWorldCreate(world): void {
        api = world;
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer(PLAYER);
    new PluginHost(world, [plugin].map(asLoadedPlugin)).worldCreate();

    expect(api).toBeDefined();
    if (!api) return;

    expect(api.isChunkVisibleTo(PLAYER.id, 2, 2)).toBe(false);
    expect(api.unlockChunkForToken(PLAYER.token, 2, 2)).toBe(true);
    expect(api.unlockChunkForToken(PLAYER.token, 2, 2)).toBe(false); // idempotent per token

    expect(api.isChunkVisibleTo(PLAYER.id, 2, 2)).toBe(true);
    expect(api.isCellVisibleTo(PLAYER.id, 2 * 16 + 1, 2 * 16 + 1)).toBe(true);
    // Nobody connected under this id — the safe default is false, not a throw.
    expect(api.isChunkVisibleTo('no-such-player', 2, 2)).toBe(false);

    const targeted = sink.ofType('chunkUnlock');
    expect(targeted).toHaveLength(1);
    expect(targeted[0].target).toBe(PLAYER.id); // sendTo, never a broadcast
  });

  it('forwards the sculptor token from a player edit to onTerrainChanged, and omits it for a plugin edit', () => {
    const seen: Array<string | undefined> = [];
    const plugin: TerracePlugin = {
      name: 'token-watcher',
      onTerrainChanged(_world, _diff, sculptorToken): void {
        seen.push(sculptorToken);
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [plugin].map(asLoadedPlugin));
    host.worldCreate();

    host.notifyTerrainChanged([{ x: 1, y: 1, h: 64 }], PLAYER.token);
    host.notifyTerrainChanged([{ x: 2, y: 2, h: 64 }]); // no sculptor — a plugin's own edit

    expect(seen).toEqual([PLAYER.token, undefined]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onTerrainChanged / onPlayerJoin / onPlayerLeave get a WorldApi (issue #15).
  //
  // onWorldCreate/onTick/onIntent always carried one; these three did not, which
  // forced every plugin that reacted to terrain or players (invite, reveal,
  // flora, mana, monsters, relics, wildlife) to stash the WorldApi from
  // onWorldCreate in a module-level variable, guard every use of it against
  // "the hook fired before onWorldCreate", and reset that variable in a test
  // seam that existed for no other reason. This is the CONTRACT test: one
  // fixture plugin, asserting the API hooks in favor of the shared behaviour
  // the host owes every plugin, not a per-plugin wiring check.
  // ──────────────────────────────────────────────────────────────────────────

  it('hands onTerrainChanged, onPlayerJoin and onPlayerLeave a working WorldApi', () => {
    let worldCreateApi: WorldApi | undefined;
    const seenApis: WorldApi[] = [];

    const fixture: TerracePlugin = {
      name: 'terrain-and-player-hooks',
      onWorldCreate(world): void {
        worldCreateApi = world;
      },
      onTerrainChanged(world): void {
        seenApis.push(world);
      },
      onPlayerJoin(world): void {
        seenApis.push(world);
      },
      onPlayerLeave(world): void {
        seenApis.push(world);
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    const host = new PluginHost(world, [fixture].map(asLoadedPlugin));
    host.worldCreate();
    if (worldCreateApi === undefined) throw new Error('onWorldCreate was never called');

    // Drives onTerrainChanged through the real edit path (the same one a
    // player's own sculpt takes), rather than calling the host method directly
    // — the contract under test is what a plugin's sculpt actually triggers.
    worldCreateApi.sculpt(4, 4, 1, 64);
    host.playerJoined(PLAYER);
    host.playerLeft(PLAYER);

    expect(seenApis).toHaveLength(3);

    // Every hook gets the SAME per-plugin instance onWorldCreate/onTick/onIntent
    // already receive — not a fresh proxy, not undefined.
    for (const api of seenApis) expect(api).toBe(worldCreateApi);

    // And it is a WORKING WorldApi, not a stub: each one can read the world and
    // reach `sculpt`/`broadcast` without the plugin stashing anything of its
    // own — which is the whole point of the fix.
    for (const api of seenApis) {
      expect(api.worldSize).toBe(WORLD_SIZE);
      api.broadcast('ping', {});
    }
    expect(sink.ofType('terrain-and-player-hooks:ping')).toHaveLength(3);
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

  // ──────────────────────────────────────────────────────────────────────────
  // onIntentApplied — the effect phase of the two-phase intent pipeline
  // (issue #19). PluginHost's own contract is narrow: notifyIntentApplied is a
  // plain fan-out, handing every plugin a working WorldApi, the same shape
  // runIntent (IntentCtx) uses. The GUARANTEE that it only ever gets called
  // after every interceptor allowed lives one layer up, in the pipeline
  // (server/test/intent-pipeline.test.ts covers that end to end) — this suite
  // covers what PluginHost itself owes the call.
  // ──────────────────────────────────────────────────────────────────────────

  it('hands onIntentApplied a working WorldApi and the same player/intent/diff it was given', () => {
    const seen: Array<{ intent: SculptIntent; playerId: string; diffLength: number }> = [];
    const fixture: TerracePlugin = {
      name: 'ledger',
      onIntentApplied(intent, ctx, diff): void {
        seen.push({ intent, playerId: ctx.player.id, diffLength: diff.length });
        // A WORKING api, not a stub — reachable without the plugin stashing
        // anything of its own, exactly like onTerrainChanged's contract.
        ctx.world.broadcast('ping', {});
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    const host = new PluginHost(world, [fixture].map(asLoadedPlugin));

    const intent: SculptIntent = { type: 'sculpt', x: 4, y: 4, radius: 1, dir: 1 };
    const diff: CellDiff[] = [{ x: 4, y: 4, h: 64 }];
    host.notifyIntentApplied(intent, PLAYER, diff);

    expect(seen).toEqual([{ intent, playerId: PLAYER.id, diffLength: 1 }]);
    expect(sink.ofType('ledger:ping')).toHaveLength(1);
  });

  it('runs onIntentApplied for every plugin in load order, and keeps going if one throws', () => {
    const calls: string[] = [];
    const broken: TerracePlugin = {
      name: 'broken',
      onIntentApplied(): void {
        throw new Error('boom');
      },
    };
    const first: TerracePlugin = { name: 'a-first', onIntentApplied: () => calls.push('a') };
    const second: TerracePlugin = { name: 'b-second', onIntentApplied: () => calls.push('b') };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [first, broken, second].map(asLoadedPlugin));

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const intent: SculptIntent = { type: 'sculpt', x: 4, y: 4, radius: 1, dir: 1 };
    expect(() => host.notifyIntentApplied(intent, PLAYER, [])).not.toThrow();
    errors.mockRestore();

    expect(calls).toEqual(['a', 'b']);
  });

  it('does nothing when no plugin implements onIntentApplied', () => {
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [{ name: 'silent' }].map(asLoadedPlugin));
    const intent: SculptIntent = { type: 'sculpt', x: 4, y: 4, radius: 1, dir: 1 };
    expect(() => host.notifyIntentApplied(intent, PLAYER, [])).not.toThrow();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onIntentDenied — the deny-side effect phase (2026-08-19, mana phantom-
  // debit fix). Same narrow contract as notifyIntentApplied: a plain fan-out
  // with a working WorldApi; WHEN it fires (only on interceptor deny or a
  // failed plugin rewrite) is the pipeline's guarantee, covered there.
  // ──────────────────────────────────────────────────────────────────────────

  it('hands onIntentDenied a working WorldApi and the same player/intent it was given', () => {
    const seen: Array<{ intent: SculptIntent; playerId: string }> = [];
    const fixture: TerracePlugin = {
      name: 'reconciler',
      onIntentDenied(intent, ctx): void {
        seen.push({ intent, playerId: ctx.player.id });
        ctx.world.sendTo(ctx.player.id, 'correction', {});
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const sink = new RecordingSink();
    world.setSink(sink);
    const host = new PluginHost(world, [fixture].map(asLoadedPlugin));

    const intent: SculptIntent = { type: 'sculpt', x: 4, y: 4, radius: 1, dir: 1 };
    host.notifyIntentDenied(intent, PLAYER);

    expect(seen).toEqual([{ intent, playerId: PLAYER.id }]);
    expect(sink.ofType('reconciler:correction')).toHaveLength(1);
  });

  it('runs onIntentDenied for every plugin in load order, and keeps going if one throws', () => {
    const calls: string[] = [];
    const broken: TerracePlugin = {
      name: 'broken',
      onIntentDenied(): void {
        throw new Error('boom');
      },
    };
    const first: TerracePlugin = { name: 'a-first', onIntentDenied: () => calls.push('a') };
    const second: TerracePlugin = { name: 'b-second', onIntentDenied: () => calls.push('b') };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [first, broken, second].map(asLoadedPlugin));

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const intent: SculptIntent = { type: 'sculpt', x: 4, y: 4, radius: 1, dir: 1 };
    expect(() => host.notifyIntentDenied(intent, PLAYER)).not.toThrow();
    errors.mockRestore();

    expect(calls).toEqual(['a', 'b']);
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

// ──────────────────────────────────────────────────────────────────────────
// FOG OF WAR (issue #18): CONTRACT tests against a fixture plugin with
// positioned entities, exercised entirely through the real WorldApi/
// PluginHost path — no stub for the fan-out itself. Each migrated real
// plugin (wildlife, monsters, flora, structures) gets its own suite proving
// it calls through this same contract; this file proves the contract itself.
// ──────────────────────────────────────────────────────────────────────────

describe('WorldApi.broadcastVisible (issue #18)', () => {
  const PLAYER_A: Player = { id: 'session-a', token: 'token-a', name: 'A' };
  const PLAYER_B: Player = { id: 'session-b', token: 'token-b', name: 'B' };

  interface PositionedItem {
    readonly id: number;
    readonly x: number;
    readonly y: number;
  }

  function positionOf(item: PositionedItem): { x: number; y: number } {
    return { x: item.x, y: item.y };
  }

  /** Boots a fixture plugin (no positioned behaviour of its own) and hands back its WorldApi. */
  function bootFixture(): { world: World; sink: RecordingSink; api: WorldApi } {
    let api: WorldApi | undefined;
    const fixture: TerracePlugin = {
      name: 'positioned-fixture',
      onWorldCreate(world): void {
        api = world;
      },
    };

    // Nothing pre-unlocked: this suite unlocks exactly the chunks it needs,
    // per token, through the real primitive under test.
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    const sink = new RecordingSink();
    world.setSink(sink);
    world.addPlayer(PLAYER_A);
    world.addPlayer(PLAYER_B);
    new PluginHost(world, [fixture].map(asLoadedPlugin)).worldCreate();

    if (api === undefined) throw new Error('onWorldCreate was never called');
    return { world, sink, api };
  }

  it('sends each connected player only the items visible to their own token', () => {
    const { sink, api } = bootFixture();

    // Chunk (0,0) is cells [0,16)×[0,16) — A earns it, B earns nothing.
    expect(api.unlockChunkForToken(PLAYER_A.token, 0, 0)).toBe(true);

    const item: PositionedItem = { id: 1, x: 4, y: 4 };
    api.broadcastVisible('positions', [item], positionOf, (visible) => ({ items: visible }));

    const messages = sink.ofType('positioned-fixture:positions');
    const forA = messages.find((m) => m.target === PLAYER_A.id);
    const forB = messages.find((m) => m.target === PLAYER_B.id);

    // FULL-STATE semantics (skipEmpty defaults false): BOTH connected
    // players are sent a message, even B, whose subset is empty — that
    // empty send is the disappearance mechanism (see the doc comment on
    // WorldApi.broadcastVisible).
    expect(forA).toBeDefined();
    expect(forB).toBeDefined();
    expect((forA!.payload as { items: PositionedItem[] }).items).toEqual([item]);
    expect((forB!.payload as { items: PositionedItem[] }).items).toEqual([]);
  });

  it('sends the item to a player the instant they creep into its chunk', () => {
    const { sink, api } = bootFixture();
    expect(api.unlockChunkForToken(PLAYER_A.token, 0, 0)).toBe(true);

    const item: PositionedItem = { id: 1, x: 4, y: 4 };
    api.broadcastVisible('positions', [item], positionOf, (visible) => ({ items: visible }));
    expect(
      (sink.ofType('positioned-fixture:positions').find((m) => m.target === PLAYER_B.id)!
        .payload as { items: PositionedItem[] }).items,
    ).toEqual([]);

    // B creeps into the SAME chunk. "On the next cycle" is simply calling
    // broadcastVisible again — it re-reads every player's own mask live, so
    // no separate join-style snapshot path is needed for this to work.
    sink.clear();
    expect(api.unlockChunkForToken(PLAYER_B.token, 0, 0)).toBe(true);
    api.broadcastVisible('positions', [item], positionOf, (visible) => ({ items: visible }));

    const forBAfterCreep = sink
      .ofType('positioned-fixture:positions')
      .find((m) => m.target === PLAYER_B.id);
    expect(forBAfterCreep).toBeDefined();
    expect((forBAfterCreep!.payload as { items: PositionedItem[] }).items).toEqual([item]);
  });

  it('makes an item disappear from a player once it moves out of their visible chunk', () => {
    const { sink, api } = bootFixture();
    expect(api.unlockChunkForToken(PLAYER_A.token, 0, 0)).toBe(true);

    const inside: PositionedItem = { id: 1, x: 4, y: 4 };
    api.broadcastVisible('positions', [inside], positionOf, (visible) => ({ items: visible }));
    expect(
      (sink.ofType('positioned-fixture:positions').find((m) => m.target === PLAYER_A.id)!
        .payload as { items: PositionedItem[] }).items,
    ).toEqual([inside]);

    // The SAME entity moves into chunk (1,0) — cells [16,32)×[0,16) — which
    // A has never unlocked for their own token.
    sink.clear();
    const moved: PositionedItem = { ...inside, x: 20 };
    api.broadcastVisible('positions', [moved], positionOf, (visible) => ({ items: visible }));

    const forAAfterMove = sink
      .ofType('positioned-fixture:positions')
      .find((m) => m.target === PLAYER_A.id);
    // Still sent (full-state, skipEmpty false) — just empty. THIS is the
    // disappearance: a client that replaces its whole list on every message
    // sees the entity vanish because the next list simply omits it.
    expect(forAAfterMove).toBeDefined();
    expect((forAAfterMove!.payload as { items: PositionedItem[] }).items).toEqual([]);
  });

  it('skips a recipient with nothing to say when skipEmpty is set, for a delta-shaped message', () => {
    const { sink, api } = bootFixture();
    expect(api.unlockChunkForToken(PLAYER_A.token, 0, 0)).toBe(true);
    // PLAYER_B earns nothing.

    const item: PositionedItem = { id: 1, x: 4, y: 4 };
    api.broadcastVisible('delta', [item], positionOf, (visible) => ({ items: visible }), {
      skipEmpty: true,
    });

    const messages = sink.ofType('positioned-fixture:delta');
    expect(messages.find((m) => m.target === PLAYER_A.id)).toBeDefined();
    // B's subset is empty and skipEmpty is set: no message at all, not an
    // empty one — the documented, safe choice for additive content.
    expect(messages.find((m) => m.target === PLAYER_B.id)).toBeUndefined();
  });

  it('restricts the fan-out to one player when onlyPlayerId is given', () => {
    const { sink, api } = bootFixture();
    expect(api.unlockChunkForToken(PLAYER_A.token, 0, 0)).toBe(true);
    expect(api.unlockChunkForToken(PLAYER_B.token, 0, 0)).toBe(true);

    const item: PositionedItem = { id: 1, x: 4, y: 4 };
    api.broadcastVisible('snapshot', [item], positionOf, (visible) => ({ items: visible }), {
      onlyPlayerId: PLAYER_A.id,
    });

    const messages = sink.ofType('positioned-fixture:snapshot');
    expect(messages).toHaveLength(1);
    expect(messages[0].target).toBe(PLAYER_A.id);
  });
});

describe('TerracePlugin.onChunkUnlockedForToken (issue #18)', () => {
  it('fires once per real per-token unlock, with the token and chunk coordinates', () => {
    const seen: Array<{ token: string; cx: number; cy: number }> = [];
    const fixture: TerracePlugin = {
      name: 'unlock-watcher',
      onChunkUnlockedForToken(_world, token, cx, cy): void {
        seen.push({ token, cx, cy });
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    world.addPlayer(PLAYER);
    let api: WorldApi | undefined;
    const capture: TerracePlugin = {
      name: 'capture',
      onWorldCreate(w): void {
        api = w;
      },
    };
    const host = new PluginHost(world, [fixture, capture].map(asLoadedPlugin));
    host.worldCreate();
    if (api === undefined) throw new Error('onWorldCreate was never called');

    expect(api.unlockChunkForToken(PLAYER.token, 2, 3)).toBe(true);
    // A repeat unlock of the SAME chunk for the SAME token is a no-op at the
    // World layer (idempotent), and must not re-fire the hook.
    expect(api.unlockChunkForToken(PLAYER.token, 2, 3)).toBe(false);

    expect(seen).toEqual([{ token: PLAYER.token, cx: 2, cy: 3 }]);
  });

  it('does not fire for the world-wide unlockChunk, only the per-token primitive', () => {
    const seen: unknown[] = [];
    const fixture: TerracePlugin = {
      name: 'unlock-watcher',
      onChunkUnlockedForToken(): void {
        seen.push(true);
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    let api: WorldApi | undefined;
    const capture: TerracePlugin = {
      name: 'capture',
      onWorldCreate(w): void {
        api = w;
      },
    };
    new PluginHost(world, [fixture, capture].map(asLoadedPlugin)).worldCreate();
    if (api === undefined) throw new Error('onWorldCreate was never called');

    expect(api.unlockChunk(1, 1)).toBe(true);
    expect(seen).toEqual([]);
  });
});
