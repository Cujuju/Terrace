import type { CellDiff, SculptIntent } from '@terrace/shared';
import { logError, logInfo, logWarn } from '../log.ts';
import type { Player } from '../player.ts';
import type { TerrainChangeListener } from '../world/sculpt-service.ts';
import type { World } from '../world/world.ts';
import { timePhase, timePluginPhase } from '../tick-timing.ts';
import { readSlice, wrapSlice } from './slice-envelope.ts';
import {
  ALLOW,
  type IntentVerdict,
  type LoadedPlugin,
  type PluginActionOutcome,
  type PluginActionSite,
  type SiblingModule,
  type TerracePlugin,
  type WorldApi,
} from './types.ts';
import {
  NO_PLUGIN_SETTINGS,
  type ChunkUnlockListener,
  type PluginSettings,
  type RevocableWorldApi,
  type SiblingResolver,
  type WorldEventListener,
  createWorldApi,
  namespacedMessageType,
} from './world-api.ts';

export const MAX_TERRAIN_CHANGE_DEPTH = 4;

export const MAX_WORLD_EVENT_DEPTH = 4;

export const SECOND_LOOK_MODIFY_REASON = 'plugin-modified-on-second-look';

interface PluginEntry {
  readonly loaded: LoadedPlugin;
  readonly api: WorldApi;
  readonly revoke: () => void;
}

export class PluginHost implements TerrainChangeListener, ChunkUnlockListener, WorldEventListener {
  private readonly installed: readonly PluginEntry[];
  private readonly entries: readonly PluginEntry[];
  private readonly world: World;
  private handlersByType: Map<string, (player: Player, payload: unknown) => void> | null = null;
  private dormantSlices: Record<string, unknown> = {};
  private writeSuppressed: Set<string> = new Set();
  private readonly faults = new Map<string, number>();
  private terrainChangeDepth = 0;
  private worldEventDepth = 0;

  constructor(
    world: World,
    plugins: readonly LoadedPlugin[],
    enabledNames?: ReadonlySet<string>,
    settingsByPlugin: Readonly<Record<string, PluginSettings>> = {},
  ) {
    this.world = world;
    const siblingModules = new Map<string, SiblingModule>();
    for (const loaded of plugins) {
      const { name } = loaded.plugin;
      if (enabledNames !== undefined && !enabledNames.has(name)) continue;
      siblingModules.set(name, loaded.exports);
    }
    const resolveSibling: SiblingResolver = (name) => siblingModules.get(name) ?? null;
    this.installed = plugins.map((loaded) => {
      const { name } = loaded.plugin;
      const revocable: RevocableWorldApi = createWorldApi(
        world,
        this,
        name,
        Object.hasOwn(settingsByPlugin, name) ? settingsByPlugin[name] : NO_PLUGIN_SETTINGS,
        resolveSibling,
      );
      return { loaded, api: revocable.api, revoke: revocable.revoke };
    });
    this.entries =
      enabledNames === undefined
        ? this.installed
        : this.installed.filter((entry) => enabledNames.has(entry.loaded.plugin.name));
  }

  get pluginNames(): readonly string[] {
    return this.entries.map((entry) => entry.loaded.plugin.name);
  }

  get installedPluginNames(): readonly string[] {
    return this.installed.map((entry) => entry.loaded.plugin.name);
  }

  private safely<T>(plugin: TerracePlugin, hook: string, call: () => T): T | undefined {
    try {
      return call();
    } catch (error) {
      this.recordFault(plugin, hook, error);
      return undefined;
    }
  }

  private recordFault(plugin: TerracePlugin, hook: string, error: unknown): void {
    this.faults.set(plugin.name, (this.faults.get(plugin.name) ?? 0) + 1);
    logError(`plugin "${plugin.name}" threw in ${hook}`, error);
  }

  faultCount(name: string): number {
    return this.faults.get(name) ?? 0;
  }

  isSliceParked(name: string): boolean {
    return this.writeSuppressed.has(name);
  }

  worldCreate(): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onWorldCreate) continue;
      this.safely(plugin, 'onWorldCreate', () => plugin.onWorldCreate?.(api));
    }
  }

  closeWorld(): void {
    for (const { loaded, api } of this.installed) {
      const { plugin } = loaded;
      if (!plugin.onWorldClose) continue;
      this.safely(plugin, 'onWorldClose', () => plugin.onWorldClose?.(api));
    }
  }

  revokeApis(): void {
    for (const { revoke } of this.installed) revoke();
  }

  tick(dt: number): void {
    timePhase('clock', () => this.world.advanceClock(dt));
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onTick) continue;
      timePluginPhase(plugin.name, () => {
        this.safely(plugin, 'onTick', () => plugin.onTick?.(api, dt));
      });
    }
  }

  runIntent(intent: SculptIntent, player: Player): IntentVerdict {
    let current = intent;
    let modified = false;
    const allowed: PluginEntry[] = [];

    for (const entry of this.entries) {
      const { loaded, api } = entry;
      const { plugin } = loaded;
      if (!plugin.onIntent) continue;

      const verdict = this.safely(plugin, 'onIntent', () =>
        plugin.onIntent?.(current, { player, world: api }),
      );
      if (!verdict || verdict.kind === 'allow') {
        allowed.push(entry);
        continue;
      }

      if (verdict.kind === 'deny') return verdict;

      current = verdict.intent;
      modified = true;
    }

    if (!modified) return ALLOW;

    for (const { loaded, api } of allowed) {
      const { plugin } = loaded;
      const verdict = this.safely(plugin, 'onIntent', () =>
        plugin.onIntent?.(current, { player, world: api }),
      );
      if (!verdict || verdict.kind === 'allow') continue;
      if (verdict.kind === 'deny') return verdict;

      this.recordFault(
        plugin,
        'onIntent',
        new Error(`returned modify on the second look at an already-modified intent`),
      );
      return { kind: 'deny', reason: SECOND_LOOK_MODIFY_REASON };
    }

    return { kind: 'modify', intent: current };
  }

  notifyIntentApplied(intent: SculptIntent, player: Player, diff: readonly CellDiff[]): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onIntentApplied) continue;
      this.safely(plugin, 'onIntentApplied', () =>
        plugin.onIntentApplied?.(intent, { player, world: api }, diff),
      );
    }
  }

  notifyIntentDenied(intent: SculptIntent, player: Player): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onIntentDenied) continue;
      this.safely(plugin, 'onIntentDenied', () =>
        plugin.onIntentDenied?.(intent, { player, world: api }),
      );
    }
  }

  notifyTerrainChanged(diff: readonly CellDiff[], sculptorToken?: string): void {
    if (this.terrainChangeDepth >= MAX_TERRAIN_CHANGE_DEPTH) {
      logError(
        `terrain-change cascade exceeded depth ${MAX_TERRAIN_CHANGE_DEPTH}; ` +
          'a plugin is sculpting from onTerrainChanged without a stop condition',
      );
      return;
    }

    this.terrainChangeDepth++;
    try {
      for (const { loaded, api } of this.entries) {
        const { plugin } = loaded;
        if (!plugin.onTerrainChanged) continue;
        this.safely(plugin, 'onTerrainChanged', () =>
          plugin.onTerrainChanged?.(api, diff, sculptorToken),
        );
      }
    } finally {
      this.terrainChangeDepth--;
    }
  }

  notifyChunkUnlockedForToken(token: string, cx: number, cy: number): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onChunkUnlockedForToken) continue;
      this.safely(plugin, 'onChunkUnlockedForToken', () =>
        plugin.onChunkUnlockedForToken?.(api, token, cx, cy),
      );
    }
  }

  notifyWorldEvent(event: string, payload: unknown): void {
    if (this.worldEventDepth >= MAX_WORLD_EVENT_DEPTH) {
      logError(
        `world-event cascade exceeded depth ${MAX_WORLD_EVENT_DEPTH} at "${event}"; ` +
          'a plugin is emitting from onWorldEvent without a stop condition',
      );
      return;
    }

    this.worldEventDepth++;
    try {
      for (const { loaded, api } of this.entries) {
        const { plugin } = loaded;
        if (!plugin.onWorldEvent) continue;
        this.safely(plugin, 'onWorldEvent', () => plugin.onWorldEvent?.(api, event, payload));
      }
    } finally {
      this.worldEventDepth--;
    }
  }

  playerJoined(player: Player): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onPlayerJoin) continue;
      this.safely(plugin, 'onPlayerJoin', () => plugin.onPlayerJoin?.(api, player));
    }
  }

  playerLeft(player: Player): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onPlayerLeave) continue;
      this.safely(plugin, 'onPlayerLeave', () => plugin.onPlayerLeave?.(api, player));
    }
  }

  handlerFor(type: string): ((player: Player, payload: unknown) => void) | undefined {
    this.handlersByType ??= new Map(this.messageHandlers());
    return this.handlersByType.get(type);
  }

  invokeAction(
    pluginName: string,
    key: string,
    site: PluginActionSite,
  ): PluginActionOutcome | 'unknownPlugin' | 'unknownAction' | 'pluginDisabled' | 'failed' {
    const installed = this.installed.find((entry) => entry.loaded.plugin.name === pluginName);
    if (installed === undefined) return 'unknownPlugin';
    const { plugin } = installed.loaded;
    if (!plugin.actions?.some((declaration) => declaration.key === key)) return 'unknownAction';
    if (!this.entries.includes(installed)) return 'pluginDisabled';
    if (plugin.onAction === undefined) return 'unknownAction';

    const last = this.world.size - 1;
    const clamped: PluginActionSite = {
      x: Math.min(last, Math.max(0, site.x)),
      y: Math.min(last, Math.max(0, site.y)),
    };
    const outcome = this.safely(plugin, `onAction.${key}`, () =>
      plugin.onAction!(installed.api, key, clamped),
    );
    return outcome ?? 'failed';
  }

  messageHandlers(): Array<[string, (player: Player, payload: unknown) => void]> {
    const handlers: Array<[string, (player: Player, payload: unknown) => void]> = [];
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.messages) continue;
      for (const [type, handler] of Object.entries(plugin.messages)) {
        handlers.push([
          namespacedMessageType(plugin.name, type),
          (player, payload) => {
            this.safely(plugin, `messages.${type}`, () => handler(api, player, payload));
          },
        ]);
      }
    }
    return handlers;
  }

  collectPersistence(): Record<string, unknown> {
    const slices: Record<string, unknown> = { ...this.dormantSlices };
    for (const { loaded } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.persistence) continue;
      if (this.writeSuppressed.has(plugin.name)) continue;
      const data = this.safely(plugin, 'persistence.save', () => plugin.persistence?.save());
      if (data !== undefined) slices[plugin.name] = wrapSlice(plugin.persistence.version, data);
    }
    return slices;
  }

  restorePersistence(slices: Record<string, unknown>): void {
    const installed = new Set(this.installedPluginNames);
    const enabled = new Set(this.pluginNames);
    this.dormantSlices = {};
    this.writeSuppressed = new Set();
    for (const name of Object.keys(slices)) {
      if (!installed.has(name)) {
        logInfo(`snapshot contains data for plugin "${name}", which is not installed — ignored`);
        continue;
      }
      if (enabled.has(name)) continue;
      this.dormantSlices[name] = slices[name];
      logInfo(`plugin "${name}" is disabled here; its saved data is being kept as-is`);
    }

    for (const { loaded } of this.entries) {
      const { plugin } = loaded;
      const slice = plugin.persistence;
      if (!slice) continue;
      if (!Object.hasOwn(slices, plugin.name)) continue;

      const stored = readSlice(slices[plugin.name]);
      if (stored.version > slice.version) {
        this.park(plugin.name, slices[plugin.name]);
        logWarn(
          `plugin "${plugin.name}" has saved data from a newer build ` +
            `(version ${stored.version}; this build writes ${slice.version}). ` +
            'It is being kept exactly as it is and this plugin is running with no ' +
            'saved state — put the newer build back to use it again.',
        );
        continue;
      }

      let parkReason: 'refused' | 'threw while loading' | null = null;
      try {
        if (slice.load(stored.data, stored.version) === 'refuse') parkReason = 'refused';
      } catch (error) {
        parkReason = 'threw while loading';
        this.recordFault(plugin, 'persistence.load', error);
      }
      if (parkReason !== null) {
        this.park(plugin.name, slices[plugin.name]);
        logWarn(
          `plugin "${plugin.name}" ${parkReason} its saved data (written under version ` +
            `${stored.version}). It is being kept exactly as it is and this plugin ` +
            'is running with no saved state.',
        );
      }
    }
  }

  private park(name: string, stored: unknown): void {
    this.dormantSlices[name] = stored;
    this.writeSuppressed.add(name);
  }
}
