// One world live per process, many on disk. Everything downstream holds the
// WorldManager, never a world. Shutdown rides Colyseus's own signal handling:
// never add competing SIGINT/SIGTERM handlers.

import './quiet-boot.ts'; // must precede any Colyseus import — see that file's comment
// Side effect, and must precede the imports below or their load-time lines
// go out unstamped.
import './log-timestamps.ts';
import { Server, type ServerOptions } from '@colyseus/core';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadConfig,
  ConfigError,
  DEFAULT_ROLLBACK_KEY,
  DEFAULT_WORLD_ADMIN_KEY,
  type ServerConfig,
} from './config.ts';
import { initBuildIdentity } from './build-identity.ts';
import { logError, logInfo, logWarn } from './log.ts';
import { openWorlds } from './boot/open-worlds.ts';
import { WorldRegistry } from './persistence/world-registry.ts';
import { discoverPlugins } from './plugins/discovery.ts';
import { InstalledPlugins } from './plugins/installed.ts';
import { ServerRestartService, TERRACE_RESTART_EXIT_CODE } from './restart.ts';
import { createStaticFileHandler } from './static/serve-client.ts';
import { startTickLoop } from './tick.ts';
import { ROOM_NAME, TerraceRoom, bindRoomContext } from './net/terrace-room.ts';
import { WorldAdminService } from './world/world-admin.ts';
import { WorldManager } from './world/world-manager.ts';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Serves a built client on the game port (#20). Uses Colyseus's express hook
 * without express as a dependency — see static/serve-client.ts.
 */
async function clientStaticExpressHook(
  config: ServerConfig,
): Promise<ServerOptions['express'] | undefined> {
  const indexPath = join(config.clientDistPath, 'index.html');
  const built = await stat(indexPath)
    .then((stats) => stats.isFile())
    .catch(() => false);

  if (!built) {
    logInfo(
      `client is unbuilt (no ${indexPath}) — Vite ('pnpm --dir client dev') remains the dev path`,
    );
    return undefined;
  }

  logInfo(`serving built client from ${config.clientDistPath}`);
  const handleStaticRequest = createStaticFileHandler(config.clientDistPath);
  return (app) => {
    app.use(handleStaticRequest);
  };
}

/** Built-in defaults are printed on purpose; a key the operator chose never is. */
function logOperatorKeys(config: ServerConfig): void {
  if (config.rollbackKey === null) {
    logWarn(
      'world rollback is UNKEYED (ROLLBACK_KEY is set to nothing): anyone who can reach ' +
        'this server can roll the world back without presenting anything. Set ROLLBACK_KEY ' +
        'to your own value to put the gate back.',
    );
  } else if (config.rollbackKey === DEFAULT_ROLLBACK_KEY) {
    logInfo(`world rollback is enabled (${config.snapshotRetention} restore points kept)`);
    logWarn(
      `world rollback is using the built-in key "${DEFAULT_ROLLBACK_KEY}", which is public. ` +
        'Anyone who can reach this server can roll the world back. Set ROLLBACK_KEY to your ' +
        'own value. ROLLBACK_KEY= (empty) does NOT turn rollback off any more — it removes ' +
        'the key requirement entirely.',
    );
  } else {
    logInfo(
      `world rollback is enabled with your own key (${config.snapshotRetention} restore points kept)`,
    );
  }

  if (config.worldAdminKey === null) {
    logWarn(
      'world management is UNKEYED (WORLD_ADMIN_KEY is set to nothing): anyone who can ' +
        'reach this server can create, load and archive worlds, restart the server, and ' +
        'view the whole map. Set WORLD_ADMIN_KEY to your own value to put the gate back.',
    );
  } else if (config.worldAdminKey === DEFAULT_WORLD_ADMIN_KEY) {
    logInfo('world management is enabled');
    logWarn(
      `world management is using the built-in key "${DEFAULT_WORLD_ADMIN_KEY}", which is ` +
        'public. Anyone who can reach this server can create, load and archive worlds. Set ' +
        'WORLD_ADMIN_KEY to your own value. WORLD_ADMIN_KEY= (empty) does NOT turn it off any ' +
        'more — it removes the key requirement entirely.',
    );
  } else {
    logInfo('world management is enabled with your own key');
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  // `newWorlds=`: WORLD_SIZE sizes worlds at CREATION. A loaded world keeps its own.
  logInfo(
    `starting: newWorlds=${config.worldSize}² difficulty=${config.difficulty} ` +
      `port=${config.port} tick=${config.tickHz}Hz snapshot=${config.snapshotIntervalS}s ` +
      `worlds=${config.worldsDir}`,
  );

  // Before any world, so a load failure costs only a boot. An object, not an
  // array, because a reload replaces one plugin in place (#198).
  const plugins = new InstalledPlugins(await discoverPlugins(config.pluginsDir));

  // Before any world opens: a join snapshot carries it.
  const identity = initBuildIdentity({ plugins: plugins.list, clientDistPath: config.clientDistPath });
  logInfo(`build identity ${identity} (core, plugins and the served client bundle)`);

  const registry = new WorldRegistry(config.worldsDir);
  const manager = new WorldManager({
    config,
    registry,
    plugins,
    switchCountdownS: config.worldSwitchCountdownS,
  });

  // A missing world never becomes a fresh one — see boot/open-worlds.ts.
  const outcome = openWorlds(config, registry, manager);
  const session = manager.current;
  if (session === null) {
    logWarn(
      'no world is loaded. The server is running and world management is available; ' +
        'load or create a world from the panel.',
    );
  } else {
    logInfo(`world is "${session.world.name}" (${outcome.loadedId})`);
  }

  // Built before the server it shuts down, because admin needs it. The thunk
  // breaks the cycle: no connection, and so no restart, can exist before listen.
  let gameServer: Server | null = null;
  const restart = new ServerRestartService({
    shutdown: async () => {
      if (gameServer === null) {
        throw new Error('restart requested before the server was listening');
      }
      // `false` is mandatory — see server/src/restart.ts's header.
      await gameServer.gracefullyShutdown(false);
    },
    exit: (code) => {
      process.exit(code);
    },
    countdownS: config.worldSwitchCountdownS,
    defer: (run) => {
      setImmediate(run);
    },
  });

  const admin = new WorldAdminService({ manager, registry, config, restart });
  logOperatorKeys(config);

  // Boot can already have changed the world (a restored world just named, a
  // plugin's onWorldCreate). Without this, a crash inside the first minute
  // silently re-names it on the next boot.
  try {
    if (manager.snapshotIfDirty()) logInfo('boot snapshot written');
  } catch (error) {
    // A failed write must not stop a world opening; it stays dirty and retries.
    logError('boot snapshot failed', error);
  }

  // The PROCESS's loop, not a world's: it ticks across a switch and across
  // having no world, so changing worlds tears nothing down.
  const tickLoop = startTickLoop(config.tickHz, (dt) => manager.tick(dt));

  const snapshotTimer = setInterval(() => {
    try {
      // Deferred: only this one. Every other caller needs the row on disk
      // before its next step (#273).
      if (manager.snapshotIfDirty({ defer: true })) logInfo('world snapshot handed to writer');
    } catch (error) {
      logError('periodic snapshot failed', error);
    }
  }, config.snapshotIntervalS * MILLISECONDS_PER_SECOND);

  // Before define(): a room can exist as soon as the server listens. No plugin
  // message types here — the room routes each one through the live host (#197).
  bindRoomContext({ manager, admin, restart });
  // greet: suppresses Colyseus's boot banner.
  const serverOptions: ServerOptions = { greet: false };
  const clientExpressHook = await clientStaticExpressHook(config);
  if (clientExpressHook !== undefined) {
    serverOptions.express = clientExpressHook;
  }
  gameServer = new Server(serverOptions);
  gameServer.define(ROOM_NAME, TerraceRoom);

  gameServer.onBeforeShutdown(() => {
    // Stop simulating first, so the final snapshot is a quiescent world.
    tickLoop.stop();
    clearInterval(snapshotTimer);
    try {
      // `shutdown`, not `unload`: leaves the active pointer, so the next boot
      // returns to this world.
      logInfo(manager.shutdown() ? 'shutdown snapshot written' : 'nothing to snapshot');
    } catch (error) {
      logError('shutdown snapshot failed', error);
    }
  });

  gameServer.onShutdown(() => {
    logInfo('shutdown complete');
  });

  await gameServer.listen(config.port);
  logInfo(`listening on ws://0.0.0.0:${config.port} (room "${ROOM_NAME}")`);
  logInfo(
    `an operator restart exits ${TERRACE_RESTART_EXIT_CODE}; ` +
      'a supervisor must relaunch on that code',
  );
  // The ws:// line above is not a page; without this a browser gets a 404 (#20).
  if (clientExpressHook !== undefined) {
    logInfo(`play at http://localhost:${config.port} (same URL on your LAN address)`);
  } else {
    logInfo(`no built client to serve — browse the Vite dev server instead (pnpm --dir client dev)`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // The message alone: an operator cannot act on a stack trace.
    logError(error.message);
  } else {
    logError('failed to start', error);
  }
  process.exitCode = 1;
});
