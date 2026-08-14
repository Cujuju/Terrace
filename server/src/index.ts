// Boot sequence for one Terrace world (design §3.2: one world per process, no
// lobby layer — one deployment = one world).
//
//   config → plugins → database → world (restored or fresh) → plugin host
//          → tick loop → snapshot scheduler → Colyseus server
//
// Shutdown is the reverse, driven by Colyseus's own SIGINT/SIGTERM handling
// (verified in @colyseus/core 0.17.50: `gracefullyShutdown` defaults to true and
// registers the signal handlers, then awaits onBeforeShutdown → matchmaker
// shutdown → transport close → onShutdown). We hook that instead of installing
// competing handlers, so there is exactly one shutdown path.

import { Server } from 'colyseus';
import { loadConfig, ConfigError, type ServerConfig } from './config.ts';
import { logError, logInfo } from './log.ts';
import { SnapshotStore } from './persistence/snapshot-store.ts';
import { discoverPlugins } from './plugins/discovery.ts';
import { PluginHost } from './plugins/host.ts';
import { startTickLoop } from './tick.ts';
import { ROOM_NAME, TerraceRoom, bindRoomContext } from './net/terrace-room.ts';
import { World } from './world/world.ts';

const MILLISECONDS_PER_SECOND = 1000;

/** Loads the newest snapshot into a World, or creates a fresh one. */
function openWorld(config: ServerConfig, store: SnapshotStore): {
  world: World;
  pluginSlices: Record<string, unknown>;
} {
  const snapshot = store.loadLatest();
  if (snapshot === null) {
    logInfo(`no snapshot found — creating a fresh ${config.worldSize}² world`);
    return { world: World.createFresh(config.worldSize), pluginSlices: {} };
  }

  // Changing WORLD_SIZE against an existing database is undefined (see
  // .env.example): every stored index would shift. Refuse rather than silently
  // reinterpret a self-hoster's world.
  if (snapshot.worldSize !== config.worldSize) {
    throw new ConfigError(
      `WORLD_SIZE is ${config.worldSize} but the database holds a ${snapshot.worldSize}² world; ` +
        'point DB_PATH at a new file or restore the previous WORLD_SIZE',
    );
  }

  const age = Math.round((Date.now() - snapshot.createdAt) / MILLISECONDS_PER_SECOND);
  logInfo(`restoring snapshot #${snapshot.id} (${snapshot.worldSize}², ${age}s old)`);
  return {
    world: World.restore(config.worldSize, snapshot.cells, snapshot.mask),
    pluginSlices: snapshot.pluginSlices,
  };
}

/** Writes a snapshot if anything changed. Returns true when one was written. */
function snapshotIfDirty(world: World, host: PluginHost, store: SnapshotStore): boolean {
  if (!world.dirty) return false;
  store.saveSnapshot({
    worldSize: world.size,
    cells: world.map.cells,
    mask: world.mask,
    pluginSlices: host.collectPersistence(),
  });
  world.markSnapshotted();
  return true;
}

async function main(): Promise<void> {
  const config = loadConfig();
  logInfo(
    `starting: world=${config.worldSize}² port=${config.port} tick=${config.tickHz}Hz ` +
      `snapshot=${config.snapshotIntervalS}s db=${config.dbPath}`,
  );

  // Plugins load before the world so a load failure costs nothing but a boot.
  const plugins = await discoverPlugins(config.pluginsDir);

  const store = SnapshotStore.open(config.dbPath);
  const { world, pluginSlices } = openWorld(config, store);

  const host = new PluginHost(world, plugins);
  // Restore first, then announce: onWorldCreate must see a world whose plugin
  // state is already the state it had when the process died.
  host.restorePersistence(pluginSlices);
  host.worldCreate();

  const tickLoop = startTickLoop(config.tickHz, (dt) => host.tick(dt));

  // Cadence half of the snapshot decision: every SNAPSHOT_INTERVAL_S, but only
  // if the world changed — an idle server writes nothing at all.
  const snapshotTimer = setInterval(() => {
    try {
      if (snapshotIfDirty(world, host, store)) logInfo('world snapshot written');
    } catch (error) {
      // A failed periodic snapshot must not kill a live world; the next tick
      // retries, and the world stays dirty until one succeeds.
      logError('periodic snapshot failed', error);
    }
  }, config.snapshotIntervalS * MILLISECONDS_PER_SECOND);

  // Bind before define(): a room can be created as soon as the server listens.
  bindRoomContext({ world, host });
  const gameServer = new Server();
  gameServer.define(ROOM_NAME, TerraceRoom);

  gameServer.onBeforeShutdown(() => {
    // Stop simulating first so the final snapshot is a quiescent world, then
    // write it — this is the "snapshot on clean shutdown" half of the decision.
    tickLoop.stop();
    clearInterval(snapshotTimer);
    try {
      logInfo(snapshotIfDirty(world, host, store) ? 'shutdown snapshot written' : 'nothing to snapshot');
    } catch (error) {
      logError('shutdown snapshot failed', error);
    }
  });

  gameServer.onShutdown(() => {
    store.close();
    logInfo('shutdown complete');
  });

  await gameServer.listen(config.port);
  logInfo(`listening on ws://0.0.0.0:${config.port} (room "${ROOM_NAME}")`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Configuration mistakes are the self-hoster's most likely failure; print
    // the message alone, without a stack trace they cannot act on.
    logError(error.message);
  } else {
    logError('failed to start', error);
  }
  process.exitCode = 1;
});
