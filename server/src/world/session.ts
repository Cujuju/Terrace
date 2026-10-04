import { logError, logInfo, logWarn } from '../log.ts';
import type { ServerConfig } from '../config.ts';
import type { SnapshotStore } from '../persistence/snapshot-store.ts';
import { buildThumbnail } from '../persistence/thumbnail.ts';
import type { WorldRegistry } from '../persistence/world-registry.ts';
import { PluginHost } from '../plugins/host.ts';
import type { InstalledPlugins } from '../plugins/installed.ts';
import { resolveDeclaredSettings } from '../plugins/settings.ts';
import type { LoadedPlugin } from '../plugins/types.ts';
import { archFixtureRequested, carveArchFixture } from './arch-fixture.ts';
import { drawGenesisSeed } from './genesis.ts';
import { generateFreshGenesisCellsOffThread } from './genesis-thread.ts';
import { RollbackService } from './rollback.ts';
import { World } from './world.ts';

const MILLISECONDS_PER_SECOND = 1000;

export interface WorldSession {
  readonly id: string;
  readonly store: SnapshotStore;
  readonly world: World;
  readonly host: PluginHost;
  readonly rollback: RollbackService;
}

export interface SessionDeps {
  readonly config: ServerConfig;
  readonly registry: WorldRegistry;
  readonly plugins: InstalledPlugins;
}

export interface SnapshotOptions {
  readonly defer?: boolean;
}

export function snapshotIfDirty(session: WorldSession, options?: SnapshotOptions): boolean {
  const { world, host, store } = session;
  const blocking = options?.defer !== true;
  // A blocking save also covers background saves whose outcome is still unknown.
  if (!world.dirty && !(blocking && world.hasUnconfirmedSnapshot)) return false;
  const input = {
    worldSize: world.size,
    name: world.name,
    cells: world.heightsForPersistence(),
    columnSpans: world.spansForPersistence(),
    mask: world.mask,
    pluginSlices: host.collectPersistence(),
    tokenMasks: world.tokenMasks(),
    simMillis: world.simMillis,
    genesisMillis: world.genesisMillis,
  };
  if (!blocking) {
    // Queued first: the store settles synchronously when it falls back to an inline write.
    world.markSnapshotQueued();
    let settled = false;
    try {
      store.saveSnapshotDeferred(input, (error) => {
        settled = true;
        world.markSnapshotSettled(error === null);
        if (error !== null) logError(`snapshot of world "${session.id}" failed to write: ${error}`);
      });
    } catch (error) {
      if (!settled) world.markSnapshotSettled(false);
      throw error;
    }
    return true;
  }
  store.saveSnapshot({
    ...input,
    thumbnail: buildThumbnail(world.map.cells, world.size),
  });
  world.markSnapshotted();
  return true;
}

function enabledPluginNames(
  store: SnapshotStore,
  plugins: readonly LoadedPlugin[],
  pluginsEnabled: ReadonlySet<string> | null,
): ReadonlySet<string> {
  const installed = plugins.map((loaded) => loaded.plugin.name);
  if (pluginsEnabled !== null) {
    for (const name of pluginsEnabled) {
      if (!installed.includes(name)) logWarn(`PLUGINS_ENABLED names "${name}", which is not installed`);
    }
    return new Set(installed.filter((name) => pluginsEnabled.has(name)));
  }
  const disabled = new Set(store.disabledPlugins());
  return new Set(installed.filter((name) => !disabled.has(name)));
}

function pluginSettingsByPlugin(
  store: SnapshotStore,
  plugins: readonly LoadedPlugin[],
): Record<string, Record<string, string>> {
  const grouped: Record<string, Record<string, string>> = {};
  for (const row of store.pluginSettings()) {
    (grouped[row.plugin] ??= {})[row.key] = row.value;
  }
  for (const { plugin } of plugins) {
    if (!Object.hasOwn(grouped, plugin.name)) continue;
    const stored = grouped[plugin.name]!;
    grouped[plugin.name] = resolveDeclaredSettings(plugin.settings ?? [], stored);
  }
  return grouped;
}

export function openSession(deps: SessionDeps, id: string): WorldSession {
  const { config, registry } = deps;
  const plugins = deps.plugins.list;
  const store = registry.openStore(id, config.snapshotRetention);

  let world: World;
  let pluginSlices: Record<string, unknown>;
  try {
    const snapshot = store.loadLatest();
    if (snapshot === null) {
      throw new Error(
        `world "${id}" has a database but no snapshot in it; refusing to replace it ` +
          'with fresh terrain',
      );
    }

    const age = Math.round((Date.now() - snapshot.createdAt) / MILLISECONDS_PER_SECOND);
    logInfo(
      `loading world "${id}": snapshot #${snapshot.id} (${snapshot.worldSize}², ${age}s old)`,
    );

    world = World.restore(
      snapshot.worldSize,
      snapshot.cells,
      snapshot.mask,
      config.difficulty,
      snapshot.name,
      snapshot.tokenMasks,
      snapshot.simMillis,
      snapshot.genesisMillis,
      snapshot.columnSpans,
    );
    world.anchorClockToRealTime();
    pluginSlices = snapshot.pluginSlices;
  } catch (error) {
    store.close();
    throw error;
  }

  const host = new PluginHost(
    world,
    plugins,
    enabledPluginNames(store, plugins, config.pluginsEnabled),
    pluginSettingsByPlugin(store, plugins),
  );
  host.restorePersistence(pluginSlices);
  host.worldCreate();

  const rollback = new RollbackService({
    world,
    host,
    store,
    key: config.rollbackKey,
    retention: config.snapshotRetention,
    intervalS: config.snapshotIntervalS,
  });

  return { id, store, world, host, rollback };
}

export function closeSession(session: WorldSession): boolean {
  let saved = false;
  try {
    saved = snapshotIfDirty(session);
  } finally {
    releaseSession(session);
  }
  return saved;
}

export function releaseSession(session: WorldSession): void {
  try {
    session.store.close();
  } finally {
    session.host.closeWorld();
    session.host.revokeApis();
  }
}

export function createWorldFile(
  deps: SessionDeps,
  id: string,
  name: string,
  worldSize: number,
  difficulty: number,
): void {
  const store = deps.registry.createStore(id, deps.config.snapshotRetention);
  try {
    saveFreshWorld(store, id, World.createFresh(worldSize, difficulty, name));
  } finally {
    store.close();
  }
}

/** As `createWorldFile`, with genesis on a worker thread. The store exists first, so the id is taken. */
export async function createWorldFileInBackground(
  deps: SessionDeps,
  id: string,
  name: string,
  worldSize: number,
  difficulty: number,
): Promise<void> {
  const store = deps.registry.createStore(id, deps.config.snapshotRetention);
  try {
    const cells = await generateFreshGenesisCellsOffThread(worldSize, drawGenesisSeed());
    saveFreshWorld(store, id, World.fromGenesis(cells, worldSize, difficulty, name));
  } finally {
    store.close();
  }
}

function saveFreshWorld(store: SnapshotStore, id: string, world: World): void {
  if (archFixtureRequested()) {
    const layered = carveArchFixture(world.map);
    logInfo(
      `arch fixture: carved into world "${id}" — ${layered} layered column(s)` +
        (layered === 0 ? ' (nothing opened under the mound; this is a bug)' : ''),
    );
  }
  world.anchorClockToRealTime();
  store.saveSnapshot({
    worldSize: world.size,
    name: world.name,
    cells: world.heightsForPersistence(),
    columnSpans: world.spansForPersistence(),
    mask: world.mask,
    pluginSlices: {},
    tokenMasks: world.tokenMasks(),
    simMillis: world.simMillis,
    genesisMillis: world.genesisMillis,
    thumbnail: buildThumbnail(world.map.cells, world.size),
  });
  logInfo(`created world "${id}" ("${world.name}", ${world.size}²)`);
}
