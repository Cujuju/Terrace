// IN-PROCESS SINGLE-PLUGIN RELOAD (Option B, issue #198).
//
// CONTRACT TESTS for the one promise the reload makes: EITHER the new module
// is running everywhere, OR the old one still is — never a mixture, and never
// a world left down.
//
// The four steps a reload can fail at are each exercised, because each one
// fails differently and only the first is an exception the caller ever sees:
//
//   1. import          — a syntax error; the import itself rejects;
//   2. onWorldCreate   — a throw the host SWALLOWS (PluginHost.safely), so the
//                        world comes up looking fine with a broken plugin in it;
//   3. persistence.load — a refusal, which parks the slice rather than throwing;
//   4. the probe tick  — a throw on the first real step, also swallowed.
//
// Steps 2 and 4 are the reason the host counts faults at all: without a count
// there is nothing for the reload to look at, and "it did not throw" would be
// read as "it works".
//
// The plugin under test is written to a REAL directory and imported for real,
// because a re-import that resolves to a cached module is precisely the bug the
// generation-tagged loader hook exists to prevent — a stubbed importer would
// pass whether or not the hook works.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import type { ServerConfig } from '../src/config.ts';
import { WorldRegistry } from '../src/persistence/world-registry.ts';
import { InstalledPlugins } from '../src/plugins/installed.ts';
import { discoverPlugins } from '../src/plugins/discovery.ts';
import type { SiblingModule, TerracePlugin, WorldApi } from '../src/plugins/types.ts';
import { WorldManager } from '../src/world/world-manager.ts';
import { asLoadedPlugin } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const RETENTION = 5;
const PLUGIN_DIRECTORY = 'probe';

/** What the watcher plugin last got back from `WorldApi.sibling('probe')`. */
let seenSibling: SiblingModule | null = null;

/**
 * A second installed plugin whose only job is to ask for the sibling module
 * (issue #196's lookup) every time a world is built — the observable that says
 * which build of `probe` the rest of the process is talking to.
 */
function watcherPlugin(): TerracePlugin {
  return {
    name: 'watcher',
    onWorldCreate(api: WorldApi): void {
      seenSibling = api.sibling(PLUGIN_DIRECTORY);
    },
  };
}

/** Options for the probe plugin's generated source; each names one failure. */
interface ProbeSource {
  /** Value of its `MARK` export — how a test tells one build from the next. */
  readonly mark: string;
  /** Message type it claims, so `handlerFor` has something to see change. */
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
    worldAdminKey: 'admin-key-long-enough',
    worldSwitchCountdownS: 0,
  };
}

/** The live host's answer for one message type — the routing observable. */
function claims(messageType: string): boolean {
  const host = manager.current?.host;
  return host?.handlerFor(`${PLUGIN_DIRECTORY}:${messageType}`) !== undefined;
}

function markOfLiveSibling(): unknown {
  return (seenSibling as { MARK?: unknown } | null)?.MARK;
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
  const id = manager.createWorld('Reloadfall', WORLD_SIZE, config.difficulty);
  expect(id).not.toBeNull();
  expect(manager.requestLoad(id as string)).toEqual({ mode: 'immediate', secondsRemaining: 0 });

  // A SNAPSHOT WITH THE PROBE'S SLICE IN IT, so a reload actually reaches
  // persistence.load: `restorePersistence` skips a plugin the snapshot holds no
  // slice for, and a genesis world holds none for anybody. The unlock is only
  // there to make the world dirty enough to be worth writing.
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
    // The sibling lookup (Phase 2) hands out the NEW namespace...
    expect(markOfLiveSibling()).toBe('v2');
    // ...message routing (Phase 3) sees the NEW handler set...
    expect(claims('two')).toBe(true);
    expect(claims('one')).toBe(false);
    // ...and the stamp moved, which is what makes a client reload itself.
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

  // ONE CASE PER FAILING STEP: each must leave the OLD module running, with the
  // old stamp, in a world that is still up.
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
});
