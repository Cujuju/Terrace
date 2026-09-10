import './quiet-boot.ts';
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
import { TICK_TOTAL_PHASE, startTickTimingReport, timePhase } from './tick-timing.ts';
import { ROOM_NAME, TerraceRoom, bindRoomContext } from './net/terrace-room.ts';
import { WorldAdminService } from './world/world-admin.ts';
import { WorldManager } from './world/world-manager.ts';

const MILLISECONDS_PER_SECOND = 1000;

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
  logInfo(
    `starting: newWorlds=${config.worldSize}² difficulty=${config.difficulty} ` +
      `port=${config.port} tick=${config.tickHz}Hz snapshot=${config.snapshotIntervalS}s ` +
      `worlds=${config.worldsDir}`,
  );

  const plugins = new InstalledPlugins(await discoverPlugins(config.pluginsDir));

  const identity = initBuildIdentity({ plugins: plugins.list, clientDistPath: config.clientDistPath });
  logInfo(`build identity ${identity} (core, plugins and the served client bundle)`);

  const registry = new WorldRegistry(config.worldsDir);
  const manager = new WorldManager({
    config,
    registry,
    plugins,
    switchCountdownS: config.worldSwitchCountdownS,
  });

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

  let gameServer: Server | null = null;
  const restart = new ServerRestartService({
    shutdown: async () => {
      if (gameServer === null) {
        throw new Error('restart requested before the server was listening');
      }
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

  try {
    if (manager.snapshotIfDirty()) logInfo('boot snapshot written');
  } catch (error) {
    logError('boot snapshot failed', error);
  }

  const tickLoop = startTickLoop(config.tickHz, (dt) => {
    timePhase(TICK_TOTAL_PHASE, () => manager.tick(dt));
  });
  const tickTiming = startTickTimingReport({
    tickHz: config.tickHz,
    worldSize: () => manager.current?.world.size ?? null,
  });

  const snapshotTimer = setInterval(() => {
    try {
      const written = timePhase('snapshot', () => manager.snapshotIfDirty({ defer: true }));
      if (written) logInfo('world snapshot handed to writer');
    } catch (error) {
      logError('periodic snapshot failed', error);
    }
  }, config.snapshotIntervalS * MILLISECONDS_PER_SECOND);

  bindRoomContext({ manager, admin, restart });
  const serverOptions: ServerOptions = { greet: false };
  const clientExpressHook = await clientStaticExpressHook(config);
  if (clientExpressHook !== undefined) {
    serverOptions.express = clientExpressHook;
  }
  gameServer = new Server(serverOptions);
  // Windows delivers Ctrl-Break as SIGBREAK; Colyseus binds only SIGINT/SIGTERM/SIGUSR2.
  process.once('SIGBREAK', () => void gameServer?.gracefullyShutdown());
  gameServer.define(ROOM_NAME, TerraceRoom);

  gameServer.onBeforeShutdown(() => {
    tickLoop.stop();
    tickTiming?.stop();
    clearInterval(snapshotTimer);
    try {
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
  if (clientExpressHook !== undefined) {
    logInfo(`play at http://localhost:${config.port} (same URL on your LAN address)`);
  } else {
    logInfo(`no built client to serve — browse the Vite dev server instead (pnpm --dir client dev)`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logError(error.message);
  } else {
    logError('failed to start', error);
  }
  process.exitCode = 1;
});
