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
import { logError, logInfo, logWarn } from '../log.ts';
import type { Player } from '../player.ts';
import type { TerrainChangeListener } from '../world/sculpt-service.ts';
import type { World } from '../world/world.ts';
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

/**
 * Deny reason when a plugin that allowed an intent answers the second look
 * (issue #278) with `modify` instead of allow/deny. Surfaces in the pipeline's
 * `plugin-denied` outcome so a broken plugin is diagnosable from the log.
 */
export const SECOND_LOOK_MODIFY_REASON = 'plugin-modified-on-second-look';

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
  /**
   * Plugin names whose slice key THE HOST OWNS for this session, so the plugin
   * itself contributes nothing to a snapshot for it.
   *
   * THE ONE-WRITER RULE. A slice key has exactly one writer per session, and
   * parking makes the host that writer. `dormantSlices` alone cannot do this
   * for an ENABLED plugin: `collectPersistence` seeds the record from the
   * dormant map and then writes `slices[name] = data` for every enabled plugin,
   * so a parked plugin's own (empty) save would overwrite the parked bytes at
   * the very next snapshot — DEFAULT_SNAPSHOT_INTERVAL_S later, i.e. about a
   * minute — which is the exact erasure parking exists to prevent.
   *
   * Populated by `restorePersistence` for a slice written by a NEWER build than
   * this one, and for a slice the plugin itself refused. Recomputed from
   * scratch on every restore, like `dormantSlices` and for the same reason.
   */
  private writeSuppressed: Set<string> = new Set();
  /**
   * How many hook calls have THROWN, per plugin name, over this host's life.
   *
   * WHY A COUNT EXISTS AT ALL. `safely` turns a throwing plugin into a logged
   * skip, which is rule 2 of this file and must stay that way — but it also
   * means a caller cannot tell a plugin that worked from one that failed every
   * hook. The in-process reload (issue #198) is the caller that has to: a new
   * module whose `onWorldCreate` or first tick throws must be rolled back for
   * the old one rather than left running as a silent no-op. Nothing else reads
   * this, and nothing simulates differently because of it.
   *
   * Per HOST, so it starts at zero for every session — which is what lets the
   * reload read "faults since this world was built" without a reset call
   * somebody could forget.
   */
  private readonly faults = new Map<string, number>();
  private terrainChangeDepth = 0;
  private worldEventDepth = 0;

  /**
   * `plugins` is the INSTALLED set; `enabledNames`, when given, names the
   * subset that participates in this world (absent = all of them, which is
   * the only case that exists until #165 lands). `settingsByPlugin` is this
   * world's plugin_settings rows GROUPED BY PLUGIN — each view is handed its
   * own plugin's group and no other's (see WorldApi.setting); a plugin with no
   * rows, and a world nobody has configured, both read as "no settings".
   */
  constructor(
    world: World,
    plugins: readonly LoadedPlugin[],
    enabledNames?: ReadonlySet<string>,
    settingsByPlugin: Readonly<Record<string, PluginSettings>> = {},
  ) {
    this.world = world;
    // THE SESSION'S MODULE MAP, built before any view exists, from the ENABLED
    // set only: `WorldApi.sibling` answers "who is running as <name> here",
    // and a plugin the operator switched off for this world is not running —
    // even though its module is as resident as everyone else's (issue #196).
    const siblingModules = new Map<string, SiblingModule>();
    for (const loaded of plugins) {
      const { name } = loaded.plugin;
      if (enabledNames !== undefined && !enabledNames.has(name)) continue;
      siblingModules.set(name, loaded.exports);
    }
    const resolveSibling: SiblingResolver = (name) => siblingModules.get(name) ?? null;
    // The WorldApi handed to a plugin routes edits back through this host, so
    // a plugin's own sculpt notifies every plugin (including itself) exactly
    // like a player's would.
    //
    // Built for every INSTALLED plugin, disabled ones included: a view costs a
    // closure, and it is what lets `closeWorld` hand a disabled plugin the
    // same argument its `onWorldCreate` counterpart would have taken.
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
      this.recordFault(plugin, hook, error);
      return undefined;
    }
  }

  /**
   * Books one plugin fault: the counter `faultCount` reports and the one log
   * line a throw produces. Shared by `safely` and by the one call site that
   * must SEE the throw rather than have it swallowed (`restorePersistence`),
   * so both paths count and log a throw identically.
   */
  private recordFault(plugin: TerracePlugin, hook: string, error: unknown): void {
    this.faults.set(plugin.name, (this.faults.get(plugin.name) ?? 0) + 1);
    logError(`plugin "${plugin.name}" threw in ${hook}`, error);
  }

  /** How many of one plugin's hooks have thrown in this world. See `faults`. */
  faultCount(name: string): number {
    return this.faults.get(name) ?? 0;
  }

  /**
   * Whether this host is holding one plugin's saved bytes instead of the plugin
   * having loaded them — a downgrade or a refusal (see `park`).
   *
   * Read by the reload (issue #198), for which a refused slice is a failure
   * rather than a state to run in: the new module would come up with none of
   * the world's state, and the operator asked to update a plugin, not to empty
   * it.
   */
  isSliceParked(name: string): boolean {
    return this.writeSuppressed.has(name);
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
   * If any plugin modified, every plugin that allowed is asked ONCE MORE,
   * against the effective intent (issue #278) — see the second pass inside
   * for why only the allowers, and why a modify there is a deny.
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
    // Every plugin that allowed (or abstained) in the first pass. Kept so that,
    // if a LATER plugin rewrites the intent, these can be asked again about
    // the intent they will actually be bound to — see the second pass below.
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

    // SECOND PASS (issue #278): a plugin that allowed the ORIGINAL intent was
    // judging a stroke that no longer exists. mana priced radius 2, relics
    // widened it to 3, and mana — which sorts first — was then billed for 3
    // in the effect phase: an overdraft caused by a check that had passed.
    // The plugins that allowed are re-asked against the EFFECTIVE intent so a
    // verdict always refers to what will be applied and charged.
    //
    // Only the allowers are re-asked. The modifiers already spoke — their
    // rewrite IS the effective intent — and re-running them would compound an
    // unconditional widener (2→3→4) unless every modifier were rewritten to
    // recognise its own work. Skipping them keeps the guarantee in this one
    // place instead of in a convention every plugin author must remember.
    //
    // A `modify` on the second look is refused, not applied: there is no
    // third pass, and a plugin whose verdict depends on the very field it
    // rewrites could otherwise keep the chain from ever settling. It is booked
    // as a fault, exactly like a throw, because it is a plugin bug.
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
   * The handler for one namespaced client → server message type on THIS host,
   * or undefined when no enabled plugin claims it. The wire type is
   * `<plugin>:<type>`, so a plugin can never shadow a core message ('sculpt')
   * or another plugin's.
   *
   * LOOKED UP PER MESSAGE, never bound once (issue #197, and the multi-world
   * room before it). A room is created once and outlives every world loaded
   * into it — and, once a plugin can be reloaded, every plugin message set the
   * process has ever had. A handler captured at room-create time would keep
   * sculpting the world the operator just left; a TYPE LIST captured there
   * would deafen the room to a message type that arrived later. Both are
   * answered by asking whichever host is current, as each message lands. It
   * also has to work when NO world is loaded — a supported state in which no
   * host exists at all — which is why the room, not this class, owns the null
   * case (net/plugin-message-routing.ts).
   */
  handlerFor(type: string): ((player: Player, payload: unknown) => void) | undefined {
    // Built once per host, not per message: this is on the hot path for every
    // plugin message every client sends, and the plugin set cannot change
    // during a host's lifetime.
    this.handlersByType ??= new Map(this.messageHandlers());
    return this.handlersByType.get(type);
  }

  /**
   * Performs one plugin's declared action on this world (the admin panel,
   * 2026-09-01). See TerracePlugin.onAction for the contract the plugin sees.
   *
   * OVER THE ENABLED SET ONLY: a plugin the operator switched off for this
   * world has no running instance, and its `onAction` would be acting on a
   * world it never `onWorldCreate`d into. Told apart from "nobody declares
   * that" because the operator's fix is different (the world panel's toggle,
   * not the code).
   *
   * The site is clamped HERE, once, so no plugin has to remember to: the
   * client sends the cell its camera looks at, which can be off the map when
   * the view is dollied out past the edge.
   */
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
    // `safely` turns a throw into undefined; to the operator that is a
    // 'failed' receipt, and the log line `safely` wrote says why.
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
            // Payload is untrusted client input; plugins validate their own.
            this.safely(plugin, `messages.${type}`, () => handler(api, player, payload));
          },
        ]);
      }
    }
    return handlers;
  }

  /**
   * Plugin slices for a snapshot, keyed by plugin name, each wrapped in the
   * host's `{ v, data }` envelope (see slice-envelope.ts).
   */
  collectPersistence(): Record<string, unknown> {
    // Disabled plugins' slices ride along untouched — see `dormantSlices`.
    // Copied rather than mutated so a save can never edit the record a later
    // save has to re-emit. Parked slices are in here too, VERBATIM: whatever
    // shape they were stored in, enveloped or not, is what goes back out.
    const slices: Record<string, unknown> = { ...this.dormantSlices };
    for (const { loaded } of this.entries) {
      const { plugin } = loaded;
      if (!plugin.persistence) continue;
      // THE ONE-WRITER RULE (see `writeSuppressed`): a parked plugin does not
      // get to write over the bytes the host is holding for it.
      if (this.writeSuppressed.has(plugin.name)) continue;
      const data = this.safely(plugin, 'persistence.save', () => plugin.persistence?.save());
      // A plugin that failed to serialize is omitted rather than persisted as
      // undefined: on restore it simply sees no slice, which is the same state
      // it gets on first ever boot.
      if (data !== undefined) slices[plugin.name] = wrapSlice(plugin.persistence.version, data);
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
    // an older snapshot's slices, and these two sets must then describe THAT
    // snapshot rather than being the union of every restore so far.
    this.dormantSlices = {};
    this.writeSuppressed = new Set();
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
      const slice = plugin.persistence;
      if (!slice) continue;
      if (!Object.hasOwn(slices, plugin.name)) continue;

      const stored = readSlice(slices[plugin.name]);
      // DOWNGRADE: these bytes were written by a build ahead of this one, so
      // this build cannot know what is in them. Park rather than load — the
      // alternative every versioned plugin used to implement was "come up
      // empty", which the next snapshot then wrote over the real state.
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

      // A plugin that REFUSED, and a plugin that THREW, are in the same
      // position as a downgrade: neither holds any of the stored state, and
      // its bytes must survive rather than be overwritten by the empty save
      // that follows. One branch parks both because the plan settles them as
      // one row (docs/plans/plugin-hot-unload.md §3.5); only the wording of
      // the warning distinguishes the deliberate case from the accidental one.
      let parkReason: 'refused' | 'threw while loading' | null = null;
      try {
        if (slice.load(stored.data, stored.version) === 'refuse') parkReason = 'refused';
      } catch (error) {
        // CAUGHT HERE RATHER THAN IN `safely` (issue #206): `safely` returns
        // undefined for a throw AND for an ordinary void return, so a throw is
        // invisible at this call site — it was therefore never parked, and the
        // plugin's own post-throw empty save replaced the recoverable bytes at
        // the next snapshot. The fault is booked by hand so the counter and the
        // log line stay exactly what `safely` would have produced.
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

  /**
   * Holds one plugin's stored bytes VERBATIM and takes its slice key over for
   * the session — the two halves of parking, which only make sense together
   * (see `writeSuppressed`).
   */
  private park(name: string, stored: unknown): void {
    this.dormantSlices[name] = stored;
    this.writeSuppressed.add(name);
  }
}
