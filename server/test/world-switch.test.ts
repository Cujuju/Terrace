// Switching the live world (multi-world, 2026-08-22).
//
// CONTRACT TESTS for WorldManager.openInto's four guarantees, stated at the
// head of world-manager.ts:
//
//   1. the outgoing world is SAVED before it is closed, and a save failure
//      aborts the switch rather than losing the world;
//   2. the swap is all-or-nothing from the caller's point of view;
//   3. nobody is left looking at a world that is no longer loaded — every
//      connected player is carried across and re-snapshotted;
//   4. a failed load leaves NO world loaded, never a half-loaded one.
//
// Plus the one that motivates the whole design: PLUGIN STATE FOLLOWS THE
// WORLD. Server plugins keep their state at module scope, so a switch that
// failed to re-run restorePersistence + worldCreate would leave world B
// holding world A's forests. That is the failure this test suite exists for.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import type { ServerConfig } from '../src/config.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';
import type { LoadedPlugin, TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import type { Player } from '../src/player.ts';
import { WorldManager } from '../src/world/world-manager.ts';
import { RecordingSink, asLoadedPlugin } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const RETENTION = 5;

/**
 * A plugin whose state is a counter it persists — the visible proxy for "does
 * plugin state follow the world". Module-level by construction, exactly like
 * every real plugin (see session.ts's header on why that is the constraint).
 */
let pluginValue = 0;
let worldCreateCalls = 0;

function counterPlugin(): TerracePlugin {
  return {
    name: 'counter',
    onWorldCreate(_api: WorldApi): void {
      worldCreateCalls++;
      // RESETS from the staged slice, which is the contract every real
      // onWorldCreate keeps and the reason a switch can reuse the module.
      pluginValue = staged;
    },
    persistence: {
      save(): unknown {
        return { value: pluginValue };
      },
      load(data: unknown): void {
        staged = (data as { value?: number } | null)?.value ?? 0;
      },
    },
  };
}
let staged = 0;

let root: string;
let registry: WorldRegistry;
let plugins: readonly LoadedPlugin[];
let config: ServerConfig;

function makeConfig(worldsDir: string): ServerConfig {
  return {
    worldSize: WORLD_SIZE,
    port: 0,
    dbPath: join(worldsDir, 'legacy-that-does-not-exist.db'),
    tickHz: 10,
    snapshotIntervalS: 60,
    difficulty: 50,
    pluginsDir: worldsDir,
    clientDistPath: worldsDir,
    snapshotRetention: RETENTION,
    rollbackKey: 'rollback-key-long-enough',
    worldsDir,
    worldAdminKey: 'admin-key-long-enough',
    worldSwitchCountdownS: 0, // immediate switches; the countdown has its own test
  };
}

function makeManager(): WorldManager {
  return new WorldManager({ config, registry, plugins, switchCountdownS: 0 });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terrace-switch-'));
  registry = new WorldRegistry(join(root, 'worlds'));
  config = makeConfig(registry.worldsDir);
  plugins = [asLoadedPlugin(counterPlugin())];
  pluginValue = 0;
  staged = 0;
  worldCreateCalls = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function player(id: string): Player {
  return { id, token: `token-${id}`, name: `Player ${id}` };
}

describe('loading and switching worlds', () => {
  it('creates, loads and reports the live world', () => {
    const manager = makeManager();
    const id = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50);
    expect(id).not.toBeNull();

    expect(manager.requestLoad(id as string)).toEqual({
      mode: 'immediate',
      secondsRemaining: 0,
    });
    expect(manager.activeId).toBe(id);
    expect(manager.current?.world.name).toBe('Frostwick Hollows');
    // The pointer follows the load, so the next boot comes back here.
    expect(registry.readActive()).toBe(id);
  });

  it('refuses to load a world that does not exist, and stays where it is', () => {
    const manager = makeManager();
    const id = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    manager.requestLoad(id);

    expect(manager.requestLoad('no-such-world')).toBe('unknownWorld');
    expect(manager.activeId).toBe(id);
  });

  it('refuses to reload the world it is already in', () => {
    const manager = makeManager();
    const id = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    manager.requestLoad(id);
    expect(manager.requestLoad(id)).toBe('alreadyActive');
  });

  it('SAVES the outgoing world before closing it', () => {
    const manager = makeManager();
    const from = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const to = manager.createWorld('Moonreach', WORLD_SIZE, 50) as string;
    manager.requestLoad(from);

    // Move the world so it is dirty, and count what is on disk right now.
    const before = registry.summaryFor(from, from)?.restorePoints ?? 0;
    manager.current?.world.applySculpt(CHUNK_SIZE, CHUNK_SIZE, 2, 1);
    expect(manager.current?.world.dirty).toBe(true);

    manager.requestLoad(to);

    // The world we left has MORE history than before the switch: the edit was
    // written, not dropped on the floor.
    expect(registry.summaryFor(from, null)?.restorePoints).toBe(before + 1);
  });

  it('carries connected players into the new world and re-snapshots them', () => {
    const manager = makeManager();
    const from = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const to = manager.createWorld('Moonreach', WORLD_SIZE, 50) as string;

    const sink = new RecordingSink();
    const roster = [player('a'), player('b')];
    manager.attachRoom({
      sink,
      clientCount: () => roster.length,
      players: () => roster,
    });

    manager.requestLoad(from);
    sink.clear();
    manager.requestLoad(to);

    // GUARANTEE 3: everybody was handed the world they are now in.
    const snapshots = sink.ofType('snapshot');
    expect(snapshots.map((message) => message.target).sort()).toEqual(['a', 'b']);
    // ...and they are players of the NEW world, not ghosts of the old one.
    expect(manager.current?.world.players().map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('gives a player who joined with NO world loaded a world when one arrives', () => {
    // The roster lives on the room precisely so this case works: with no world
    // loaded there is no World to hold the player, and reading the roster from
    // the outgoing world would strand them.
    const manager = makeManager();
    const id = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;

    const sink = new RecordingSink();
    const roster = [player('lonely')];
    manager.attachRoom({ sink, clientCount: () => 1, players: () => roster });

    expect(manager.activeId).toBeNull();
    manager.requestLoad(id);

    expect(sink.ofType('snapshot').map((m) => m.target)).toEqual(['lonely']);
    expect(manager.current?.world.players().map((p) => p.id)).toEqual(['lonely']);
  });

  it('resets plugin state to the world being loaded', () => {
    // THE REASON THE SESSION EXISTS. Plugin state is module-scoped, so without
    // the restorePersistence + worldCreate replay, world B would inherit
    // world A's counter.
    const manager = makeManager();
    const a = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const b = manager.createWorld('Moonreach', WORLD_SIZE, 50) as string;

    manager.requestLoad(a);
    pluginValue = 42;
    manager.current?.world.applySculpt(CHUNK_SIZE, CHUNK_SIZE, 1, 1);
    manager.snapshotIfDirty(); // 42 reaches world A's file

    manager.requestLoad(b);
    // World B has never seen a counter, so it comes up at zero — NOT 42.
    expect(pluginValue).toBe(0);

    manager.requestLoad(a);
    // ...and world A still has its own.
    expect(pluginValue).toBe(42);
    // Each load replayed the boot pair.
    expect(worldCreateCalls).toBe(3);
  });

  it('leaves NO world loaded when the incoming world cannot be opened', () => {
    // GUARANTEE 4. Half-loaded is the one outcome with no way back, so the
    // manager ends up honestly empty instead.
    const manager = makeManager();
    const good = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    manager.requestLoad(good);

    // A world file with no snapshot in it: openSession refuses it rather than
    // filling it with fresh terrain.
    const emptyId = 'empty-world';
    registry.createStore(emptyId, RETENTION).close();

    expect(manager.requestLoad(emptyId)).toBe('failed');
    expect(manager.current).toBeNull();
    expect(manager.activeId).toBeNull();
  });
});

describe('unloading', () => {
  it('saves, closes, clears the pointer and tells everyone', () => {
    const manager = makeManager();
    const id = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const sink = new RecordingSink();
    manager.attachRoom({ sink, clientCount: () => 1, players: () => [] });
    manager.requestLoad(id);
    sink.clear();

    expect(manager.unload()).toBe(true);
    expect(manager.current).toBeNull();
    expect(registry.readActive()).toBeNull();
    expect(sink.ofType('worldUnloaded')).toHaveLength(1);
    // The world itself is untouched on disk.
    expect(registry.has(id)).toBe(true);
  });

  it('ticks harmlessly with no world loaded', () => {
    const manager = makeManager();
    expect(() => manager.tick(0.1)).not.toThrow();
    expect(manager.snapshotIfDirty()).toBe(false);
  });

  it('leaves the pointer alone on shutdown, so the next boot returns here', () => {
    const manager = makeManager();
    const id = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    manager.requestLoad(id);

    manager.shutdown();

    expect(manager.current).toBeNull();
    expect(registry.readActive()).toBe(id);
  });
});

describe('the switch countdown', () => {
  it('is skipped when the operator is the only client', () => {
    const manager = new WorldManager({ config, registry, plugins, switchCountdownS: 10 });
    const from = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const to = manager.createWorld('Moonreach', WORLD_SIZE, 50) as string;
    const sink = new RecordingSink();
    manager.attachRoom({ sink, clientCount: () => 1, players: () => [] });
    manager.requestLoad(from);

    expect(manager.requestLoad(to)).toEqual({ mode: 'immediate', secondsRemaining: 0 });
    expect(manager.activeId).toBe(to);
  });

  it('announces and waits when somebody else is connected', () => {
    const manager = new WorldManager({ config, registry, plugins, switchCountdownS: 10 });
    const from = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const to = manager.createWorld('Moonreach', WORLD_SIZE, 50) as string;
    const sink = new RecordingSink();
    // The operator loads the first world ALONE (so it is immediate), and a
    // second player is connected by the time they switch — which is exactly
    // the situation the announcement exists for.
    let clients = 1;
    manager.attachRoom({ sink, clientCount: () => clients, players: () => [] });
    manager.requestLoad(from);
    clients = 2;
    sink.clear();

    expect(manager.requestLoad(to)).toEqual({ mode: 'countdown', secondsRemaining: 10 });
    // Still in the old world — the announcement is not the switch.
    expect(manager.activeId).toBe(from);
    const notice = sink.ofType('worldSwitchNotice');
    expect(notice).toHaveLength(1);
    expect(notice[0].payload).toMatchObject({ toId: to, secondsRemaining: 10 });

    // And it can be called off, leaving the world exactly where it was.
    expect(manager.cancelSwitch()).toBe(true);
    expect(manager.activeId).toBe(from);
    expect(sink.ofType('worldSwitchNotice').at(-1)?.payload).toMatchObject({
      cancelled: true,
    });
    expect(manager.pendingSwitch).toBeNull();
  });

  it('refuses a second switch while one is counting down', () => {
    const manager = new WorldManager({ config, registry, plugins, switchCountdownS: 10 });
    const from = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const to = manager.createWorld('Moonreach', WORLD_SIZE, 50) as string;
    const third = manager.createWorld('Galewick Downs', WORLD_SIZE, 50) as string;
    let clients = 1;
    manager.attachRoom({
      sink: new RecordingSink(),
      clientCount: () => clients,
      players: () => [],
    });
    manager.requestLoad(from);
    clients = 2;
    manager.requestLoad(to);

    expect(manager.requestLoad(third)).toBe('switchInProgress');
    manager.cancelSwitch();
  });
});
