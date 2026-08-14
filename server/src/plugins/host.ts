// The plugin host: owns the loaded plugins, their per-plugin WorldApi views,
// and every call into plugin code.
//
// Two rules govern this file:
//   1. DETERMINISTIC ORDER. Plugins are invoked in load order (alphabetical by
//      directory — see discovery.ts) everywhere, so an intent chain or a tick
//      behaves identically on every boot and every machine.
//   2. A BROKEN PLUGIN MUST NOT TAKE THE WORLD DOWN. Every callback is wrapped;
//      a throwing plugin is logged and skipped for that call. Core is the
//      substrate — it stays up even when something built on it does not.

import type { CellDiff, SculptIntent } from '@terrace/shared';
import { logError, logInfo } from '../log.ts';
import type { Player } from '../player.ts';
import type { TerrainChangeListener } from '../world/sculpt-service.ts';
import type { World } from '../world/world.ts';
import {
  ALLOW,
  type IntentVerdict,
  type LoadedPlugin,
  type TerracePlugin,
  type WorldApi,
} from './types.ts';
import { createWorldApi, namespacedMessageType } from './world-api.ts';

/**
 * How deep onTerrainChanged → plugin sculpt → onTerrainChanged is allowed to
 * nest. A plugin that sculpts in response to terrain changes is legitimate
 * (erosion, landslides); one that does so unconditionally is an infinite loop
 * that would hang the tick and take the process with it. 4 leaves room for a
 * genuine cascade between two or three plugins while still terminating.
 */
export const MAX_TERRAIN_CHANGE_DEPTH = 4;

interface PluginEntry {
  readonly loaded: LoadedPlugin;
  readonly api: WorldApi;
}

export class PluginHost implements TerrainChangeListener {
  private readonly entries: readonly PluginEntry[];
  private terrainChangeDepth = 0;

  constructor(world: World, plugins: readonly LoadedPlugin[]) {
    // The WorldApi handed to a plugin routes edits back through this host, so
    // a plugin's own sculpt notifies every plugin (including itself) exactly
    // like a player's would.
    this.entries = plugins.map((loaded) => ({
      loaded,
      api: createWorldApi(world, this, loaded.plugin.name),
    }));
  }

  get pluginNames(): readonly string[] {
    return this.entries.map((entry) => entry.loaded.plugin.name);
  }

  /**
   * Runs a plugin callback, converting a throw into a logged skip. Returns
   * undefined when the callback threw or was not implemented.
   */
  private safely<T>(plugin: TerracePlugin, hook: string, call: () => T): T | undefined {
    try {
      return call();
    } catch (error) {
      logError(`plugin "${plugin.name}" threw in ${hook}`, error);
      return undefined;
    }
  }

  /** Called once at boot, after any snapshot has been restored. */
  worldCreate(): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onWorldCreate) continue;
      this.safely(plugin, 'onWorldCreate', () => plugin.onWorldCreate?.(api));
    }
  }

  /** Fixed-rate sim step; `dt` is the constant tick period in seconds. */
  tick(dt: number): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onTick) continue;
      this.safely(plugin, 'onTick', () => plugin.onTick?.(api, dt));
    }
  }

  /**
   * THE INTERCEPTOR CHAIN (design §3.5). Each plugin sees the intent as the
   * previous plugin left it:
   *   - deny   → chain stops immediately, first deny wins;
   *   - modify → the replacement intent flows on to the next plugin;
   *   - allow / no hook / a throw → intent passes through unchanged.
   *
   * A plugin that throws is treated as ALLOW rather than DENY: a buggy
   * extension must not be able to silently make the world unsculptable. The
   * failure is logged loudly instead.
   */
  runIntent(intent: SculptIntent, player: Player): IntentVerdict {
    let current = intent;
    let modified = false;

    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onIntent) continue;

      const verdict = this.safely(plugin, 'onIntent', () =>
        plugin.onIntent?.(current, { player, world: api }),
      );
      if (!verdict || verdict.kind === 'allow') continue;

      if (verdict.kind === 'deny') return verdict;

      current = verdict.intent;
      modified = true;
    }

    return modified ? { kind: 'modify', intent: current } : ALLOW;
  }

  /**
   * Fan-out after an applied edit, with the full server-side diff. Guarded
   * against runaway re-entrancy (see MAX_TERRAIN_CHANGE_DEPTH).
   */
  notifyTerrainChanged(diff: readonly CellDiff[]): void {
    if (this.terrainChangeDepth >= MAX_TERRAIN_CHANGE_DEPTH) {
      logError(
        `terrain-change cascade exceeded depth ${MAX_TERRAIN_CHANGE_DEPTH}; ` +
          'a plugin is sculpting from onTerrainChanged without a stop condition',
      );
      return;
    }

    this.terrainChangeDepth++;
    try {
      for (const { loaded } of this.entries) {
        const { plugin } = loaded;
        if (!plugin.onTerrainChanged) continue;
        this.safely(plugin, 'onTerrainChanged', () => plugin.onTerrainChanged?.(diff));
      }
    } finally {
      this.terrainChangeDepth--;
    }
  }

  playerJoined(player: Player): void {
    for (const { loaded } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onPlayerJoin) continue;
      this.safely(plugin, 'onPlayerJoin', () => plugin.onPlayerJoin?.(player));
    }
  }

  playerLeft(player: Player): void {
    for (const { loaded } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onPlayerLeave) continue;
      this.safely(plugin, 'onPlayerLeave', () => plugin.onPlayerLeave?.(player));
    }
  }

  /**
   * Every namespaced client → server handler, ready for the room to register.
   * The wire type is `<plugin>:<type>`, so a plugin can never shadow a core
   * message ('sculpt') or another plugin's.
   */
  messageHandlers(): Array<[string, (player: Player, payload: unknown) => void]> {
    const handlers: Array<[string, (player: Player, payload: unknown) => void]> = [];
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.messages) continue;
      for (const [type, handler] of Object.entries(plugin.messages)) {
        handlers.push([
          namespacedMessageType(plugin.name, type),
          (player, payload) => {
            // Payload is untrusted client input; plugins validate their own.
            this.safely(plugin, `messages.${type}`, () => handler(api, player, payload));
          },
        ]);
      }
    }
    return handlers;
  }

  /** Plugin slices for a snapshot, keyed by plugin name. */
  collectPersistence(): Record<string, unknown> {
    const slices: Record<string, unknown> = {};
    for (const { loaded } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.persistence) continue;
      const data = this.safely(plugin, 'persistence.save', () => plugin.persistence?.save());
      // A plugin that failed to serialize is omitted rather than persisted as
      // undefined: on restore it simply sees no slice, which is the same state
      // it gets on first ever boot.
      if (data !== undefined) slices[plugin.name] = data;
    }
    return slices;
  }

  /**
   * Restores plugin slices from a snapshot. Slices whose plugin is no longer
   * installed are ignored (and logged) rather than being an error — removing a
   * plugin must not brick an existing world.
   */
  restorePersistence(slices: Record<string, unknown>): void {
    const installed = new Set(this.pluginNames);
    for (const name of Object.keys(slices)) {
      if (!installed.has(name)) {
        logInfo(`snapshot contains data for plugin "${name}", which is not installed — ignored`);
      }
    }

    for (const { loaded } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.persistence) continue;
      if (!Object.hasOwn(slices, plugin.name)) continue;
      this.safely(plugin, 'persistence.load', () =>
        plugin.persistence?.load(slices[plugin.name]),
      );
    }
  }
}
