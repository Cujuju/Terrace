// Boot sequence for a Terrace server (design §3.2, amended 2026-08-22: one
// world LIVE per process, many worlds on disk — see the WORLD MANAGEMENT
// section in shared/src/protocol.ts).
//
//   config → plugins → world registry → migration → world manager
//          → the world to load (or none) → tick loop → snapshot scheduler
//          → Colyseus server
//
// WHAT CHANGED FROM ONE-WORLD-PER-PROCESS. The World, its plugin host, its
// store and its rollback service are no longer boot-time constants; they are a
// SESSION the WorldManager creates, replaces and destroys while the process
// runs. Everything downstream — the tick loop, the snapshot scheduler, the
// room — therefore talks to the manager rather than holding any of them.
//
// Shutdown is the reverse, driven by Colyseus's own SIGINT/SIGTERM handling
// (verified in @colyseus/core 0.17.50: `gracefullyShutdown` defaults to true and
// registers the signal handlers, then awaits onBeforeShutdown → matchmaker
// shutdown → transport close → onShutdown). We hook that instead of installing
// competing handlers, so there is exactly one shutdown path.

import './quiet-boot.ts'; // must precede any Colyseus import — see that file's comment
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
import { logError, logInfo, logWarn } from './log.ts';
import { openWorlds } from './boot/open-worlds.ts';
import { WorldRegistry } from './persistence/world-registry.ts';
import { discoverPlugins } from './plugins/discovery.ts';
import { PluginHost } from './plugins/host.ts';
import { ServerRestartService, TERRACE_RESTART_EXIT_CODE } from './restart.ts';
import { createStaticFileHandler } from './static/serve-client.ts';
import { startTickLoop } from './tick.ts';
import { ROOM_NAME, TerraceRoom, bindRoomContext } from './net/terrace-room.ts';
import { WorldAdminService } from './world/world-admin.ts';
import { WorldManager } from './world/world-manager.ts';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Wires a built client (issue #20: "one process = playable URL") into the
 * game server's own HTTP port, via Colyseus's `ServerOptions.express` hook —
 * see static/serve-client.ts's header comment for why that hook is used
 * without express ever being a declared dependency of this package. Returns
 * `undefined` when `config.clientDistPath` has no `index.html`: the common
 * case in dev, where Vite (`pnpm --dir client dev`) remains the dev path and
 * nothing about that workflow changes.
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

/**
 * States which operator keys are live, and warns about the built-in defaults.
 *
 * The defaults ARE named in the warning, because they are public knowledge
 * already and the whole purpose of the line is to make sure nobody is running
 * on one by accident. A key the self-hoster chose is never printed.
 */
function logOperatorKeys(config: ServerConfig): void {
  if (config.rollbackKey === null) {
    logInfo('world rollback is disabled (ROLLBACK_KEY is set to nothing)');
  } else if (config.rollbackKey === DEFAULT_ROLLBACK_KEY) {
    logInfo(`world rollback is enabled (${config.snapshotRetention} restore points kept)`);
    logWarn(
      `world rollback is using the built-in key "${DEFAULT_ROLLBACK_KEY}", which is public. ` +
        'Anyone who can reach this server can roll the world back. Set ROLLBACK_KEY to your ' +
        'own value, or ROLLBACK_KEY= (empty) to turn rollback off.',
    );
  } else {
    logInfo(
      `world rollback is enabled with your own key (${config.snapshotRetention} restore points kept)`,
    );
  }

  if (config.worldAdminKey === null) {
    logInfo('world management is disabled (WORLD_ADMIN_KEY is set to nothing)');
  } else if (config.worldAdminKey === DEFAULT_WORLD_ADMIN_KEY) {
    logInfo('world management is enabled');
    // WARN for the same reason as rollback's, and more so: this key can
    // archive a world, not merely rewind one.
    logWarn(
      `world management is using the built-in key "${DEFAULT_WORLD_ADMIN_KEY}", which is ` +
        'public. Anyone who can reach this server can create, load and archive worlds. Set ' +
        'WORLD_ADMIN_KEY to your own value, or WORLD_ADMIN_KEY= (empty) to turn it off.',
    );
  } else {
    logInfo('world management is enabled with your own key');
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  // `newWorlds=` rather than `world=`: WORLD_SIZE is now the size worlds are
  // CREATED at, not the size of the one that is about to load — an existing
  // world keeps whatever size it was made with, and this server may hold
  // several of different sizes. The loaded world states its own size below.
  logInfo(
    `starting: newWorlds=${config.worldSize}² difficulty=${config.difficulty} ` +
      `port=${config.port} tick=${config.tickHz}Hz snapshot=${config.snapshotIntervalS}s ` +
      `worlds=${config.worldsDir}`,
  );

  // Plugins load before any world so a load failure costs nothing but a boot.
  const plugins = await discoverPlugins(config.pluginsDir);

  const registry = new WorldRegistry(config.worldsDir);
  const manager = new WorldManager({
    config,
    registry,
    plugins,
    switchCountdownS: config.worldSwitchCountdownS,
  });

  // Migration + "what is live" policy, in one place: see boot/open-worlds.ts
  // for why a missing world never becomes a fresh one.
  const outcome = openWorlds(config, registry, manager);
  const session = manager.current;
  if (session === null) {
    logWarn(
      'no world is loaded. The server is running and world management is available; ' +
        'load or create a world from the panel.',
    );
  } else {
    // The name is how a self-hoster tells one of their worlds from another in
    // a log; it is stated once, here, whenever a world becomes live.
    logInfo(`world is "${session.world.name}" (${outcome.loadedId})`);
  }

  // THE RESTART SERVICE IS BUILT BEFORE THE COLYSEUS SERVER IT SHUTS DOWN,
  // because the admin service needs it and the room context needs that. The
  // cycle is broken by a thunk rather than by a setter: `gameServer` below is
  // the only thing that can perform the shutdown, and a restart can only be
  // ASKED FOR over a connection, which cannot exist before `listen`. The throw
  // states that invariant instead of silently skipping the snapshot.
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
    // setImmediate, not a timeout with a number in it: the requirement is
    // "after this turn of the event loop", which is what setImmediate names.
    defer: (run) => {
      setImmediate(run);
    },
  });

  const admin = new WorldAdminService({ manager, registry, config, restart });
  logOperatorKeys(config);

  // BELT AND SUSPENDERS FOR WORLD IDENTITY. Booting can leave the world already
  // differing from the file it came from: a world restored without a name has
  // just been given one, and a plugin's onWorldCreate may have unlocked chunks.
  // Waiting SNAPSHOT_INTERVAL_S to write that would mean a crash inside the
  // first minute silently re-names the world on the next boot — an identity
  // wobble, not a lost sculpt. One extra write per process start, only when
  // something actually changed, closes it.
  try {
    if (manager.snapshotIfDirty()) logInfo('boot snapshot written');
  } catch (error) {
    // Same policy as the periodic snapshot: a failed write must not stop a
    // world from opening; the world stays dirty and the scheduler retries.
    logError('boot snapshot failed', error);
  }

  // The loop belongs to the PROCESS, not to a world: it keeps ticking across a
  // world switch and across having no world at all (WorldManager.tick is a
  // no-op then), so nothing has to be torn down and restarted to change worlds.
  const tickLoop = startTickLoop(config.tickHz, (dt) => manager.tick(dt));

  // Cadence half of the snapshot decision: every SNAPSHOT_INTERVAL_S, but only
  // if the world changed — an idle server writes nothing at all.
  const snapshotTimer = setInterval(() => {
    try {
      if (manager.snapshotIfDirty()) logInfo('world snapshot written');
    } catch (error) {
      // A failed periodic snapshot must not kill a live world; the next tick
      // retries, and the world stays dirty until one succeeds.
      logError('periodic snapshot failed', error);
    }
  }, config.snapshotIntervalS * MILLISECONDS_PER_SECOND);

  // Bind before define(): a room can be created as soon as the server listens.
  // The plugin message TYPES are computed once here, from the plugin set,
  // because the room outlives every world and must register handlers without
  // one — see PluginHost.messageTypesFor.
  bindRoomContext({
    manager,
    admin,
    restart,
    pluginMessageTypes: PluginHost.messageTypesFor(plugins),
  });
  // greet: false suppresses the Colyseus ASCII banner + sponsor links on boot
  // (@colyseus/core ServerOptions.greet, default true).
  const serverOptions: ServerOptions = { greet: false };
  const clientExpressHook = await clientStaticExpressHook(config);
  if (clientExpressHook !== undefined) {
    serverOptions.express = clientExpressHook;
  }
  gameServer = new Server(serverOptions);
  gameServer.define(ROOM_NAME, TerraceRoom);

  gameServer.onBeforeShutdown(() => {
    // Stop simulating first so the final snapshot is a quiescent world, then
    // write it — this is the "snapshot on clean shutdown" half of the decision.
    tickLoop.stop();
    clearInterval(snapshotTimer);
    try {
      // `shutdown`, not `unload`: it saves and closes the live world but
      // deliberately leaves the active pointer alone, so the next boot comes
      // back to the same world.
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
  // Stated at boot so a self-hoster writing a supervisor unit knows which code
  // means "bring me back" without reading the source.
  logInfo(
    `an operator restart exits ${TERRACE_RESTART_EXIT_CODE}; ` +
      'a supervisor must relaunch on that code',
  );
  // The line a self-hoster actually needs: where to point a browser. The ws://
  // line above is the protocol endpoint, not a page — printing only that
  // reads as "the client lives at 2567" while a browser gets a 404 (#20).
  if (clientExpressHook !== undefined) {
    logInfo(`play at http://localhost:${config.port} (same URL on your LAN address)`);
  } else {
    logInfo(`no built client to serve — browse the Vite dev server instead (pnpm --dir client dev)`);
  }
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
