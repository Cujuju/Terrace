// WORLD ADMINISTRATION — the operator-facing half of multi-world.
//
// CRITICAL CODE. Every message this file answers is gated by WORLD_ADMIN_KEY,
// and one of them (`worldPurge`) destroys a world permanently. The rules:
//
//   1. THE GATE RUNS FIRST, ALWAYS, for every action without exception. There
//      is exactly one `authorize` call site per public entry point, at the top,
//      before any argument is even looked at.
//   2. ARCHIVING IS NOT DELETING, AND ONLY PURGE DELETES. Archive moves a file
//      into `.trash`. Purge is refused unless the world is ALREADY archived
//      and the operator has echoed its name back exactly, so destroying a
//      world always takes two separate decisions.
//   3. THE LIVE WORLD CANNOT BE ARCHIVED OR PURGED OUT FROM UNDER ITSELF.
//      Unload or switch away first — a refusal, not a silent close.
//   4. NOTHING IS EVER OVERWRITTEN. Every id that names a new file is checked
//      for collision against live AND archived worlds first (see
//      WorldRegistry.uniqueIdFor).
//
// The split from world-manager.ts is deliberate: the manager owns the world
// LIFECYCLE (what is loaded, how one becomes another) and knows nothing about
// keys or protocol messages; this file owns the OPERATOR CONTRACT and knows
// nothing about plugin hosts or sinks.

import {
  CHUNK_SIZE,
  type WorldAdminAction,
  type WorldAdminRefusal,
  type WorldAdminRequestMessage,
  type WorldAdminResultMessage,
  type WorldListMessage,
  type WorldPluginListMessage,
  type WorldPluginReloadRequestMessage,
} from '@terrace/shared';
import type { ServerConfig } from '../config.ts';
import { MAX_WORLD_SIZE, MIN_WORLD_SIZE } from '../config.ts';
import { logError, logInfo } from '../log.ts';
import type { WorldRegistry } from '../persistence/world-registry.ts';
import type { ServerRestartService } from '../restart.ts';
import { generateWorldName } from './world-name.ts';
import { OperatorGate } from './operator-gate.ts';
import { snapshotIfDirty } from './session.ts';
import type { WorldManager } from './world-manager.ts';

/** Everything world administration needs from the process. */
export interface WorldAdminDeps {
  readonly manager: WorldManager;
  readonly registry: WorldRegistry;
  readonly config: ServerConfig;
  /**
   * Owns the exit sequence for `serverRestart`. Required rather than optional:
   * a service that answers the restart action with "unavailable" would be a
   * refusal nothing can act on, and the boot path always has one.
   */
  readonly restart: ServerRestartService;
  /** Injectable clock, for the lockout tests. See OperatorGateOptions. */
  readonly now?: () => number;
}

export class WorldAdminService {
  private readonly deps: WorldAdminDeps;
  private readonly gate: OperatorGate;

  constructor(deps: WorldAdminDeps) {
    this.deps = deps;
    this.gate = new OperatorGate({
      key: deps.config.worldAdminKey,
      label: 'world management',
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      log: logInfo,
    });
  }

  /** True when WORLD_ADMIN_KEY is configured; the boot log states this. */
  get enabled(): boolean {
    return this.gate.enabled;
  }

  /** Drops a disconnected connection's failed-attempt record. */
  forgetClient(clientId: string): void {
    this.gate.forgetClient(clientId);
  }

  /**
   * Answers a world listing request.
   *
   * A refusal still returns a well-formed message with empty lists, never a
   * silence — same reasoning as RollbackService.listRestorePoints: the
   * operator needs to be told WHY, or they will retype a key against a server
   * that has none configured.
   */
  list(clientId: string, key: string): WorldListMessage {
    const refusal = this.gate.authorize(clientId, key);
    if (refusal !== null) {
      return {
        type: 'worldListing',
        worlds: [],
        archived: [],
        activeId: null,
        refused: refusal,
      };
    }
    return this.listing();
  }

  /**
   * Answers a plugin-enablement request for ONE world.
   *
   * Its own entry point rather than a `handle` action for the same reason
   * `list` has one: it answers with a LISTING, not a receipt, and folding a
   * second response shape into WorldAdminResultMessage would make every caller
   * of `handle` check which one it got.
   *
   * A refusal answers with empty lists and the reason, never a silence — see
   * `list` for why.
   */
  plugins(clientId: string, key: string, worldId: string): WorldPluginListMessage {
    const refusal = this.gate.authorize(clientId, key);
    if (refusal !== null) return refusedPlugins(worldId, refusal);
    return this.pluginListing(worldId);
  }

  /**
   * Re-imports one plugin's server code in place (issue #198).
   *
   * ITS OWN ENTRY POINT rather than a `handle` action, for one reason: it is
   * the only world-management action that AWAITS. Every other action is
   * synchronous by construction — that is what makes a world swap a moment
   * nothing can observe half-done (world-manager.ts guarantee 2) — and turning
   * `handle` into a promise to accommodate one import would put an await in
   * front of fifteen actions that have no use for it.
   *
   * The gate runs first here exactly as it does in `handle` (rule 1).
   */
  async reloadPlugin(
    clientId: string,
    request: WorldPluginReloadRequestMessage,
  ): Promise<WorldAdminResultMessage> {
    const refusal = this.gate.authorize(clientId, request.key);
    if (refusal !== null) return fail('reloadPlugin', refusal);

    try {
      const outcome = await this.deps.manager.reloadPlugin(request.plugin);
      if (typeof outcome === 'string') return fail('reloadPlugin', outcome);
      return { type: 'worldAdminResult', action: 'reloadPlugin', ok: true, id: request.id };
    } catch (error) {
      // The manager contains every failure the plugin itself can produce, so a
      // throw out of it is core's own — the same class `handle` catches.
      logError(`reloading plugin "${request.plugin}" failed`, error);
      return fail('reloadPlugin', 'failed');
    }
  }

  /**
   * Answers every world-management action other than listing.
   *
   * ONE ENTRY POINT FOR EVERY ACTION BUT THE TWO LISTINGS, so the gate check
   * exists once. The switch below runs only after the key has been accepted.
   */
  handle(clientId: string, request: WorldAdminRequestMessage): WorldAdminResultMessage {
    const action = actionOf(request);
    const refusal = this.gate.authorize(clientId, request.key);
    if (refusal !== null) return fail(action, refusal);

    try {
      return this.dispatch(clientId, request);
    } catch (error) {
      // A throw here means the filesystem or SQLite said no. Nothing in this
      // file destroys anything except purge, so "failed" genuinely means the
      // world is still where it was.
      logError(`world management action "${action}" failed`, error);
      return fail(action, 'failed');
    }
  }

  /** The current listing, as the panel sees it. */
  listing(): WorldListMessage {
    const { manager, registry } = this.deps;
    const activeId = manager.activeId;
    const pending = manager.pendingSwitch;
    return {
      type: 'worldListing',
      worlds: registry.list(activeId),
      archived: registry.listArchived(),
      activeId,
      ...(pending !== null ? { pending } : {}),
    };
  }

  /** One world's plugin enablement and settings, as the panel sees it. */
  pluginListing(worldId: string): WorldPluginListMessage {
    const { manager } = this.deps;
    const disabled = manager.disabledPluginsFor(worldId);
    const settings = manager.pluginSettingsFor(worldId);
    if (disabled === null || settings === null) return refusedPlugins(worldId, 'unknownWorld');
    return {
      type: 'worldPluginListing',
      id: worldId,
      installed: [...manager.installedPluginNames],
      disabled: [...disabled],
      settings,
      versions: manager.installedPluginVersions,
    };
  }

  private dispatch(clientId: string, request: WorldAdminRequestMessage): WorldAdminResultMessage {
    switch (request.type) {
      case 'worldList':
        // Handled by list() above; reaching here means a caller routed a list
        // request through handle(). Answer honestly rather than pretending.
        return fail('load', 'failed');

      case 'worldCreate':
        return this.create(
          clientId,
          request.name,
          request.worldSize,
          request.difficulty,
          request.loadNow,
        );

      case 'worldLoad':
        return this.load(clientId, request.id);

      case 'worldUnload':
        return this.deps.manager.unload()
          ? { type: 'worldAdminResult', action: 'unload', ok: true }
          : fail('unload', 'noWorldLoaded');

      case 'worldRename':
        return this.rename(request.id, request.name);

      case 'worldDuplicate':
        return this.duplicate(request.id, request.name);

      case 'worldArchive':
        return this.archive(request.id);

      case 'worldUnarchive':
        return this.unarchive(request.id);

      case 'worldPurge':
        return this.purge(request.id, request.confirmName);

      case 'worldPin':
        return this.pin(request.pointId, request.pinned);

      case 'worldPluginList':
        // Handled by plugins() above; reaching here means a caller routed a
        // plugin listing through handle(). Answer honestly, as worldList does.
        return fail('setPlugin', 'failed');

      case 'worldPluginReload':
        // Handled by reloadPlugin() below; reaching here means a caller routed
        // a reload through handle(). Answer honestly, as worldList does.
        return fail('reloadPlugin', 'failed');

      case 'worldPluginSet':
        return this.setPlugin(request.id, request.plugin, request.enabled);

      case 'worldPluginConfigure':
        return this.configurePlugin(
          request.id,
          request.plugin,
          request.setting,
          request.value,
        );

      case 'serverRestart':
        return this.restartServer();

      case 'worldSwitchCancel':
        return this.deps.manager.cancelSwitch()
          ? { type: 'worldAdminResult', action: 'cancelSwitch', ok: true }
          : fail('cancelSwitch', 'noSwitchPending');
    }
  }

  /**
   * Creates a world. Size and difficulty fall back to this server's own
   * configuration, so the common case ("another world like this one") needs
   * no numbers at all.
   *
   * The requester id rides along only for the loadNow path: an announced
   * switch that later fails at fire time must be able to reach the operator
   * who asked for it (see PendingSwitch.requesterId).
   */
  private create(
    requesterId: string,
    name: string | undefined,
    worldSize: number | undefined,
    difficulty: number | undefined,
    loadNow: boolean | undefined,
  ): WorldAdminResultMessage {
    const { config, manager } = this.deps;

    const chosenName = name ?? generateWorldName();
    const size = worldSize ?? config.worldSize;
    // Re-validated HERE against the same bounds boot uses, because a size that
    // came off the wire has only been checked for being a positive integer
    // (see validateWorldAdminRequest). A world whose size is not a whole
    // number of chunks has cells no reveal could ever reach.
    if (size < MIN_WORLD_SIZE || size > MAX_WORLD_SIZE || size % CHUNK_SIZE !== 0) {
      return fail('create', 'invalidSize');
    }

    const id = manager.createWorld(chosenName, size, difficulty ?? config.difficulty);
    if (id === null) return fail('create', 'nameInUse');

    if (loadNow === true) {
      const outcome = manager.requestLoad(id, requesterId);
      if (typeof outcome === 'string') {
        // The world WAS created; only loading it failed. Report the create as
        // the success it is, so nobody goes looking for a world that exists.
        logInfo(`world "${id}" was created but could not be loaded (${outcome})`);
      }
    }
    return { type: 'worldAdminResult', action: 'create', ok: true, id };
  }

  private load(requesterId: string, id: string): WorldAdminResultMessage {
    const outcome = this.deps.manager.requestLoad(id, requesterId);
    if (typeof outcome === 'string') return fail('load', outcome);
    return { type: 'worldAdminResult', action: 'load', ok: true, id };
  }

  /**
   * Renames a world, live or not.
   *
   * TWO PATHS BECAUSE THERE ARE GENUINELY TWO CASES, and neither can stand in
   * for the other: the live world's name is held in memory by a World that
   * every plugin and every join snapshot reads, so it must be renamed THERE
   * and allowed to reach disk through the ordinary snapshot path; a world that
   * is merely a file has no memory to update, so its history is relabelled
   * directly. The file is never renamed either way — see World.rename.
   */
  private rename(id: string, name: string): WorldAdminResultMessage {
    const { manager, registry, config } = this.deps;
    if (!registry.has(id)) return fail('rename', 'unknownWorld');

    const session = manager.current;
    if (session !== null && session.id === id) {
      session.world.rename(name);
      // Persist immediately rather than waiting for the scheduler: a rename
      // the operator can see in the panel but that a crash would undo is a
      // rename that lies.
      snapshotIfDirty(session);
      session.store.setWorldName(name);
    } else {
      const store = registry.openStore(id, config.snapshotRetention);
      try {
        store.setWorldName(name);
      } finally {
        store.close();
      }
    }
    logInfo(`world "${id}" renamed to "${name}"`);
    return { type: 'worldAdminResult', action: 'rename', ok: true, id };
  }

  /**
   * Copies a world under a new name, with its whole history.
   *
   * The LIVE world is snapshotted first, so "duplicate" means what an operator
   * expects — the world as it is right now, not as it was at the last
   * scheduled save.
   */
  private duplicate(id: string, name: string | undefined): WorldAdminResultMessage {
    const { manager, registry } = this.deps;
    if (!registry.has(id)) return fail('duplicate', 'unknownWorld');

    const session = manager.current;
    if (session !== null && session.id === id) {
      snapshotIfDirty(session);
      // ...and get those rows out of the WAL and into the file that is about
      // to be copied. Through the LIVE store's own connection: see
      // SnapshotStore.checkpoint for why the registry's cannot do it here.
      session.store.checkpoint();
    }

    const sourceName = registry.summaryFor(id, manager.activeId)?.name ?? id;
    const copyName = name ?? `${sourceName} (copy)`;
    const copyId = registry.uniqueIdFor(copyName);
    if (copyId === null) return fail('duplicate', 'nameInUse');

    registry.duplicate(id, copyId);
    // The copy carries the ORIGINAL's name inside it until it is relabelled,
    // which would make two worlds claiming the same name in one list.
    const store = registry.openStore(copyId, this.deps.config.snapshotRetention);
    try {
      store.setWorldName(copyName);
    } finally {
      store.close();
    }
    logInfo(`world "${id}" duplicated as "${copyId}" ("${copyName}")`);
    return { type: 'worldAdminResult', action: 'duplicate', ok: true, id: copyId };
  }

  /** Moves a world to the trash. Refuses the live world. */
  private archive(id: string): WorldAdminResultMessage {
    const { manager, registry } = this.deps;
    if (!registry.has(id)) return fail('archive', 'unknownWorld');
    if (manager.activeId === id) return fail('archive', 'worldIsActive');

    const { path } = registry.archive(id, Date.now());
    return { type: 'worldAdminResult', action: 'archive', ok: true, id, archivedPath: path };
  }

  /** Brings a world back out of the trash. */
  private unarchive(archivedId: string): WorldAdminResultMessage {
    const { registry } = this.deps;
    if (!registry.hasArchived(archivedId)) return fail('unarchive', 'notArchived');
    const restoredId = registry.unarchive(archivedId);
    return { type: 'worldAdminResult', action: 'unarchive', ok: true, id: restoredId };
  }

  /**
   * PERMANENTLY DESTROYS an archived world.
   *
   * Three gates stand in front of the `rm`: the operator key (already checked
   * by `handle`), the world having been archived first, and the operator
   * typing its name. The name comparison is exact and untrimmed — this is the
   * one place in the file where being forgiving about whitespace would make
   * the confirmation weaker.
   */
  private purge(archivedId: string, confirmName: string): WorldAdminResultMessage {
    const { registry } = this.deps;
    if (!registry.hasArchived(archivedId)) return fail('purge', 'notArchived');

    const summary = registry
      .listArchived()
      .find((world) => world.id === archivedId);
    if (summary === undefined) return fail('purge', 'notArchived');
    if (confirmName !== summary.name) return fail('purge', 'confirmationMismatch');

    registry.purge(archivedId);
    return { type: 'worldAdminResult', action: 'purge', ok: true, id: archivedId };
  }

  /**
   * Switches one plugin on or off for one world.
   *
   * THE MANAGER OWNS THE WHOLE ACT, because enabling a plugin is not a setting
   * — it is a property of the session that runs it. `setPluginEnabled` writes
   * the world file and, when that world is the live one, reopens it so the new
   * plugin set is actually in effect; every player is carried across without
   * dropping a socket (issue #166). This method only widens its refusal into
   * the operator's vocabulary.
   */
  private setPlugin(id: string, plugin: string, enabled: boolean): WorldAdminResultMessage {
    const outcome = this.deps.manager.setPluginEnabled(id, plugin, enabled);
    if (typeof outcome === 'string') return fail('setPlugin', outcome);
    return { type: 'worldAdminResult', action: 'setPlugin', ok: true, id };
  }

  /**
   * Records one plugin setting for one world.
   *
   * THE MANAGER OWNS THE WHOLE ACT, exactly as it does for enablement: it is
   * the holder of the installed plugins and therefore of their declarations,
   * which are what a key and a value are checked against. This method only
   * widens its refusal into the operator's vocabulary.
   */
  private configurePlugin(
    id: string,
    plugin: string,
    setting: string,
    value: string,
  ): WorldAdminResultMessage {
    const outcome = this.deps.manager.setPluginSetting(id, plugin, setting, value);
    if (typeof outcome === 'string') return fail('configurePlugin', outcome);
    return { type: 'worldAdminResult', action: 'configurePlugin', ok: true, id };
  }

  /**
   * Restarts the server process, so code that changed on disk becomes live.
   *
   * THE SERVICE OWNS THE WHOLE ACT, for `setPlugin`'s reason: the exit sequence
   * is a property of the process, not of any world, and its one correct order
   * is stated in exactly one place (server/src/restart.ts). This method only
   * widens the refusal into the operator's vocabulary.
   *
   * NOT GATED ON A WORLD BEING LOADED. A server with no world still has code
   * to update, and the restart is how it gets it.
   */
  private restartServer(): WorldAdminResultMessage {
    const outcome = this.deps.restart.request();
    if (typeof outcome === 'string') return fail('restart', outcome);
    return { type: 'worldAdminResult', action: 'restart', ok: true };
  }

  /**
   * Pins or unpins a restore point in the LIVE world.
   *
   * Only the live world, because pinning is a judgement about a moment the
   * operator is looking at in the rollback panel, and that panel shows the
   * live world's history. Pinning inside a world you are not in has no way to
   * name a point.
   */
  private pin(pointId: number, pinned: boolean): WorldAdminResultMessage {
    const session = this.deps.manager.current;
    if (session === null) return fail('pin', 'noWorldLoaded');
    if (!session.store.setPinned(pointId, pinned)) {
      return fail('pin', 'unknownWorld');
    }
    logInfo(`restore point #${pointId} ${pinned ? 'pinned' : 'unpinned'}`);
    return { type: 'worldAdminResult', action: 'pin', ok: true, id: session.id };
  }
}

/** The action name for a request, for the receipt and the failure log. */
function actionOf(request: WorldAdminRequestMessage): WorldAdminAction {
  switch (request.type) {
    case 'worldCreate':
      return 'create';
    case 'worldLoad':
    case 'worldList':
      return 'load';
    case 'worldUnload':
      return 'unload';
    case 'worldRename':
      return 'rename';
    case 'worldDuplicate':
      return 'duplicate';
    case 'worldArchive':
      return 'archive';
    case 'worldUnarchive':
      return 'unarchive';
    case 'worldPurge':
      return 'purge';
    case 'worldPin':
      return 'pin';
    case 'worldPluginList':
    case 'worldPluginSet':
      return 'setPlugin';
    case 'worldPluginReload':
      return 'reloadPlugin';
    case 'worldPluginConfigure':
      return 'configurePlugin';
    case 'serverRestart':
      return 'restart';
    case 'worldSwitchCancel':
      return 'cancelSwitch';
  }
}

/** One shape for every refused plugin listing, matching `fail`'s role. */
function refusedPlugins(worldId: string, refused: WorldAdminRefusal): WorldPluginListMessage {
  return {
    type: 'worldPluginListing',
    id: worldId,
    installed: [],
    disabled: [],
    settings: [],
    versions: {},
    refused,
  };
}

/** One shape for every refusal, so no call site invents its own. */
function fail(action: WorldAdminAction, refused: WorldAdminRefusal): WorldAdminResultMessage {
  return { type: 'worldAdminResult', action, ok: false, refused };
}
