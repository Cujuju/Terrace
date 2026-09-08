import type { MessageSink } from '../net/message-sink.ts';
import type { WorldPluginAction, WorldPluginSetting, WorldSwitchStatus } from '@terrace/shared';
import type { SnapshotStore } from '../persistence/snapshot-store.ts';
import { buildJoinSnapshot } from '../net/join-snapshot.ts';
import { buildIdentity, rebindBuildIdentity } from '../build-identity.ts';
import { logError, logInfo, logWarn } from '../log.ts';
import type { LoadedPlugin, PluginActionOutcome, PluginActionSite } from '../plugins/types.ts';
import { reimportPlugin } from '../plugins/reload.ts';
import type { Player } from '../player.ts';
import { applyInitialUnlockForToken } from './initial-unlock.ts';
import {
  closeSession,
  createWorldFile,
  openSession,
  releaseSession,
  snapshotIfDirty,
  type SnapshotOptions,
  type SessionDeps,
  type WorldSession,
} from './session.ts';

const MILLISECONDS_PER_SECOND = 1000;

export const CLIENTS_ABOVE_WHICH_TO_ANNOUNCE = 1;

export interface RoomBridge {
  readonly sink: MessageSink;
  clientCount(): number;
  players(): readonly Player[];
}

export interface WorldManagerDeps extends SessionDeps {
  readonly switchCountdownS: number;
}

export type LoadRefusal = 'unknownWorld' | 'alreadyActive' | 'switchInProgress' | 'failed';

export type ReopenRefusal = 'noWorldLoaded' | 'switchInProgress' | 'failed';

export type PluginToggleRefusal =
  | 'unknownWorld'
  | 'unknownPlugin'
  | 'switchInProgress'
  | 'failed';

export type PluginSettingRefusal = PluginToggleRefusal | 'unknownSetting';

export type PluginActionRefusal =
  | 'noWorldLoaded'
  | 'unknownPlugin'
  | 'unknownAction'
  | 'pluginDisabled'
  | 'failed';

export type PluginReloadRefusal =
  | 'unknownPlugin'
  | 'noWorldLoaded'
  | 'switchInProgress'
  | 'reloadFailed'
  | 'reloadLeftNoWorld';

export interface PluginReloadOutcome {
  readonly version: string;
}

type ReloadFailureStep =
  | 'opening the world'
  | 'restoring its slice or onWorldCreate'
  | 'persistence.load (it refused its saved data)'
  | 'the probe tick';

export interface PluginToggleOutcome {
  readonly reopened: boolean;
}

function settingRowKey(plugin: string, key: string): string {
  return `${plugin}/${key}`;
}

interface PendingSwitch {
  readonly toId: string;
  readonly toName: string;
  secondsRemaining: number;
  readonly timer: NodeJS.Timeout;
  readonly requesterId: string | null;
}

export class WorldManager {
  private readonly deps: WorldManagerDeps;
  private session: WorldSession | null = null;
  private bridge: RoomBridge | null = null;
  private pending: PendingSwitch | null = null;

  constructor(deps: WorldManagerDeps) {
    this.deps = deps;
  }

  get current(): WorldSession | null {
    return this.session;
  }

  get activeId(): string | null {
    return this.session?.id ?? null;
  }

  get pendingSwitch(): WorldSwitchStatus | null {
    if (this.pending === null) return null;
    return {
      toId: this.pending.toId,
      toName: this.pending.toName,
      secondsRemaining: this.pending.secondsRemaining,
    };
  }

  attachRoom(bridge: RoomBridge): void {
    this.bridge = bridge;
    this.session?.world.setSink(bridge.sink);
  }

  detachRoom(nullSink: MessageSink): void {
    this.bridge = null;
    this.session?.world.setSink(nullSink);
  }

  tick(dt: number): void {
    this.session?.host.tick(dt);
  }

  snapshotIfDirty(options?: SnapshotOptions): boolean {
    if (this.session === null) return false;
    return snapshotIfDirty(this.session, options);
  }

  loadFromPointer(): boolean {
    const id = this.deps.registry.readActive();
    if (id === null) return false;
    try {
      this.openInto(id);
      return true;
    } catch (error) {
      logError(`could not load world "${id}" from the active pointer`, error);
      return false;
    }
  }

  createWorld(name: string, worldSize: number, difficulty: number): string | null {
    const id = this.deps.registry.uniqueIdFor(name);
    if (id === null) return null;
    createWorldFile(this.deps, id, name, worldSize, difficulty);
    return id;
  }

  requestLoad(
    id: string,
    requesterId?: string,
  ): { mode: 'immediate' | 'countdown'; secondsRemaining: number } | LoadRefusal {
    if (!this.deps.registry.has(id)) return 'unknownWorld';
    if (this.session?.id === id) return 'alreadyActive';
    if (this.pending !== null) return 'switchInProgress';

    const countdown = this.deps.switchCountdownS;
    const others = this.bridge?.clientCount() ?? 0;
    if (countdown <= 0 || others <= CLIENTS_ABOVE_WHICH_TO_ANNOUNCE) {
      try {
        this.openInto(id);
      } catch (error) {
        logError(`loading world "${id}" failed`, error);
        return 'failed';
      }
      return { mode: 'immediate', secondsRemaining: 0 };
    }

    this.announceSwitch(id, countdown, requesterId ?? null);
    return { mode: 'countdown', secondsRemaining: countdown };
  }

  reopen(): true | ReopenRefusal {
    if (this.session === null) return 'noWorldLoaded';
    if (this.pending !== null) return 'switchInProgress';
    const id = this.session.id;
    try {
      this.openInto(id);
    } catch (error) {
      logError(`reopening world "${id}" failed`, error);
      return 'failed';
    }
    return true;
  }

  get installedPluginNames(): readonly string[] {
    return this.deps.plugins.list.map((loaded) => loaded.plugin.name);
  }

  get installedPluginVersions(): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const loaded of this.deps.plugins.list) versions[loaded.plugin.name] = loaded.version;
    return versions;
  }

  disabledPluginsFor(worldId: string): readonly string[] | null {
    if (!this.deps.registry.has(worldId)) return null;
    if (this.session?.id === worldId) return this.session.store.disabledPlugins();
    const store = this.deps.registry.openStore(worldId, this.deps.config.snapshotRetention);
    try {
      return store.disabledPlugins();
    } finally {
      store.close();
    }
  }

  setPluginEnabled(
    worldId: string,
    pluginName: string,
    enabled: boolean,
  ): PluginToggleOutcome | PluginToggleRefusal {
    if (!this.deps.registry.has(worldId)) return 'unknownWorld';
    if (!this.installedPluginNames.includes(pluginName)) return 'unknownPlugin';

    const alreadyDisabled = this.disabledPluginsFor(worldId)?.includes(pluginName) ?? false;
    if (alreadyDisabled === !enabled) return { reopened: false };

    return this.applyWorldConfiguration(
      worldId,
      (store) => {
        store.setPluginEnabled(pluginName, enabled);
      },
      `plugin "${pluginName}" is now ${enabled ? 'enabled' : 'disabled'} for world "${worldId}"`,
      `could not record plugin "${pluginName}" for world "${worldId}"`,
    );
  }

  pluginSettingsFor(worldId: string): WorldPluginSetting[] | null {
    if (!this.deps.registry.has(worldId)) return null;
    const stored = this.storedSettings(worldId);
    const listing: WorldPluginSetting[] = [];
    for (const { plugin } of this.deps.plugins.list) {
      for (const declaration of plugin.settings ?? []) {
        listing.push({
          plugin: plugin.name,
          key: declaration.key,
          values: [...declaration.values],
          value: stored[settingRowKey(plugin.name, declaration.key)] ?? declaration.defaultValue,
        });
      }
    }
    return listing;
  }

  get pluginActions(): WorldPluginAction[] {
    const listing: WorldPluginAction[] = [];
    for (const { plugin } of this.deps.plugins.list) {
      for (const declaration of plugin.actions ?? []) {
        listing.push({
          plugin: plugin.name,
          key: declaration.key,
          label: declaration.label,
          description: declaration.description,
          ...(plugin.archetype === undefined ? {} : { archetype: plugin.archetype }),
        });
      }
    }
    return listing;
  }

  actPlugin(
    pluginName: string,
    key: string,
    site: PluginActionSite,
  ): PluginActionOutcome | PluginActionRefusal {
    const session = this.session;
    if (session === null) return 'noWorldLoaded';
    return session.host.invokeAction(pluginName, key, site);
  }

  setPluginSetting(
    worldId: string,
    pluginName: string,
    key: string,
    value: string,
  ): PluginToggleOutcome | PluginSettingRefusal {
    if (!this.deps.registry.has(worldId)) return 'unknownWorld';
    const declaring = this.deps.plugins.find(pluginName);
    if (declaring === undefined) return 'unknownPlugin';
    const declaration = declaring.plugin.settings?.find((candidate) => candidate.key === key);
    if (declaration === undefined) return 'unknownSetting';
    if (!declaration.values.includes(value)) return 'unknownSetting';

    const stored = this.storedSettings(worldId);
    if (stored[settingRowKey(pluginName, key)] === value) return { reopened: false };

    return this.applyWorldConfiguration(
      worldId,
      (store) => {
        store.setPluginSetting(pluginName, key, value);
      },
      `plugin "${pluginName}" setting "${key}" is now "${value}" for world "${worldId}"`,
      `could not record plugin "${pluginName}" setting "${key}" for world "${worldId}"`,
    );
  }

  async reloadPlugin(name: string): Promise<PluginReloadOutcome | PluginReloadRefusal> {
    const previous = this.deps.plugins.find(name);
    if (previous === undefined) return 'unknownPlugin';
    const refusal = this.reloadPrecondition();
    if (refusal !== null) return refusal;

    let replacement: LoadedPlugin;
    try {
      replacement = await reimportPlugin(this.deps.config.pluginsDir, previous.directory);
    } catch (error) {
      logError(`reloading plugin "${name}" failed at import; it keeps its previous build`, error);
      return 'reloadFailed';
    }
    if (replacement.plugin.name !== name) {
      logError(
        `reloading plugin "${name}" failed: plugins/${previous.directory} now calls itself ` +
          `"${replacement.plugin.name}". It keeps its previous build.`,
      );
      return 'reloadFailed';
    }

    const afterImport = this.reloadPrecondition();
    if (afterImport !== null) return afterImport;
    const id = this.activeId;
    if (id === null) return 'noWorldLoaded';

    const failure = this.installAndProbe(id, replacement);
    if (failure === null) {
      this.announceBuildIdentity();
      logInfo(`plugin "${name}" reloaded in place as v${replacement.version}`);
      return { version: replacement.version };
    }

    logError(
      `reloading plugin "${name}" failed at ${failure} — rolling back to v${previous.version}`,
    );
    const rolledBack = this.installAndProbe(id, previous, true);
    if (rolledBack !== null) {
      logError(`rolling plugin "${name}" back to v${previous.version} also failed at ${rolledBack}`);
    }
    if (this.session === null) {
      logError(
        `reloading plugin "${name}" left no world loaded — world "${id}" could not be reopened ` +
          `over either build; load a world again`,
      );
      this.announceWorldUnloaded();
      return 'reloadLeftNoWorld';
    }
    return 'reloadFailed';
  }

  private announceWorldUnloaded(): void {
    if (this.session !== null) {
      logWarn(
        `refusing to announce an unload while world "${this.session.id}" is live — ` +
          `this is a core bug, not a world state`,
      );
      return;
    }
    this.broadcast('worldUnloaded', { type: 'worldUnloaded' });
  }

  private reloadPrecondition(): PluginReloadRefusal | null {
    if (this.session === null) return 'noWorldLoaded';
    if (this.pending !== null) return 'switchInProgress';
    return null;
  }

  private installAndProbe(
    id: string,
    build: LoadedPlugin,
    rollingBack = false,
  ): ReloadFailureStep | null {
    const name = build.plugin.name;
    this.deps.plugins.replace(build);

    try {
      this.openInto(id);
    } catch (error) {
      logError(`opening world "${id}" over ${rollingBack ? 'the old' : 'the new'} plugin failed`, error);
      return 'opening the world';
    }

    const session = this.session;
    if (session === null) return 'opening the world';

    if (session.host.faultCount(name) > 0) return 'restoring its slice or onWorldCreate';
    if (session.host.isSliceParked(name)) return 'persistence.load (it refused its saved data)';

    session.host.tick(1 / this.deps.config.tickHz);
    if (session.host.faultCount(name) > 0) return 'the probe tick';
    return null;
  }

  private announceBuildIdentity(): void {
    const before = buildIdentity();
    const after = rebindBuildIdentity(this.deps.plugins.list);
    if (after === before) return;

    const session = this.session;
    if (session === null) return;

    for (const player of this.bridge?.players() ?? []) {
      session.world.sendTo(player.id, buildJoinSnapshot(session.world, session.host, player.token));
    }
  }

  private storedSettings(worldId: string): Record<string, string> {
    const rows =
      this.session?.id === worldId
        ? this.session.store.pluginSettings()
        : this.withStore(worldId, (store) => store.pluginSettings());
    const flat: Record<string, string> = {};
    for (const row of rows) flat[settingRowKey(row.plugin, row.key)] = row.value;
    return flat;
  }

  private withStore<T>(worldId: string, read: (store: SnapshotStore) => T): T {
    const store = this.deps.registry.openStore(worldId, this.deps.config.snapshotRetention);
    try {
      return read(store);
    } finally {
      store.close();
    }
  }

  private applyWorldConfiguration(
    worldId: string,
    write: (store: SnapshotStore) => void,
    appliedLog: string,
    failureLog: string,
  ): PluginToggleOutcome | PluginToggleRefusal {
    const live = this.session?.id === worldId;
    if (live && this.pending !== null) return 'switchInProgress';

    try {
      if (live && this.session !== null) write(this.session.store);
      else this.withStore(worldId, write);
    } catch (error) {
      logError(failureLog, error);
      return 'failed';
    }

    logInfo(appliedLog);
    if (!live) return { reopened: false };

    const reopened = this.reopen();
    if (reopened !== true) return reopened === 'noWorldLoaded' ? 'failed' : reopened;
    return { reopened: true };
  }

  cancelSwitch(): boolean {
    if (this.pending === null) return false;
    const { toId, toName, timer } = this.pending;
    clearInterval(timer);
    this.pending = null;
    this.broadcast('worldSwitchNotice', {
      type: 'worldSwitchNotice',
      toId,
      toName,
      secondsRemaining: 0,
      cancelled: true,
    });
    logInfo(`world switch to "${toId}" was cancelled`);
    return true;
  }

  unload(): boolean {
    if (this.session === null) return false;
    const closing = this.session;
    this.session = null;
    try {
      closeSession(closing);
    } catch (error) {
      logError(`saving world "${closing.id}" while unloading it failed`, error);
    }
    this.deps.registry.writeActive(null);
    this.announceWorldUnloaded();
    logInfo(`world "${closing.id}" unloaded; no world is live`);
    return true;
  }

  shutdown(): boolean {
    if (this.session === null) return false;
    this.cancelSwitch();
    const closing = this.session;
    this.session = null;
    return closeSession(closing);
  }

  private openInto(id: string): void {
    const outgoing = this.session;

    const players: readonly Player[] = this.bridge?.players() ?? [];

    if (outgoing !== null) {
      try {
        snapshotIfDirty(outgoing);
      } catch (error) {
        logError(`refusing to switch: could not save world "${outgoing.id}"`, error);
        throw error;
      }
    }

    this.session = null;
    if (outgoing !== null) {
      try {
        releaseSession(outgoing);
      } catch (error) {
        logWarn(`closing world "${outgoing.id}" reported: ${String(error)}`);
      }
    }

    const incoming = openSession(this.deps, id);
    this.session = incoming;
    this.deps.registry.writeActive(id);

    if (this.bridge !== null) incoming.world.setSink(this.bridge.sink);

    for (const player of players) {
      incoming.world.addPlayer(player);
      applyInitialUnlockForToken(incoming.world, player.token);
    }

    for (const player of players) {
      incoming.world.sendTo(
        player.id,
        buildJoinSnapshot(incoming.world, incoming.host, player.token),
      );
    }
    for (const player of players) {
      incoming.host.playerJoined(player);
    }

    logInfo(
      `world "${id}" is live (${incoming.world.size}², "${incoming.world.name}")` +
        (outgoing === null ? '' : ` — previous world "${outgoing.id}" saved and closed`),
    );
  }

  private announceSwitch(id: string, seconds: number, requesterId: string | null): void {
    const summary = this.deps.registry.summaryFor(id, this.activeId);
    const toName = summary?.name ?? id;

    const tick = (): void => {
      if (this.pending === null) return;
      this.pending.secondsRemaining -= 1;

      if (this.pending.secondsRemaining > 0) {
        this.broadcast('worldSwitchNotice', {
          type: 'worldSwitchNotice',
          toId: this.pending.toId,
          toName: this.pending.toName,
          secondsRemaining: this.pending.secondsRemaining,
        });
        return;
      }

      clearInterval(this.pending.timer);
      const { toId: target, toName, requesterId } = this.pending;
      this.pending = null;

      this.broadcast('worldSwitchNotice', {
        type: 'worldSwitchNotice',
        toId: target,
        toName,
        secondsRemaining: 0,
      });

      try {
        this.openInto(target);
      } catch (error) {
        logError(`announced switch to "${target}" failed`, error);
        this.announceWorldUnloaded();
        if (requesterId !== null) {
          this.sendTo(requesterId, 'worldAdminResult', {
            type: 'worldAdminResult',
            action: 'load' as const,
            ok: false,
            refused: 'failed' as const,
          });
        }
      }
    };

    const timer = setInterval(tick, MILLISECONDS_PER_SECOND);
    this.pending = { toId: id, toName, secondsRemaining: seconds, timer, requesterId };

    this.broadcast('worldSwitchNotice', {
      type: 'worldSwitchNotice',
      toId: id,
      toName,
      secondsRemaining: seconds,
    });
    logInfo(`world switch to "${id}" announced; ${seconds}s`);
  }

  private broadcast(type: string, payload: unknown): void {
    this.bridge?.sink.broadcast(type, payload);
  }

  private sendTo(playerId: string, type: string, payload: unknown): void {
    this.bridge?.sink.sendTo(playerId, type, payload);
  }
}
