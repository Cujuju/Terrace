import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import type { ServerConfig } from '../src/config.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';
import type { LoadedPlugin, TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import type { Player } from '../src/player.ts';
import { InstalledPlugins } from '../src/plugins/installed.ts';
import { WorldManager } from '../src/world/world-manager.ts';
import { RecordingSink, asLoadedPlugin } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const RETENTION = 5;

let pluginValue = 0;
let worldCreateCalls = 0;

function counterPlugin(): TerracePlugin {
  return {
    name: 'counter',
    onWorldCreate(_api: WorldApi): void {
      worldCreateCalls++;
      pluginValue = staged;
    },
    persistence: {
      version: 1,
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
let plugins: InstalledPlugins;
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
    serverSettingsPath: join(worldsDir, 'server-settings.json'),
    worldAdminKey: 'admin-key-long-enough',
    worldSwitchCountdownS: 0,
    pluginsEnabled: null,
  };
}

function makeManager(): WorldManager {
  return new WorldManager({ config, registry, plugins, switchCountdownS: 0 });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'terrace-switch-'));
  registry = new WorldRegistry(join(root, 'worlds'));
  config = makeConfig(registry.worldsDir);
  plugins = new InstalledPlugins([asLoadedPlugin(counterPlugin())]);
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

    const before = registry.summaryFor(from, from)?.restorePoints ?? 0;
    manager.current?.world.applySculpt(CHUNK_SIZE, CHUNK_SIZE, 2, 1);
    expect(manager.current?.world.dirty).toBe(true);

    manager.requestLoad(to);

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

    const snapshots = sink.ofType('snapshot');
    expect(snapshots.map((message) => message.target).sort()).toEqual(['a', 'b']);
    expect(manager.current?.world.players().map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('gives a player who joined with NO world loaded a world when one arrives', () => {
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
    const manager = makeManager();
    const a = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    const b = manager.createWorld('Moonreach', WORLD_SIZE, 50) as string;

    manager.requestLoad(a);
    pluginValue = 42;
    manager.current?.world.applySculpt(CHUNK_SIZE, CHUNK_SIZE, 1, 1);
    manager.snapshotIfDirty();

    manager.requestLoad(b);
    expect(pluginValue).toBe(0);

    manager.requestLoad(a);
    expect(pluginValue).toBe(42);
    expect(worldCreateCalls).toBe(3);
  });

  it('leaves NO world loaded when the incoming world cannot be opened', () => {
    const manager = makeManager();
    const good = manager.createWorld('Frostwick Hollows', WORLD_SIZE, 50) as string;
    manager.requestLoad(good);

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
    let clients = 1;
    manager.attachRoom({ sink, clientCount: () => clients, players: () => [] });
    manager.requestLoad(from);
    clients = 2;
    sink.clear();

    expect(manager.requestLoad(to)).toEqual({ mode: 'countdown', secondsRemaining: 10 });
    expect(manager.activeId).toBe(from);
    const notice = sink.ofType('worldSwitchNotice');
    expect(notice).toHaveLength(1);
    expect(notice[0].payload).toMatchObject({ toId: to, secondsRemaining: 10 });

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
