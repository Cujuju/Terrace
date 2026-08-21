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

import './quiet-boot.ts'; // must precede any Colyseus import — see that file's comment
import { Server, type ServerOptions } from '@colyseus/core';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, ConfigError, DEFAULT_ROLLBACK_KEY, type ServerConfig } from './config.ts';
import { logError, logInfo, logWarn } from './log.ts';
import { SnapshotStore } from './persistence/snapshot-store.ts';
import { discoverPlugins } from './plugins/discovery.ts';
import { PluginHost } from './plugins/host.ts';
import { createStaticFileHandler } from './static/serve-client.ts';
import { startTickLoop } from './tick.ts';
import { ROOM_NAME, TerraceRoom, bindRoomContext } from './net/terrace-room.ts';
import { RollbackService } from './world/rollback.ts';
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
    return {
      world: World.createFresh(config.worldSize, config.difficulty),
      pluginSlices: {},
    };
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
    // Difficulty comes from the environment, not the snapshot; the NAME comes
    // from the snapshot, not the environment — see World.restore for why the
    // two are opposite. A null name means a world created before names existed:
    // restore mints one and marks the world dirty so it is written on the next
    // snapshot instead of being re-drawn on every boot.
    world: World.restore(
      config.worldSize,
      snapshot.cells,
      snapshot.mask,
      config.difficulty,
      snapshot.name,
      // Per-player unlock masks (issue #17). Empty on a legacy snapshot —
      // World.restore's own doc comment states what that means for a
      // returning player.
      snapshot.tokenMasks,
    ),
    pluginSlices: snapshot.pluginSlices,
  };
}

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

/** Writes a snapshot if anything changed. Returns true when one was written. */
function snapshotIfDirty(world: World, host: PluginHost, store: SnapshotStore): boolean {
  if (!world.dirty) return false;
  store.saveSnapshot({
    worldSize: world.size,
    name: world.name,
    cells: world.map.cells,
    mask: world.mask,
    pluginSlices: host.collectPersistence(),
    // Per-player unlock masks (issue #17) — persisted beside the union mask
    // for the reasons in snapshot-store.ts's TOKEN_MASKS TABLE comment.
    tokenMasks: world.tokenMasks(),
  });
  world.markSnapshotted();
  return true;
}

async function main(): Promise<void> {
  const config = loadConfig();
  logInfo(
    `starting: world=${config.worldSize}² difficulty=${config.difficulty} port=${config.port} ` +
      `tick=${config.tickHz}Hz snapshot=${config.snapshotIntervalS}s db=${config.dbPath}`,
  );

  // Plugins load before the world so a load failure costs nothing but a boot.
  const plugins = await discoverPlugins(config.pluginsDir);

  const store = SnapshotStore.open(config.dbPath, config.snapshotRetention);
  const { world, pluginSlices } = openWorld(config, store);
  // The name is how a self-hoster tells one of their worlds from another in a
  // log; it is fixed for the life of the world, so it is stated once at boot.
  logInfo(`world is "${world.name}"`);

  const host = new PluginHost(world, plugins);
  // Restore first, then announce: onWorldCreate must see a world whose plugin
  // state is already the state it had when the process died.
  host.restorePersistence(pluginSlices);
  host.worldCreate();

  // BELT AND SUSPENDERS FOR WORLD IDENTITY. Booting can leave the world already
  // differing from the file it came from: a world restored without a name has
  // just been given one, and a plugin's onWorldCreate may have unlocked chunks.
  // Waiting SNAPSHOT_INTERVAL_S to write that would mean a crash inside the
  // first minute silently re-names the world on the next boot — an identity
  // wobble, not a lost sculpt. One extra write per process start, only when
  // something actually changed, closes it.
  try {
    if (snapshotIfDirty(world, host, store)) logInfo('boot snapshot written');
  } catch (error) {
    // Same policy as the periodic snapshot: a failed write must not stop a
    // world from opening; the world stays dirty and the scheduler retries.
    logError('boot snapshot failed', error);
  }

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

  // WORLD ROLLBACK (2026-08-21). Constructed here, at the one place that holds
  // the world, the plugin host and the store together — the three things a
  // rewind has to move in step (see world/rollback.ts).
  const rollback = new RollbackService({
    world,
    host,
    store,
    key: config.rollbackKey,
    retention: config.snapshotRetention,
    intervalS: config.snapshotIntervalS,
  });
  // States WHETHER rollback is available, and — only for the built-in default
  // — WHICH key is live. A key the self-hoster chose is never printed; the
  // default is, because it is public knowledge already and the whole purpose
  // of the line is to make sure nobody is running on it by accident.
  if (!rollback.enabled) {
    logInfo('world rollback is disabled (ROLLBACK_KEY is set to nothing)');
  } else if (config.rollbackKey === DEFAULT_ROLLBACK_KEY) {
    logInfo(`world rollback is enabled (${config.snapshotRetention} restore points kept)`);
    // WARN, not info: on a server anyone else can reach, this is a standing
    // invitation to roll the world back, and the operator has not chosen it —
    // it is simply what an unconfigured deployment does.
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

  // Bind before define(): a room can be created as soon as the server listens.
  bindRoomContext({ world, host, rollback });
  // greet: false suppresses the Colyseus ASCII banner + sponsor links on boot
  // (@colyseus/core ServerOptions.greet, default true).
  const serverOptions: ServerOptions = { greet: false };
  const clientExpressHook = await clientStaticExpressHook(config);
  if (clientExpressHook !== undefined) {
    serverOptions.express = clientExpressHook;
  }
  const gameServer = new Server(serverOptions);
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
