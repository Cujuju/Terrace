import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JoinSnapshotMessage } from '@terrace/shared';
import { CHUNK_SIZE } from '@terrace/shared';
import { buildIdentity } from '../src/build-identity.ts';
import type { ServerConfig } from '../src/config.ts';
import type { Player } from '../src/player.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';
import { InstalledPlugins } from '../src/plugins/installed.ts';
import { discoverPlugins } from '../src/plugins/discovery.ts';
import type { SiblingModule, TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import { WorldManager } from '../src/world/world-manager.ts';
import { RecordingSink, asLoadedPlugin } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const RETENTION = 5;
const PLUGIN_DIRECTORY = 'probe';

let seenSibling: SiblingModule | null = null;

function watcherPlugin(): TerracePlugin {
  return {
    name: 'watcher',
    onWorldCreate(api: WorldApi): void {
      seenSibling = api.sibling(PLUGIN_DIRECTORY);
    },
  };
}

interface ProbeSource {
  readonly mark: string;
  readonly messageType: string;
  readonly syntaxError?: boolean;
  readonly throwOnWorldCreate?: boolean;
  readonly refuseLoad?: boolean;
  readonly throwOnTick?: boolean;
}

function writeProbe(pluginsDir: string, source: ProbeSource): void {
  const dir = join(pluginsDir, PLUGIN_DIRECTORY, 'server');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(pluginsDir, PLUGIN_DIRECTORY, 'package.json'),
    JSON.stringify({ name: 'probe', version: '1.0.0' }),
  );
  if (source.syntaxError === true) {
    writeFileSync(join(dir, 'index.ts'), 'export const plugin = {\n');
    return;
  }
  writeFileSync(
    join(dir, 'index.ts'),
    `export const MARK = ${JSON.stringify(source.mark)};
export const plugin = {
  name: ${JSON.stringify(PLUGIN_DIRECTORY)},
  onWorldCreate() {
    ${source.throwOnWorldCreate === true ? "throw new Error('worldCreate refused');" : ''}
  },
  onTick() {
    ${source.throwOnTick === true ? "throw new Error('tick refused');" : ''}
  },
  messages: { ${JSON.stringify(source.messageType)}: () => {} },
  persistence: {
    version: 1,
    save() { return { mark: MARK }; },
    load() { ${source.refuseLoad === true ? "return 'refuse';" : ''} },
  },
};
`,
  );
}

let root: string;
let pluginsDir: string;
let sink: RecordingSink;
let registry: WorldRegistry;
let config: ServerConfig;
let installed: InstalledPlugins;
let manager: WorldManager;

function makeConfig(worldsDir: string): ServerConfig {
  return {
    worldSize: WORLD_SIZE,
    port: 0,
    dbPath: join(worldsDir, 'legacy-that-does-not-exist.db'),
    tickHz: 10,
    snapshotIntervalS: 60,
    difficulty: 50,
    pluginsDir,
    clientDistPath: worldsDir,
    snapshotRetention: RETENTION,
    rollbackKey: 'rollback-key-long-enough',
    worldsDir,
    serverSettingsPath: join(worldsDir, 'server-settings.json'),
    perfLogPath: join(worldsDir, 'perf.log'),
    worldAdminKey: 'admin-key-long-enough',
    worldSwitchCountdownS: 0,
    pluginsEnabled: null,
  };
}

function claims(messageType: string): boolean {
  const host = manager.current?.host;
  return host?.handlerFor(`${PLUGIN_DIRECTORY}:${messageType}`) !== undefined;
}

function markOfLiveSibling(): unknown {
  return (seenSibling as { MARK?: unknown } | null)?.MARK;
}

const ROSTER: readonly Player[] = [
  { id: 'a', token: 'token-a', name: 'Player A' },
  { id: 'b', token: 'token-b', name: 'Player B' },
];

function snapshotIdentities(): ReadonlyArray<readonly [string, string | undefined]> {
  return sink
    .ofType('snapshot')
    .map((message) => [message.target, (message.payload as JoinSnapshotMessage).buildIdentity]);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'terrace-reload-'));
  pluginsDir = join(root, 'plugins');
  writeProbe(pluginsDir, { mark: 'v1', messageType: 'one' });

  registry = new WorldRegistry(join(root, 'worlds'));
  config = makeConfig(registry.worldsDir);
  seenSibling = null;

  installed = new InstalledPlugins([
    ...(await discoverPlugins(pluginsDir)),
    asLoadedPlugin(watcherPlugin()),
  ]);
  manager = new WorldManager({ config, registry, plugins: installed, switchCountdownS: 0 });
  sink = new RecordingSink();
  manager.attachRoom({ sink, clientCount: () => ROSTER.length, players: () => ROSTER });
  const id = manager.createWorld('Reloadfall', WORLD_SIZE, config.difficulty);
  expect(id).not.toBeNull();
  expect(manager.requestLoad(id as string)).toEqual({ mode: 'immediate', secondsRemaining: 0 });

  const live = manager.current;
  expect(live).not.toBeNull();
  live?.world.rename('Reloadfall the Second');
  expect(manager.snapshotIfDirty()).toBe(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('reloading one plugin in place', () => {
  it('replaces the module everywhere on success', async () => {
    const before = manager.installedPluginVersions[PLUGIN_DIRECTORY];
    expect(markOfLiveSibling()).toBe('v1');
    expect(claims('one')).toBe(true);

    writeProbe(pluginsDir, { mark: 'v2', messageType: 'two' });
    const outcome = await manager.reloadPlugin(PLUGIN_DIRECTORY);

    expect(outcome).not.toBe('reloadFailed');
    expect(markOfLiveSibling()).toBe('v2');
    expect(claims('two')).toBe(true);
    expect(claims('one')).toBe(false);
    expect(manager.installedPluginVersions[PLUGIN_DIRECTORY]).not.toBe(before);
  });

  it('keeps the world loaded and its other plugins running', async () => {
    writeProbe(pluginsDir, { mark: 'v2', messageType: 'two' });
    await manager.reloadPlugin(PLUGIN_DIRECTORY);
    expect(manager.current).not.toBeNull();
    expect(manager.installedPluginNames).toEqual(['probe', 'watcher']);
  });

  it('refuses a plugin nobody installed', async () => {
    expect(await manager.reloadPlugin('nothing-of-the-sort')).toBe('unknownPlugin');
  });

  it('refuses with no world loaded', async () => {
    manager.unload();
    expect(await manager.reloadPlugin(PLUGIN_DIRECTORY)).toBe('noWorldLoaded');
  });

  const failures: ReadonlyArray<readonly [string, ProbeSource]> = [
    ['import', { mark: 'v2', messageType: 'two', syntaxError: true }],
    ['onWorldCreate', { mark: 'v2', messageType: 'two', throwOnWorldCreate: true }],
    ['persistence.load', { mark: 'v2', messageType: 'two', refuseLoad: true }],
    ['the probe tick', { mark: 'v2', messageType: 'two', throwOnTick: true }],
  ];

  for (const [step, source] of failures) {
    it(`rolls back to the old module when ${step} fails`, async () => {
      const before = manager.installedPluginVersions[PLUGIN_DIRECTORY];
      writeProbe(pluginsDir, source);

      expect(await manager.reloadPlugin(PLUGIN_DIRECTORY)).toBe('reloadFailed');

      expect(manager.current).not.toBeNull();
      expect(markOfLiveSibling()).toBe('v1');
      expect(claims('one')).toBe(true);
      expect(claims('two')).toBe(false);
      expect(manager.installedPluginVersions[PLUGIN_DIRECTORY]).toBe(before);
    });
  }

  it('tells no client a new identity for a build that fails its probe', async () => {
    const before = buildIdentity();
    writeProbe(pluginsDir, { mark: 'v2', messageType: 'two', throwOnTick: true });
    sink.clear();

    expect(await manager.reloadPlugin(PLUGIN_DIRECTORY)).toBe('reloadFailed');

    for (const [, identity] of snapshotIdentities()) expect(identity).toBe(before);
    expect(buildIdentity()).toBe(before);
  });

  it('tells every client the new identity exactly once when the probe passes', async () => {
    const before = buildIdentity();
    writeProbe(pluginsDir, { mark: 'v2', messageType: 'two' });
    sink.clear();

    expect(await manager.reloadPlugin(PLUGIN_DIRECTORY)).not.toBe('reloadFailed');

    const after = buildIdentity();
    expect(after).not.toBe(before);
    const announced = snapshotIdentities().filter(([, identity]) => identity === after);
    expect(announced.map(([target]) => target).sort()).toEqual(['a', 'b']);
  });

  it('tells every client the world is gone when both opens fail', async () => {
    writeProbe(pluginsDir, { mark: 'v2', messageType: 'two' });
    sink.clear();
    registry.openStore = (): never => {
      throw new Error('store is unopenable');
    };

    expect(await manager.reloadPlugin(PLUGIN_DIRECTORY)).toBe('reloadLeftNoWorld');

    expect(manager.current).toBeNull();
    const unloaded = sink.ofType('worldUnloaded');
    expect(unloaded).toHaveLength(1);
    expect(unloaded[0]?.target).toBe('broadcast');
  });

  it('says nothing about unloading when the rollback succeeds', async () => {
    writeProbe(pluginsDir, { mark: 'v2', messageType: 'two', throwOnTick: true });
    sink.clear();

    expect(await manager.reloadPlugin(PLUGIN_DIRECTORY)).toBe('reloadFailed');

    expect(manager.current).not.toBeNull();
    expect(sink.ofType('worldUnloaded')).toHaveLength(0);
  });
});
