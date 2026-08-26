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
import {
  type ChunkUnlockListener,
  type RevocableWorldApi,
  type WorldEventListener,
  createWorldApi,
  namespacedMessageType,
} from './world-api.ts';

/**
 * How deep onTerrainChanged → plugin sculpt → onTerrainChanged is allowed to
 * nest. A plugin that sculpts in response to terrain changes is legitimate
 * (erosion, landslides); one that does so unconditionally is an infinite loop
 * that would hang the tick and take the process with it. 4 leaves room for a
 * genuine cascade between two or three plugins while still terminating.
 */
export const MAX_TERRAIN_CHANGE_DEPTH = 4;

/**
 * How deep onWorldEvent → plugin emitEvent → onWorldEvent may nest — the same
 * hazard MAX_TERRAIN_CHANGE_DEPTH guards on the terrain side, with the same
 * bound for the same reason: a two- or three-plugin reaction chain is
 * legitimate, an unconditional emit-from-handler is an infinite loop that
 * would take the tick down with it.
 */
export const MAX_WORLD_EVENT_DEPTH = 4;

interface PluginEntry {
  readonly loaded: LoadedPlugin;
  readonly api: WorldApi;
  /** Unbinds this entry's view from the World; see RevocableWorldApi. */
  readonly revoke: () => void;
}

export class PluginHost implements TerrainChangeListener, ChunkUnlockListener, WorldEventListener {
  /**
   * EVERY INSTALLED PLUGIN, enabled or not — the set the close path fans out
   * over and the set whose views get revoked.
   *
   * Separate from `entries` (the ENABLED subset, below) for issue #167's
   * reason: the plugin that most needs to hear its world close is the one
   * being disabled for the next world, and that is exactly the one a fan-out
   * over the enabled subset would skip.
   */
  private readonly installed: readonly PluginEntry[];
  /**
   * The plugins that participate in this world: every hook below iterates
   * THIS list, in load order.
   *
   * Identical to `installed` today, because every discovered plugin is
   * enabled. Per-world enablement (#165) narrows it by passing `enabledNames`
   * to the constructor — and because the close path reads `installed`
   * instead, narrowing it cannot silently drop the close fan-out.
   */
  private readonly entries: readonly PluginEntry[];
  /** The world this host drives — its clock advances on every tick(). */
  private readonly world: World;
  /** Lazily-built message-type index; see handlerFor. */
  private handlersByType: Map<string, (player: Player, payload: unknown) => void> | null = null;
  /**
   * Snapshot slices belonging to plugins that are INSTALLED BUT DISABLED for
   * this world, captured at restore and re-emitted verbatim by every save.
   *
   * WITHOUT THIS, DISABLING A PLUGIN DESTROYS ITS STATE. `collectPersistence`
   * asks the ENABLED plugins for their slices, so a disabled plugin
   * contributes nothing and the very next snapshot is written without the
   * chronicle/forest/village it had — turning a reversible toggle into an
   * irreversible erasure one save later. Carrying the bytes through untouched
   * is what makes "disable, look around, re-enable" restore what was there.
   *
   * Only INSTALLED plugins are held. A slice whose plugin this build does not
   * have at all keeps the older behaviour (logged and dropped in
   * `restorePersistence`): its owner is gone from the build, so there is no
   * toggle to put it back and nothing that could ever read it again.
   */
  private dormantSlices: Record<string, unknown> = {};
  private terrainChangeDepth = 0;
  private worldEventDepth = 0;

  /**
   * `plugins` is the INSTALLED set; `enabledNames`, when given, names the
   * subset that participates in this world (absent = all of them, which is
   * the only case that exists until #165 lands).
   */
  constructor(world: World, plugins: readonly LoadedPlugin[], enabledNames?: ReadonlySet<string>) {
    this.world = world;
    // The WorldApi handed to a plugin routes edits back through this host, so
    // a plugin's own sculpt notifies every plugin (including itself) exactly
    // like a player's would.
    //
    // Built for every INSTALLED plugin, disabled ones included: a view costs a
    // closure, and it is what lets `closeWorld` hand a disabled plugin the
    // same argument its `onWorldCreate` counterpart would have taken.
    this.installed = plugins.map((loaded) => {
      const revocable: RevocableWorldApi = createWorldApi(world, this, loaded.plugin.name);
      return { loaded, api: revocable.api, revoke: revocable.revoke };
    });
    this.entries =
      enabledNames === undefined
        ? this.installed
        : this.installed.filter((entry) => enabledNames.has(entry.loaded.plugin.name));
  }

  /** Names of the plugins participating in this world, in load order. */
  get pluginNames(): readonly string[] {
    return this.entries.map((entry) => entry.loaded.plugin.name);
  }

  /** Names of every INSTALLED plugin, enabled or not, in load order. */
  get installedPluginNames(): readonly string[] {
    return this.installed.map((entry) => entry.loaded.plugin.name);
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

  /**
   * The counterpart of `worldCreate`, called once by `closeSession` as the
   * world stops being loaded — a plugin's chance to drop whatever it holds of
   * this world (issue #167).
   *
   * OVER EVERY INSTALLED PLUGIN, not just the enabled ones: see `installed`.
   * The view handed over is still live, so a plugin may read the world one
   * last time; `revokeApis` runs strictly after this returns.
   */
  closeWorld(): void {
    for (const { loaded, api } of this.installed) {
      const { plugin } = loaded;
      if (!plugin.onWorldClose) continue;
      this.safely(plugin, 'onWorldClose', () => plugin.onWorldClose?.(api));
    }
  }

  /**
   * Unbinds every view this host handed out from the World (issue #164), so a
   * plugin that stashed one at module scope pins a small stub rather than a
   * whole heightmap. Any later use of one of those views throws — see
   * createWorldApi.
   *
   * Called by `closeSession` AFTER `closeWorld`, and never before: a plugin's
   * own close hook is allowed to read the world it is losing.
   */
  revokeApis(): void {
    for (const { revoke } of this.installed) revoke();
  }

  /**
   * Fixed-rate sim step; `dt` is the constant tick period in seconds.
   *
   * ADVANCES THE WORLD CLOCK FIRST, and it lives here rather than one layer up
   * in WorldManager for a contract reason: this is the method that runs the
   * simulation, so there must be no way to run the simulation without time
   * passing. With the advance in the manager, every other driver of a host —
   * every plugin's own test suite — ticked plugins against a frozen clock, and
   * a plugin that reads WorldApi.simMillis silently saw time stand still. That
   * is the same class of defect as a plugin keeping its own private clock, one
   * layer up.
   *
   * Before the plugins run, so every plugin in a tick reads the same time, and
   * reads it as the time it is now rather than one tick ago.
   */
  tick(dt: number): void {
    this.world.advanceClock(dt);
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onTick) continue;
      this.safely(plugin, 'onTick', () => plugin.onTick?.(api, dt));
    }
  }

  /**
   * THE VERDICT PHASE of the two-phase intent pipeline (design §3.5; split
   * from a single side-effecting pass for issue #19 — see onIntent's own doc
   * comment in types.ts for the full contract this enforces). Each plugin
   * sees the intent as the previous plugin left it:
   *   - deny   → chain stops immediately, first deny wins;
   *   - modify → the replacement intent flows on to the next plugin;
   *   - allow / no hook / a throw → intent passes through unchanged.
   *
   * A plugin that throws is treated as ALLOW rather than DENY: a buggy
   * extension must not be able to silently make the world unsculptable. The
   * failure is logged loudly instead.
   *
   * THIS METHOD ALONE NEVER APPLIES ANYTHING OR NOTIFIES A PLUGIN'S EFFECT
   * HOOK: the caller (intent/pipeline.ts) only reaches applyServerSculpt, and
   * therefore only calls notifyIntentApplied below, once every plugin here
   * has returned allow or modify — never on a deny. That ordering, not
   * anything inside this method, is what makes onIntentApplied's "effects run
   * only after unanimous allow" guarantee hold.
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
   * THE EFFECT PHASE of the two-phase intent pipeline (issue #19). The caller
   * (intent/pipeline.ts) invokes this exactly once per applied player intent,
   * strictly after runIntent above returned allow/modify for every plugin AND
   * core actually applied the edit — never on a deny, never on a re-validation
   * failure. Fan-out only; no verdict to compose, so unlike runIntent every
   * plugin's onIntentApplied always runs (a throw is logged and skipped, same
   * as every other hook — see `safely`).
   *
   * `intent` is the EFFECTIVE intent (post any `modify`) and `diff` is the
   * full server-side diff the edit produced — see onIntentApplied's own doc
   * comment in types.ts for why those are the right things to hand over.
   */
  notifyIntentApplied(intent: SculptIntent, player: Player, diff: readonly CellDiff[]): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onIntentApplied) continue;
      this.safely(plugin, 'onIntentApplied', () =>
        plugin.onIntentApplied?.(intent, { player, world: api }, diff),
      );
    }
  }

  /**
   * Fan-out after a REFUSED intent (interceptor deny, or a plugin rewrite
   * that failed re-validation) — the deny-side twin of notifyIntentApplied,
   * so a plugin whose client half predicted something on send can push the
   * authoritative state back to the sender. See TerracePlugin.onIntentDenied.
   */
  notifyIntentDenied(intent: SculptIntent, player: Player): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onIntentDenied) continue;
      this.safely(plugin, 'onIntentDenied', () =>
        plugin.onIntentDenied?.(intent, { player, world: api }),
      );
    }
  }

  /**
   * Fan-out after an applied edit, with the full server-side diff. Guarded
   * against runaway re-entrancy (see MAX_TERRAIN_CHANGE_DEPTH).
   *
   * `sculptorToken` (issue #17) is forwarded to every plugin verbatim — see
   * TerracePlugin.onTerrainChanged's doc comment for what it means and why
   * it can be absent.
   */
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

  /**
   * Fan-out for the targeted-refresh hook (issue #18). Called by world-api.ts
   * only after a REAL per-token unlock (never a no-op re-unlock), so a
   * throwing or slow plugin here costs at most one unlock event, not a
   * steady-state tax.
   */
  notifyChunkUnlockedForToken(token: string, cx: number, cy: number): void {
    for (const { loaded, api } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.onChunkUnlockedForToken) continue;
      this.safely(plugin, 'onChunkUnlockedForToken', () =>
        plugin.onChunkUnlockedForToken?.(api, token, cx, cy),
      );
    }
  }

  /**
   * Fan-out for `WorldApi.emitEvent` (2026-08-19): every plugin's
   * onWorldEvent, in load order, the emitter's own included. `event` arrives
   * here already namespaced by world-api.ts. Guarded against runaway
   * emit-from-handler cascades exactly like notifyTerrainChanged.
   */
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

  /**
   * Every namespaced client → server handler, ready for the room to register.
   * The wire type is `<plugin>:<type>`, so a plugin can never shadow a core
   * message ('sculpt') or another plugin's.
   */
  /**
   * Every namespaced message type the given plugin set defines, WITHOUT
   * needing a host — and therefore without needing a world.
   *
   * EXISTS FOR THE MULTI-WORLD ROOM (2026-08-22). A room is created once and
   * outlives every world loaded into it, so it cannot register handlers bound
   * to one host: the host is replaced on every world switch, and a handler
   * captured at room-create time would keep sculpting the world the operator
   * just left. It also has to work when NO world is loaded, which is a state
   * the server now supports and in which no host exists at all.
   *
   * So the room registers the TYPES from here (fixed for the process, because
   * the plugin set is fixed at boot) and looks the handler up per message via
   * `handlerFor` on whichever host is current.
   */
  static messageTypesFor(plugins: readonly LoadedPlugin[]): string[] {
    const types: string[] = [];
    for (const { plugin } of plugins) {
      if (!plugin.messages) continue;
      for (const type of Object.keys(plugin.messages)) {
        types.push(namespacedMessageType(plugin.name, type));
      }
    }
    return types;
  }

  /**
   * The handler for one namespaced message type on THIS host, or undefined
   * when no loaded plugin claims it. See messageTypesFor for why lookup is
   * per-message rather than bound once.
   */
  handlerFor(type: string): ((player: Player, payload: unknown) => void) | undefined {
    // Built once per host, not per message: this is on the hot path for every
    // plugin message every client sends, and the plugin set cannot change
    // during a host's lifetime.
    this.handlersByType ??= new Map(this.messageHandlers());
    return this.handlersByType.get(type);
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
    // Disabled plugins' slices ride along untouched — see `dormantSlices`.
    // Copied rather than mutated so a save can never edit the record a later
    // save has to re-emit.
    const slices: Record<string, unknown> = { ...this.dormantSlices };
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
    const installed = new Set(this.installedPluginNames);
    const enabled = new Set(this.pluginNames);
    // Recomputed from scratch on every restore — a rollback replays this with
    // an older snapshot's slices, and the dormant set must then describe THAT
    // snapshot rather than being the union of every restore so far.
    this.dormantSlices = {};
    for (const name of Object.keys(slices)) {
      if (!installed.has(name)) {
        logInfo(`snapshot contains data for plugin "${name}", which is not installed — ignored`);
        continue;
      }
      if (enabled.has(name)) continue;
      // Installed but switched off for this world: hold the bytes so the next
      // save writes them back unchanged (see `dormantSlices`).
      this.dormantSlices[name] = slices[name];
      logInfo(`plugin "${name}" is disabled here; its saved data is being kept as-is`);
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
