import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK_SIZE } from '@terrace/shared';
import type { CellDiff, SculptIntent } from '@terrace/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORLD_DIFFICULTY,
  MAX_WORLD_DIFFICULTY,
  MIN_WORLD_DIFFICULTY,
} from '../src/config.ts';
import { PluginLoadError, discoverPlugins } from '../src/plugins/discovery.ts';
import { MAX_TERRAIN_CHANGE_DEPTH, PluginHost } from '../src/plugins/host.ts';
import { ALLOW } from '../src/plugins/types.ts';
import type { TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import { namespacedMessageType } from '../src/plugins/world-api.ts';
import type { Player } from '../src/player.ts';
import type { World } from '../src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  grantTokenEveryUnlockedChunk,
  worldWithUnlockedChunks,
} from './support/harness.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const WORLD_SIZE = CHUNK_SIZE * 4;
const PLAYER = { id: 'session-1', token: 'token-1', name: 'Tester' };

describe('discoverPlugins', () => {
  it('loads server halves in deterministic alphabetical directory order', async () => {
    const loaded = await discoverPlugins(join(FIXTURES, 'plugins'));

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

  it('returns nothing when the plugins directory does not exist', async () => {
    expect(await discoverPlugins(join(FIXTURES, 'does-not-exist'))).toEqual([]);
  });

  it('propagates a real I/O error instead of reporting it as "no plugins directory"', async () => {
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

  it('gives plugins a WorldApi whose edits send per-player filtered diffs and whose sends are namespaced', () => {
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
    world.addPlayer(PLAYER);
    grantTokenEveryUnlockedChunk(world, PLAYER.token);
    sink.clear();
    new PluginHost(world, [plugin].map(asLoadedPlugin)).worldCreate();

    expect(api).toBeDefined();
    if (!api) return;

    expect(api.worldSize).toBe(WORLD_SIZE);
    expect(api.isCellUnlocked(0, 0)).toBe(true);
    expect(api.isCellUnlocked(CHUNK_SIZE * 2, CHUNK_SIZE * 2)).toBe(false);

    api.sculpt(4, 4, 1, 64);
    expect(world.heightAt(4, 4)).toBeGreaterThan(0);
    expect(sink.ofType('terrainDiff')).toHaveLength(1);

    expect(api.unlockChunk(1, 1)).toBe(true);
    expect(api.unlockChunk(1, 1)).toBe(false);
    expect(sink.ofType('chunkUnlock')).toHaveLength(1);

    api.broadcast('ready', { ok: true });
    expect(sink.ofType('terraformer:ready')).toHaveLength(1);

    api.sendTo(PLAYER.id, 'private', 1);
    const targeted = sink.ofType('terraformer:private');
    expect(targeted).toHaveLength(1);
    expect(targeted[0].target).toBe(PLAYER.id);
  });

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
    expect(api.unlockChunkForToken(PLAYER.token, 2, 2)).toBe(false);

    expect(api.isChunkVisibleTo(PLAYER.id, 2, 2)).toBe(true);
    expect(api.isCellVisibleTo(PLAYER.id, 2 * CHUNK_SIZE + 1, 2 * CHUNK_SIZE + 1)).toBe(true);
    expect(api.isChunkVisibleTo('no-such-player', 2, 2)).toBe(false);

    const targeted = sink.ofType('chunkUnlock');
    expect(targeted).toHaveLength(1);
    expect(targeted[0].target).toBe(PLAYER.id);
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
    host.notifyTerrainChanged([{ x: 2, y: 2, h: 64 }]);

    expect(seen).toEqual([PLAYER.token, undefined]);
  });

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

    worldCreateApi.sculpt(4, 4, 1, 64);
    host.playerJoined(PLAYER);
    host.playerLeft(PLAYER);

    expect(seenApis).toHaveLength(3);

    for (const api of seenApis) expect(api).toBe(worldCreateApi);

    for (const api of seenApis) {
      expect(api.worldSize).toBe(WORLD_SIZE);
      api.broadcast('ping', {});
    }
    expect(sink.ofType('terrain-and-player-hooks:ping')).toHaveLength(3);
  });

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
    expect(apiForDifficulty().difficulty).toBe(DEFAULT_WORLD_DIFFICULTY);
  });

  it('never hands a plugin a difficulty outside the documented band', () => {
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

    expect(depth).toBe(MAX_TERRAIN_CHANGE_DEPTH);
  });

  const INTENT: SculptIntent = { type: 'sculpt', x: 4, y: 4, radius: 2, dir: 1 };

  it('re-asks every allowing plugin against the effective intent once a later plugin modifies it', () => {
    const judged: number[] = [];
    const judge: TerracePlugin = {
      name: 'a-judge',
      onIntent(intent) {
        judged.push(intent.radius);
        return { kind: 'allow' };
      },
    };
    const widener: TerracePlugin = {
      name: 'b-widener',
      onIntent(intent) {
        return { kind: 'modify', intent: { ...intent, radius: intent.radius + 1 } };
      },
    };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [judge, widener].map(asLoadedPlugin));

    const verdict = host.runIntent(INTENT, PLAYER);

    expect(verdict).toEqual({ kind: 'modify', intent: { ...INTENT, radius: 3 } });
    expect(judged).toEqual([2, 3]);
  });

  it('lets a re-asked plugin deny the effective intent it would have been bound to', () => {
    const affordable = 2;
    const gate: TerracePlugin = {
      name: 'a-gate',
      onIntent(intent) {
        return intent.radius > affordable ? { kind: 'deny', reason: 'too-big' } : { kind: 'allow' };
      },
    };
    const widener: TerracePlugin = {
      name: 'b-widener',
      onIntent(intent) {
        return { kind: 'modify', intent: { ...intent, radius: intent.radius + 1 } };
      },
    };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [gate, widener].map(asLoadedPlugin));

    expect(host.runIntent(INTENT, PLAYER)).toEqual({ kind: 'deny', reason: 'too-big' });
  });

  it('never re-runs a modifier, so an unconditional widener is applied exactly once', () => {
    let widenerCalls = 0;
    const widener: TerracePlugin = {
      name: 'a-widener',
      onIntent(intent) {
        widenerCalls += 1;
        return { kind: 'modify', intent: { ...intent, radius: intent.radius + 1 } };
      },
    };
    const bystander: TerracePlugin = { name: 'b-bystander', onIntent: () => undefined };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [widener, bystander].map(asLoadedPlugin));

    const verdict = host.runIntent(INTENT, PLAYER);

    expect(verdict).toEqual({ kind: 'modify', intent: { ...INTENT, radius: 3 } });
    expect(widenerCalls).toBe(1);
  });

  it('asks each plugin exactly once when nothing modifies the intent', () => {
    const calls: string[] = [];
    const first: TerracePlugin = { name: 'a-first', onIntent: () => void calls.push('a') };
    const second: TerracePlugin = { name: 'b-second', onIntent: () => (calls.push('b'), ALLOW) };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [first, second].map(asLoadedPlugin));

    expect(host.runIntent(INTENT, PLAYER)).toEqual({ kind: 'allow' });
    expect(calls).toEqual(['a', 'b']);
  });

  it('treats a modify returned on the second look as a deny, and records it as a fault', () => {
    const flipFlop: TerracePlugin = {
      name: 'a-flipflop',
      onIntent(intent) {
        return intent.radius === 2 ? { kind: 'allow' } : { kind: 'modify', intent: { ...intent, radius: 1 } };
      },
    };
    const widener: TerracePlugin = {
      name: 'b-widener',
      onIntent(intent) {
        return { kind: 'modify', intent: { ...intent, radius: intent.radius + 1 } };
      },
    };
    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [flipFlop, widener].map(asLoadedPlugin));

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verdict = host.runIntent(INTENT, PLAYER);
    errors.mockRestore();

    expect(verdict.kind).toBe('deny');
    expect(host.faultCount('a-flipflop')).toBe(1);
  });

  it('hands onIntentApplied a working WorldApi and the same player/intent/diff it was given', () => {
    const seen: Array<{ intent: SculptIntent; playerId: string; diffLength: number }> = [];
    const fixture: TerracePlugin = {
      name: 'ledger',
      onIntentApplied(intent, ctx, diff): void {
        seen.push({ intent, playerId: ctx.player.id, diffLength: diff.length });
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
        version: 1,
        save: () => ({ n: 1 }),
        load: (data) => {
          loaded.push(data);
        },
      },
    };

    const world = worldWithUnlockedChunks(WORLD_SIZE, [[0, 0]]);
    const host = new PluginHost(world, [plugin].map(asLoadedPlugin));

    expect(() =>
      host.restorePersistence({ kept: { n: 5 }, removed: { whatever: true } }),
    ).not.toThrow();
    expect(loaded).toEqual([{ n: 5 }]);
    expect(host.collectPersistence()).toEqual({ kept: { v: 1, data: { n: 1 } } });
  });
});

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

  function bootFixture(): { world: World; sink: RecordingSink; api: WorldApi } {
    let api: WorldApi | undefined;
    const fixture: TerracePlugin = {
      name: 'positioned-fixture',
      onWorldCreate(world): void {
        api = world;
      },
    };

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

    expect(api.unlockChunkForToken(PLAYER_A.token, 0, 0)).toBe(true);

    const item: PositionedItem = { id: 1, x: 4, y: 4 };
    api.broadcastVisible('positions', [item], positionOf, (visible) => ({ items: visible }));

    const messages = sink.ofType('positioned-fixture:positions');
    const forA = messages.find((m) => m.target === PLAYER_A.id);
    const forB = messages.find((m) => m.target === PLAYER_B.id);

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

    sink.clear();
    const moved: PositionedItem = { ...inside, x: CHUNK_SIZE + 4 };
    api.broadcastVisible('positions', [moved], positionOf, (visible) => ({ items: visible }));

    const forAAfterMove = sink
      .ofType('positioned-fixture:positions')
      .find((m) => m.target === PLAYER_A.id);
    expect(forAAfterMove).toBeDefined();
    expect((forAAfterMove!.payload as { items: PositionedItem[] }).items).toEqual([]);
  });

  it('skips a recipient with nothing to say when skipEmpty is set, for a delta-shaped message', () => {
    const { sink, api } = bootFixture();
    expect(api.unlockChunkForToken(PLAYER_A.token, 0, 0)).toBe(true);

    const item: PositionedItem = { id: 1, x: 4, y: 4 };
    api.broadcastVisible('delta', [item], positionOf, (visible) => ({ items: visible }), {
      skipEmpty: true,
    });

    const messages = sink.ofType('positioned-fixture:delta');
    expect(messages.find((m) => m.target === PLAYER_A.id)).toBeDefined();
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
