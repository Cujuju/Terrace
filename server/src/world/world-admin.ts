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

export interface WorldAdminDeps {
  readonly manager: WorldManager;
  readonly registry: WorldRegistry;
  readonly config: ServerConfig;
  readonly restart: ServerRestartService;
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

  get keyed(): boolean {
    return this.gate.keyed;
  }

  forgetClient(clientId: string): void {
    this.gate.forgetClient(clientId);
  }

  authorize(clientId: string, key: string): WorldAdminRefusal | null {
    return this.gate.authorize(clientId, key);
  }

  list(clientId: string, key: string): WorldListMessage {
    const refusal = this.gate.authorize(clientId, key);
    if (refusal !== null) {
      return refusedList(refusal);
    }
    return this.listing();
  }

  plugins(clientId: string, key: string, worldId?: string): WorldPluginListMessage {
    const refusal = this.gate.authorize(clientId, key);
    if (refusal !== null) return refusedPlugins(worldId ?? '', refusal);
    return this.pluginListing(worldId);
  }

  async reloadPlugin(
    clientId: string,
    request: WorldPluginReloadRequestMessage,
  ): Promise<WorldAdminResultMessage> {
    const refusal = this.gate.authorize(clientId, request.key);
    if (refusal !== null) return fail('reloadPlugin', refusal);

    try {
      const outcome = await this.deps.manager.reloadPlugin(request.plugin);
      if (typeof outcome === 'string') return fail('reloadPlugin', outcome);
      return {
        type: 'worldAdminResult',
        action: 'reloadPlugin',
        ok: true,
        id: request.id,
        plugin: request.plugin,
      };
    } catch (error) {
      logError(`reloading plugin "${request.plugin}" failed`, error);
      return fail('reloadPlugin', 'failed');
    }
  }

  handle(clientId: string, request: WorldAdminRequestMessage): WorldAdminResultMessage {
    const action = actionOf(request);
    const refusal = this.gate.authorize(clientId, request.key);
    if (refusal !== null) return fail(action, refusal);

    try {
      return this.dispatch(clientId, request);
    } catch (error) {
      logError(`world management action "${action}" failed`, error);
      return fail(action, 'failed');
    }
  }

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

  pluginListing(worldId?: string): WorldPluginListMessage {
    const { manager } = this.deps;
    const activeId = manager.activeId;
    const id = worldId ?? activeId;
    if (id === null) return { ...refusedPlugins('', 'noWorldLoaded'), activeId };
    const disabled = manager.disabledPluginsFor(id);
    const settings = manager.pluginSettingsFor(id);
    if (disabled === null || settings === null) {
      return { ...refusedPlugins(id, 'unknownWorld'), activeId };
    }
    return {
      type: 'worldPluginListing',
      id,
      installed: [...manager.installedPluginNames],
      disabled: [...disabled],
      settings,
      actions: manager.pluginActions,
      versions: manager.installedPluginVersions,
      activeId,
    };
  }

  private dispatch(clientId: string, request: WorldAdminRequestMessage): WorldAdminResultMessage {
    switch (request.type) {
      case 'worldList':
        return fail('load', 'failed');

      case 'worldView':
        return fail('view', 'failed');

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
        return fail('setPlugin', 'failed');

      case 'worldPluginReload':
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

      case 'worldPluginAct':
        return this.actPlugin(request.plugin, request.action, { x: request.x, y: request.y });

      case 'serverRestart':
        return this.restartServer();

      case 'worldSwitchCancel':
        return this.deps.manager.cancelSwitch()
          ? { type: 'worldAdminResult', action: 'cancelSwitch', ok: true }
          : fail('cancelSwitch', 'noSwitchPending');
    }
  }

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
    if (size < MIN_WORLD_SIZE || size > MAX_WORLD_SIZE || size % CHUNK_SIZE !== 0) {
      return fail('create', 'invalidSize');
    }

    const id = manager.createWorld(chosenName, size, difficulty ?? config.difficulty);
    if (id === null) return fail('create', 'nameInUse');

    if (loadNow === true) {
      const outcome = manager.requestLoad(id, requesterId);
      if (typeof outcome === 'string') {
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

  private rename(id: string, name: string): WorldAdminResultMessage {
    const { manager, registry, config } = this.deps;
    if (!registry.has(id)) return fail('rename', 'unknownWorld');

    const session = manager.current;
    if (session !== null && session.id === id) {
      session.world.rename(name);
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

  private duplicate(id: string, name: string | undefined): WorldAdminResultMessage {
    const { manager, registry } = this.deps;
    if (!registry.has(id)) return fail('duplicate', 'unknownWorld');

    const session = manager.current;
    if (session !== null && session.id === id) {
      snapshotIfDirty(session);
      session.store.checkpoint();
    }

    const sourceName = registry.summaryFor(id, manager.activeId)?.name ?? id;
    const copyName = name ?? `${sourceName} (copy)`;
    const copyId = registry.uniqueIdFor(copyName);
    if (copyId === null) return fail('duplicate', 'nameInUse');

    registry.duplicate(id, copyId);
    const store = registry.openStore(copyId, this.deps.config.snapshotRetention);
    try {
      store.setWorldName(copyName);
    } finally {
      store.close();
    }
    logInfo(`world "${id}" duplicated as "${copyId}" ("${copyName}")`);
    return { type: 'worldAdminResult', action: 'duplicate', ok: true, id: copyId };
  }

  private archive(id: string): WorldAdminResultMessage {
    const { manager, registry } = this.deps;
    if (!registry.has(id)) return fail('archive', 'unknownWorld');
    if (manager.activeId === id) return fail('archive', 'worldIsActive');

    const { path } = registry.archive(id, Date.now());
    return { type: 'worldAdminResult', action: 'archive', ok: true, id, archivedPath: path };
  }

  private unarchive(archivedId: string): WorldAdminResultMessage {
    const { registry } = this.deps;
    if (!registry.hasArchived(archivedId)) return fail('unarchive', 'notArchived');
    const restoredId = registry.unarchive(archivedId);
    return { type: 'worldAdminResult', action: 'unarchive', ok: true, id: restoredId };
  }

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

  private setPlugin(id: string, plugin: string, enabled: boolean): WorldAdminResultMessage {
    const outcome = this.deps.manager.setPluginEnabled(id, plugin, enabled);
    if (typeof outcome === 'string') return fail('setPlugin', outcome);
    return { type: 'worldAdminResult', action: 'setPlugin', ok: true, id };
  }

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

  private actPlugin(
    plugin: string,
    action: string,
    site: { readonly x: number; readonly y: number },
  ): WorldAdminResultMessage {
    const outcome = this.deps.manager.actPlugin(plugin, action, site);
    if (typeof outcome === 'string') return fail('actPlugin', outcome);
    logInfo(`plugin "${plugin}" action "${action}": ${outcome.detail}`);
    if (!outcome.ok) {
      return { ...fail('actPlugin', 'actionDeclined'), plugin, detail: outcome.detail };
    }
    return { type: 'worldAdminResult', action: 'actPlugin', ok: true, plugin, detail: outcome.detail };
  }

  private restartServer(): WorldAdminResultMessage {
    const outcome = this.deps.restart.request();
    if (typeof outcome === 'string') return fail('restart', outcome);
    return { type: 'worldAdminResult', action: 'restart', ok: true };
  }

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
    case 'worldView':
      return 'view';
    case 'worldPluginList':
    case 'worldPluginSet':
      return 'setPlugin';
    case 'worldPluginReload':
      return 'reloadPlugin';
    case 'worldPluginConfigure':
      return 'configurePlugin';
    case 'worldPluginAct':
      return 'actPlugin';
    case 'serverRestart':
      return 'restart';
    case 'worldSwitchCancel':
      return 'cancelSwitch';
  }
}

function refusedList(refused: WorldAdminRefusal): WorldListMessage {
  return {
    type: 'worldListing',
    worlds: [],
    archived: [],
    activeId: null,
    refused,
  };
}

function refusedPlugins(worldId: string, refused: WorldAdminRefusal): WorldPluginListMessage {
  return {
    type: 'worldPluginListing',
    id: worldId,
    installed: [],
    disabled: [],
    settings: [],
    actions: [],
    versions: {},
    refused,
  };
}

function fail(action: WorldAdminAction, refused: WorldAdminRefusal): WorldAdminResultMessage {
  return { type: 'worldAdminResult', action, ok: false, refused };
}

export type WorldAdminReply =
  | WorldAdminResultMessage
  | WorldListMessage
  | WorldPluginListMessage;

export async function containWorldAdminMessage(
  request: WorldAdminRequestMessage,
  reply: (message: WorldAdminReply) => void,
  run: () => void | Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const action = actionOf(request);
    logError(`world management message "${request.type}" failed`, error);
    if (request.type === 'worldList') reply(refusedList('failed'));
    else if (request.type === 'worldPluginList') reply(refusedPlugins(request.id ?? '', 'failed'));
    else reply(fail(action, 'failed'));
  }
}
