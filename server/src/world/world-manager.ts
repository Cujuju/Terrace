// THE WORLD MANAGER — which world is loaded, and how one becomes another.
//
// CRITICAL CODE. Loading a world closes the one that is live, so this file
// owns the moment at which a world stops being in memory. Its guarantees:
//
//   1. THE OUTGOING WORLD IS SAVED BEFORE IT IS CLOSED, unconditionally, and a
//      failure to save ABORTS the switch. A world is never closed on the hope
//      that its last snapshot was recent enough.
//   2. THE SWAP IS SYNCHRONOUS. From the first byte written for the outgoing
//      world to the last client re-snapshotted, nothing else runs — no tick,
//      no timer, no message. JavaScript's single thread is what makes that
//      true, and it is why there is no "swapping" flag to forget to check.
//   3. NOBODY IS LEFT LOOKING AT A WORLD THAT IS NO LONGER LOADED. Every
//      connected player is re-added to the incoming world, re-seeded, and sent
//      a fresh join snapshot before the switch returns.
//   4. A FAILED LOAD LEAVES NO WORLD LOADED, NEVER A HALF-LOADED ONE. If the
//      incoming world cannot be opened, the server ends up with nothing live
//      and says so, because the alternative — reopening the outgoing world and
//      pretending — hides a corrupt file until it is the only file left.
//
// WHY A COUNTDOWN EXISTS. With the operator alone on the server there is
// nobody to warn, and the swap is immediate. With others connected, pulling
// the ground out from under someone mid-sculpt is hostile, so the switch is
// announced, counted down (WORLD_SWITCH_COUNTDOWN_S), and only then applied —
// and it can be called off during the count.

import type { MessageSink } from '../net/message-sink.ts';
import type { WorldPluginSetting, WorldSwitchStatus } from '@terrace/shared';
import type { SnapshotStore } from '../persistence/snapshot-store.ts';
import { buildJoinSnapshot } from '../net/join-snapshot.ts';
import { buildIdentity, rebindBuildIdentity } from '../build-identity.ts';
import { logError, logInfo, logWarn } from '../log.ts';
import type { LoadedPlugin } from '../plugins/types.ts';
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

/**
 * Connected clients above which an operator action that interrupts everybody is
 * announced and counted down rather than applied at once.
 *
 * EXPORTED because the restart (server/src/restart.ts) makes the same decision
 * for the same reason, and a second `1` written down beside a second copy of
 * this comment is one of them drifting later.
 *
 * ONE, not zero: the operator who pressed the button is themselves a connected
 * client, and counting down at them — while they watch the panel they just
 * used — is a delay with no audience. The moment a SECOND person is present,
 * somebody who did not press the button is about to lose their view, and that
 * is exactly who the announcement is for.
 */
export const CLIENTS_ABOVE_WHICH_TO_ANNOUNCE = 1;

/** What the manager needs from the Colyseus room, without importing Colyseus. */
export interface RoomBridge {
  /** How the live world reaches clients; re-attached to every new session. */
  readonly sink: MessageSink;
  /** Connected clients right now — decides announce-vs-immediate. */
  clientCount(): number;
  /**
   * Everyone connected, from the ROOM's own record rather than from a World.
   *
   * THE ROOM IS THE ROSTER, and it has to be: a player can connect while no
   * world is loaded at all, in which case there is no World holding them and
   * nothing to carry into the world that is loaded next. Reading the roster
   * from the outgoing world would silently strand exactly those players.
   */
  players(): readonly Player[];
}

export interface WorldManagerDeps extends SessionDeps {
  /** WORLD_SWITCH_COUNTDOWN_S; 0 disables announcements entirely. */
  readonly switchCountdownS: number;
}

/** Why a load could not even be attempted. Widened into WorldAdminRefusal. */
export type LoadRefusal = 'unknownWorld' | 'alreadyActive' | 'switchInProgress' | 'failed';

/** Why the live world could not be rebuilt in place (issue #166). */
export type ReopenRefusal = 'noWorldLoaded' | 'switchInProgress' | 'failed';

/** Why a plugin could not be switched on or off for a world (issue #165). */
export type PluginToggleRefusal =
  | 'unknownWorld'
  | 'unknownPlugin'
  | 'switchInProgress'
  | 'failed';

/**
 * Why a plugin setting could not be recorded (per-world plugin settings). The
 * toggle's refusals plus the one only a settings change can hit: the plugin is
 * installed but declares no such key, or does not accept that value for it.
 */
export type PluginSettingRefusal = PluginToggleRefusal | 'unknownSetting';

/**
 * Why one plugin could not be reloaded in place (issue #198).
 *
 * ONE FAILURE NAME FOR ALL FOUR FAILING STEPS — import, onWorldCreate,
 * persistence.load, probe tick. They are told apart in the LOG, where the
 * operator can act on the difference; on the wire they are the same fact, and
 * the one that matters: the new code was rejected and the old build is still
 * running. A refusal vocabulary that enumerated a plugin's internal failure
 * modes would be core learning what a plugin's steps mean.
 *
 * THE ONE EXCEPTION IS NOT A STEP, IT IS A STATE (issue #207).
 * `reloadFailed` states that the build that was running still is, so it may
 * only be said when a world is actually loaded. When the reopen failed over
 * BOTH builds there is no world at all, which is a different fact for the
 * operator — a world to load, not a plugin to fix — and it gets its own name.
 */
export type PluginReloadRefusal =
  | 'unknownPlugin'
  | 'noWorldLoaded'
  | 'switchInProgress'
  | 'reloadFailed'
  | 'reloadLeftNoWorld';

/** What a successful reload produced: the stamp the new build is running as. */
export interface PluginReloadOutcome {
  readonly version: string;
}

/**
 * Where a reload gave up, for the log. Not a wire vocabulary — see
 * PluginReloadRefusal.
 */
type ReloadFailureStep =
  | 'opening the world'
  | 'restoring its slice or onWorldCreate'
  | 'persistence.load (it refused its saved data)'
  | 'the probe tick';

/** What a successful toggle did. `reopened` is false when nothing changed. */
export interface PluginToggleOutcome {
  /** Whether the live world was torn down and rebuilt to apply the change. */
  readonly reopened: boolean;
}

/**
 * A stored setting's lookup key: the plugin and the key it declared, which
 * together are the row's primary key in the world file. One function, so the
 * two halves are never joined two different ways.
 */
function settingRowKey(plugin: string, key: string): string {
  return `${plugin}/${key}`;
}

/** A switch that has been announced and is counting down. */
interface PendingSwitch {
  readonly toId: string;
  readonly toName: string;
  secondsRemaining: number;
  readonly timer: NodeJS.Timeout;
  /**
   * Connection that asked for this switch, for reporting a failure at FIRE
   * time back to whoever pressed the button. The original request has long
   * since been answered `ok` by then — announcing is not loading — so without
   * this there is no channel left to say "it never happened". Null when no
   * operator context exists (boot paths, tests).
   */
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

  /** The loaded world, or null when none is. */
  get current(): WorldSession | null {
    return this.session;
  }

  /** Id of the loaded world, or null. */
  get activeId(): string | null {
    return this.session?.id ?? null;
  }

  /** The switch counting down right now, if there is one. */
  get pendingSwitch(): WorldSwitchStatus | null {
    if (this.pending === null) return null;
    return {
      toId: this.pending.toId,
      toName: this.pending.toName,
      secondsRemaining: this.pending.secondsRemaining,
    };
  }

  /**
   * Connects the room. Attaching also (re-)points the LIVE world at the
   * room's sink, so a room created after a world was already loaded — the
   * normal boot order — starts receiving that world's broadcasts.
   */
  attachRoom(bridge: RoomBridge): void {
    this.bridge = bridge;
    this.session?.world.setSink(bridge.sink);
  }

  /** Disconnects the room; the live world stops broadcasting anywhere. */
  detachRoom(nullSink: MessageSink): void {
    this.bridge = null;
    this.session?.world.setSink(nullSink);
  }

  /**
   * One simulation step. A no-op with no world loaded, which is what lets the
   * tick loop keep running across an unload — the loop is a property of the
   * process, not of any particular world.
   */
  tick(dt: number): void {
    // The world clock advances inside host.tick — see PluginHost.tick for why
    // it belongs with the thing that runs the simulation rather than here.
    this.session?.host.tick(dt);
  }

  /**
   * Writes a snapshot of the live world if it changed.
   *
   * `options.defer` hands the write to the writer thread instead of blocking
   * on it — the periodic scheduler's mode, and nobody else's. See
   * SnapshotOptions.
   */
  snapshotIfDirty(options?: SnapshotOptions): boolean {
    if (this.session === null) return false;
    return snapshotIfDirty(this.session, options);
  }

  /**
   * Loads the world named by the active pointer, if there is one.
   *
   * DOES NOT INVENT A WORLD when the pointer is missing or stale. Booting with
   * no world loaded is a state the server supports and reports; generating
   * fresh terrain instead is how a self-hoster ends up staring at an empty map
   * (see ACTIVE_POINTER_FILE). The first-run case — no worlds at all — is
   * handled by the boot path in index.ts, which creates one explicitly.
   */
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

  /**
   * Creates a world without disturbing the live one. Returns its id, or null
   * when no usable id could be derived from the name.
   */
  createWorld(name: string, worldSize: number, difficulty: number): string | null {
    const id = this.deps.registry.uniqueIdFor(name);
    if (id === null) return null;
    createWorldFile(this.deps, id, name, worldSize, difficulty);
    return id;
  }

  /**
   * Makes a world live, either at once or after an announced countdown.
   *
   * Returns what it decided, so the operator's panel can say "switching in
   * 10s" rather than guessing which behaviour it got.
   */
  requestLoad(
    id: string,
    // Optional so boot callers and tests compile untouched; only the live
    // room handler can name the connection to blame/report to.
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

  /**
   * Reopens the world that is already live, so it comes back up under whatever
   * its file now says (issue #166).
   *
   * `requestLoad` refuses the live id with `alreadyActive`, and that refusal is
   * right for an OPERATOR pressing "load" on the world they are standing in —
   * it would be a swap to nowhere. It is wrong for the thing this method does,
   * where the id is deliberately the same and the point is the rebuild: the
   * session is what holds the plugin host, so a per-world plugin change only
   * takes effect by building a new session.
   *
   * IMMEDIATE, NEVER COUNTED DOWN, decided 2026-08-25 (issue #166): `openInto`
   * carries every connected player across without dropping a socket and hands
   * them a fresh join snapshot, so the world they are in does not change and
   * nobody is disconnected. The visible cost is a re-snapshot, not a loss of
   * place — and an announced countdown for a swap that takes nobody anywhere
   * would tell players to brace for something that never happens. The
   * countdown stays where it earns its keep: switching to a DIFFERENT world.
   *
   * Refuses while a switch is counting down: that switch is about to replace
   * this world entirely, and rebuilding the one it is leaving is wasted work
   * whose failure (guarantee 4 — nothing loaded) would abort it for nothing.
   */
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

  /** Every plugin this server has discovered, whether or not a world runs it. */
  get installedPluginNames(): readonly string[] {
    return this.deps.plugins.list.map((loaded) => loaded.plugin.name);
  }

  /**
   * Which BUILD of each installed plugin this process loaded, by name.
   *
   * A PROPERTY OF THE PROCESS, NOT OF A WORLD — read off the discovered set, so
   * it is the same answer whichever world the panel is asking about, and a
   * disabled plugin still has one (its module is loaded either way).
   */
  get installedPluginVersions(): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const loaded of this.deps.plugins.list) versions[loaded.plugin.name] = loaded.version;
    return versions;
  }

  /**
   * Which plugins a world has switched off, or null when there is no such
   * world. Reads the world's own file, so it answers for worlds that are not
   * loaded as readily as for the one that is.
   */
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

  /**
   * Switches a plugin on or off FOR ONE WORLD, and — if that world is live —
   * reopens it so the change is in effect (issues #165, #166).
   *
   * The server-side entry point for #168's admin command/panel. A plugin
   * nobody installed is refused rather than written, so a typo cannot leave a
   * permanent row disabling a plugin that never existed. Everything after that
   * decision — persist, then reopen — is `applyWorldConfiguration`'s, which
   * this shares with the settings path below.
   */
  setPluginEnabled(
    worldId: string,
    pluginName: string,
    enabled: boolean,
  ): PluginToggleOutcome | PluginToggleRefusal {
    if (!this.deps.registry.has(worldId)) return 'unknownWorld';
    if (!this.installedPluginNames.includes(pluginName)) return 'unknownPlugin';

    const alreadyDisabled = this.disabledPluginsFor(worldId)?.includes(pluginName) ?? false;
    // Nothing to write and — crucially — nothing to reopen: a second click on
    // a toggle that is already where it is being put must not cost every
    // player a re-snapshot.
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

  /**
   * The settings the installed plugins declare, with the value in force for
   * one world (per-world plugin settings, 2026-08-25).
   *
   * THE DECLARATION IS THE SPINE, not the stored rows: a key nothing declares
   * any more is not offered, and a declared key a world has never chosen is
   * offered with the plugin's own default in it, so the panel always shows
   * what is actually running rather than an empty box.
   *
   * Null when there is no such world, matching `disabledPluginsFor`.
   */
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

  /**
   * Records one plugin setting FOR ONE WORLD, and — if that world is live —
   * reopens it so the plugin comes back up under the new value.
   *
   * VALIDATED AGAINST THE DECLARING PLUGIN, never against a list in core: the
   * plugin says which keys it has and which values each takes
   * (PluginSettingDeclaration), and anything outside that is refused
   * ('unknownSetting') exactly as a plugin nobody installed is. That is what
   * keeps `life | populous` structures' vocabulary rather than the protocol's.
   *
   * A REOPEN IS HOW A SETTING TAKES EFFECT, not a live re-read: a plugin reads
   * its settings once, in `onWorldCreate`, so the value cannot move under a
   * running tick. The reopen carries every connected player across (#166).
   */
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

    // Already what it is being set to: nothing to write, and nothing to reopen
    // — the same rule the toggle keeps, for the same reason.
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

  /**
   * RELOADS ONE PLUGIN'S SERVER CODE IN PLACE (issue #198, Option B) — the new
   * module runs the live world without the process restarting.
   *
   * THE PROMISE: either the new module is running everywhere, or the old one
   * still is. There is no third outcome, and the four steps below are each a
   * place the new code can be found unfit:
   *
   *   1. IMPORT — a syntax error or a throw at module scope. Nothing has been
   *      installed yet, so there is nothing to undo.
   *   2. RESTORE + onWorldCreate — the world is rebuilt over the new module.
   *      Both are wrapped by `PluginHost.safely`, so neither throws out to
   *      here; the host's fault COUNT for this plugin is what says it failed.
   *   3. persistence.load REFUSED — the slice is parked and the plugin is
   *      running with no state (host.isSliceParked). An operator asked to
   *      update a plugin, not to empty it, so this is a failure like the rest.
   *   4. THE PROBE TICK — one real simulation step, because a plugin that
   *      throws on every tick has not been exercised by anything above.
   *
   * ROLLBACK IS THE SAME MACHINERY AS THE SWAP: the old LoadedPlugin goes back
   * in its slot and the world is opened again over it, which replays
   * `restorePersistence` + `worldCreate` and so restores the old module's state
   * from the slice — the reason a half-updated process is not expressible here.
   *
   * THE OLD MODULE IS NOT FREED. Node's module map has no eviction, so every
   * reload leaks one plugin's subtree for the life of the process; see
   * plugins/reload.ts and DESIGN's known residual for the measured number.
   */
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
      // A module that renamed itself is not a new build of this plugin: its
      // slice key, its message namespace and its sibling name would all move at
      // once, and nothing in the world would find it.
      logError(
        `reloading plugin "${name}" failed: plugins/${previous.directory} now calls itself ` +
          `"${replacement.plugin.name}". It keeps its previous build.`,
      );
      return 'reloadFailed';
    }

    // RE-CHECKED AFTER THE AWAIT — the only yield in this method. A switch can
    // have been announced, or the world unloaded, while the import ran.
    const afterImport = this.reloadPrecondition();
    if (afterImport !== null) return afterImport;
    const id = this.activeId;
    if (id === null) return 'noWorldLoaded';

    const failure = this.installAndProbe(id, replacement);
    if (failure === null) {
      // ONLY NOW MAY THE OPEN PAGES HEAR ABOUT IT — see announceBuildIdentity.
      this.announceBuildIdentity();
      logInfo(`plugin "${name}" reloaded in place as v${replacement.version}`);
      return { version: replacement.version };
    }

    logError(
      `reloading plugin "${name}" failed at ${failure} — rolling back to v${previous.version}`,
    );
    const rolledBack = this.installAndProbe(id, previous, true);
    if (rolledBack !== null) {
      // The build that was running a moment ago now fails too, which means the
      // failure is not the new module's. Stated rather than retried: the world
      // is whatever the last open left, and the operator needs to see this.
      logError(`rolling plugin "${name}" back to v${previous.version} also failed at ${rolledBack}`);
    }
    // AND IF THAT LEFT NOTHING LOADED, SAY SO (issue #207). `openInto` clears
    // the session before it opens the incoming world, so a failure on the open
    // side leaves no world at all — and it is the open side that can fail
    // identically on the way back, since the rollback reopens the same file the
    // same way. Everyone still believes the old world is live: the clients are
    // drawing it and the room drops every sculpt they send, and 'reloadFailed'
    // would tell the operator the previous build is still running when nothing
    // is. Both audiences are told the state instead.
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

  /**
   * NOTHING IS LOADED — TELL THE CLIENTS. The one exit every no-world path
   * goes through (issue #207).
   *
   * A client draws whatever the last snapshot gave it until something says
   * otherwise; `worldUnloaded` is that something, and without it the page keeps
   * rendering a world the server has closed while the room silently drops every
   * sculpt it sends (net/terrace-room.ts's `session === null` early-out). There
   * is no reconciliation timer to catch a path that forgot, so forgetting is
   * permanent until the client reconnects — which is why the broadcast is a
   * method with a name rather than a line each caller has to remember.
   *
   * The guard is not decoration: announcing an unload while a world is live
   * would blank a running world's view for everybody, so a caller that reaches
   * here in the wrong state gets a log rather than a broadcast.
   */
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

  /** The two states in which no reload may start (or continue after an await). */
  private reloadPrecondition(): PluginReloadRefusal | null {
    if (this.session === null) return 'noWorldLoaded';
    if (this.pending !== null) return 'switchInProgress';
    return null;
  }

  /**
   * Puts one build of a plugin in the installed set, rebuilds the live world
   * over it, and takes one real tick. Returns null when the plugin came up
   * clean, or the step it failed at.
   *
   * THE IDENTITY IS NOT TOUCHED HERE, on the way in or on the way back (issue
   * #209). `openInto` hands every connected player a fresh join snapshot, and
   * that snapshot is the only place the build identity a client keys its
   * one-shot page reload on is ever stated (net/join-snapshot.ts) — so
   * rebinding before the reopen would order every open page to reload for a
   * build the checks below may be about to REJECT, and a client acts on the
   * first identity that differs from the one it joined under and ignores every
   * later one (client/src/net/buildReload.ts), so the rollback could not take
   * that reload back. The snapshots this reopen sends therefore state the
   * identity the pages already joined under, which reloads nothing;
   * `announceBuildIdentity` states the new one afterwards, once the probe has
   * passed — which is also what keeps a rejected build's rollback re-sending
   * the ORIGINAL identity rather than a second new one.
   *
   * `rollingBack` only shapes the log: on the way back there is no probe result
   * anybody can act on, but a failure there is still worth stating.
   */
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
    // Cannot be null — `openInto` returned without throwing — but the type says
    // it can, and inventing a non-null assertion here would be the one place in
    // this file that lies about the session.
    if (session === null) return 'opening the world';

    if (session.host.faultCount(name) > 0) return 'restoring its slice or onWorldCreate';
    if (session.host.isSliceParked(name)) return 'persistence.load (it refused its saved data)';

    // ONE REAL TICK, at the server's own tick period, because nothing above
    // runs the plugin's simulation and a plugin that throws every tick would
    // otherwise be installed as a silent no-op. It is a genuine step: the world
    // clock advances by it, exactly as if the tick loop had reached it first.
    session.host.tick(1 / this.deps.config.tickHz);
    if (session.host.faultCount(name) > 0) return 'the probe tick';
    return null;
  }

  /**
   * REBINDS THE BUILD IDENTITY AND TELLS THE OPEN PAGES — the last step of a
   * reload that has already passed all four of its checks (issue #209).
   *
   * WHY IT IS A SECOND SNAPSHOT RATHER THAN THE REOPEN'S OWN. The identity only
   * ever reaches a client on a join snapshot, and a client acts on the first
   * identity that differs from the one it joined under and ignores the rest —
   * so an identity sent by the reopen INSIDE the probe would be a page reload
   * ordered for a build that may then be rejected, and nothing the rollback
   * sends afterwards can cancel it. Sending it here costs one extra join
   * snapshot per connected player on a SUCCESSFUL reload — a dev-loop action
   * that has just rebuilt the world for everybody anyway — and it is what makes
   * the reload's promise true on the wire as well as in the process: either
   * every page is told the new identity, or no page is told anything.
   *
   * IT REBINDS FROM THE INSTALLED SET, so the digest states what is actually
   * running. A rejected build never reaches this, which is why the identity a
   * rollback's snapshots carry is still the one the pages joined under.
   *
   * NOTHING CAN JOIN BETWEEN THE PROBE AND THIS CALL: the reload is synchronous
   * from `plugins.replace` to here, so no join handshake can interleave and be
   * told an identity for a build that is still on probation.
   */
  private announceBuildIdentity(): void {
    const before = buildIdentity();
    const after = rebindBuildIdentity(this.deps.plugins.list);
    // A reload that moved no stamp has nothing to say: an unchanged identity
    // reloads no page (buildReload rule 3), so the snapshot would be pure cost.
    if (after === before) return;

    const session = this.session;
    // Cannot be null — the probe just ticked it — but the type says it can, and
    // a non-null assertion here would lie about the session like nothing else
    // in this file does.
    if (session === null) return;

    for (const player of this.bridge?.players() ?? []) {
      session.world.sendTo(player.id, buildJoinSnapshot(session.world, session.host, player.token));
    }
  }

  /** This world's stored settings, flattened to `<plugin>/<key>` -> value. */
  private storedSettings(worldId: string): Record<string, string> {
    const rows =
      this.session?.id === worldId
        ? this.session.store.pluginSettings()
        : this.withStore(worldId, (store) => store.pluginSettings());
    const flat: Record<string, string> = {};
    for (const row of rows) flat[settingRowKey(row.plugin, row.key)] = row.value;
    return flat;
  }

  /** Runs `read` against a world that is not the live one, closing the file after. */
  private withStore<T>(worldId: string, read: (store: SnapshotStore) => T): T {
    const store = this.deps.registry.openStore(worldId, this.deps.config.snapshotRetention);
    try {
      return read(store);
    } finally {
      store.close();
    }
  }

  /**
   * PERSIST FIRST, REOPEN SECOND — the one shape every per-world configuration
   * change has (enablement, settings, and whatever comes next).
   *
   * The file is the record, and a reopen that fails must not leave the
   * operator's decision unrecorded — they can load the world again to get it.
   * A world that is merely on disk needs no reopen at all; the live one is
   * rebuilt so the change is actually in effect, carrying every connected
   * player across (#166).
   *
   * Refuses while a switch is counting down, for `reopen`'s reason: that
   * switch is about to replace this world entirely, so rebuilding the one it
   * is leaving is wasted work whose failure would abort it for nothing.
   */
  private applyWorldConfiguration(
    worldId: string,
    write: (store: SnapshotStore) => void,
    appliedLog: string,
    failureLog: string,
  ): PluginToggleOutcome | PluginToggleRefusal {
    const live = this.session?.id === worldId;
    if (live && this.pending !== null) return 'switchInProgress';

    try {
      // The live session already holds this file open; writing through its own
      // store keeps one connection on it rather than racing a second.
      if (live && this.session !== null) write(this.session.store);
      else this.withStore(worldId, write);
    } catch (error) {
      logError(failureLog, error);
      return 'failed';
    }

    logInfo(appliedLog);
    if (!live) return { reopened: false };

    const reopened = this.reopen();
    // `noWorldLoaded` cannot happen — `live` says a session exists and nothing
    // yields the thread between the two — but it is not a configuration
    // refusal, so it is reported as the failure it would be if it ever did.
    if (reopened !== true) return reopened === 'noWorldLoaded' ? 'failed' : reopened;
    return { reopened: true };
  }

  /** Calls off a counting-down switch. Returns false when none was running. */
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

  /**
   * Saves and closes the live world, leaving none loaded.
   *
   * A running server with no world is a supported state: it still serves the
   * client, still answers world management, and simply has nothing to
   * simulate. Clients are told, so they stop drawing a world the server has
   * closed.
   */
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

  /**
   * Final save on process shutdown. Separate from `unload` because it must NOT
   * clear the active pointer: the whole point of shutting down cleanly is that
   * the next boot comes back to the same world.
   */
  shutdown(): boolean {
    if (this.session === null) return false;
    this.cancelSwitch();
    const closing = this.session;
    this.session = null;
    return closeSession(closing);
  }

  /**
   * THE SWAP. See this file's four guarantees; the steps below are them.
   *
   * Synchronous from start to finish, deliberately — no `await`, no callback,
   * nothing that yields the thread — so there is no instant at which a tick,
   * a message or a timer can observe a half-swapped process.
   */
  private openInto(id: string): void {
    const outgoing = this.session;

    // STEP 1 — remember who is here. From the ROOM, not from the outgoing
    // world: a player who connected while nothing was loaded exists in the
    // room and in no World at all, and must still be carried in (see
    // RoomBridge.players).
    const players: readonly Player[] = this.bridge?.players() ?? [];

    // STEP 2 — save the outgoing world, and ABORT if that fails. The world
    // stays loaded and untouched; the operator sees a refusal and still has
    // their world. Closing anyway would trade a failed switch for a lost hour.
    if (outgoing !== null) {
      try {
        snapshotIfDirty(outgoing);
      } catch (error) {
        logError(`refusing to switch: could not save world "${outgoing.id}"`, error);
        throw error;
      }
    }

    // STEP 3 — from here the outgoing world is gone. `this.session` is cleared
    // FIRST so that if step 4 throws, the process is left with no world loaded
    // rather than with a session whose store has been closed underneath it.
    //
    // THROUGH `releaseSession`, NOT A BARE `store.close()`: the plugins have to
    // be told their world is going and their views have to be revoked, exactly
    // as on the unload path (see that function — this line closing only the
    // file is the defect it was extracted to make unrepeatable). The save is
    // step 2's rather than the release's because only here may a failed save
    // ABORT the whole switch.
    this.session = null;
    if (outgoing !== null) {
      try {
        releaseSession(outgoing);
      } catch (error) {
        logWarn(`closing world "${outgoing.id}" reported: ${String(error)}`);
      }
    }

    // STEP 4 — open the incoming world. A throw here leaves nothing loaded,
    // which is honest and recoverable; the operator can load something else.
    const incoming = openSession(this.deps, id);
    this.session = incoming;
    this.deps.registry.writeActive(id);

    // STEP 5 — reconnect the transport before anybody is told anything.
    if (this.bridge !== null) incoming.world.setSink(this.bridge.sink);

    // STEP 6 — carry the connected players across. Each is re-added to the
    // NEW world and given their home square there; a token that has never
    // played this world gets one for the first time, and a returning token
    // finds the territory it already had (World.seedChunkForToken is
    // idempotent). Same call, same reason, as TerraceRoom.onJoin.
    for (const player of players) {
      incoming.world.addPlayer(player);
      applyInitialUnlockForToken(incoming.world, player.token);
    }

    // STEP 7 — hand every player the world they are now in, then let the
    // plugins meet them. Snapshot FIRST and plugin-join second, matching the
    // ordering contract in TerraceRoom.onJoin: a plugin's onPlayerJoin may
    // broadcast or unlock chunks, and a client must already be sized for the
    // new world before that arrives.
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

  /** Starts the announced countdown to a switch. */
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

      // Time is up. Clear `pending` BEFORE the swap so a failure inside it
      // cannot leave a countdown that has already fired still showing.
      clearInterval(this.pending.timer);
      const { toId: target, toName, requesterId } = this.pending;
      this.pending = null;

      // TERMINAL NOTICE FIRST, before the swap blocks the thread on saving and
      // opening worlds. Without it every client sits frozen at "in 1s" until
      // the new snapshot lands — and if the swap FAILS, forever, because this
      // was the last message the countdown would ever send.
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
        // Guarantee 4 leaves NO world loaded here — but the clients are still
        // drawing the old one, believing it live. Tell them what unload tells
        // them, so the banner states the fact instead of a stale view.
        this.announceWorldUnloaded();
        // And tell the operator who asked. Their receipt already said ok —
        // announcing is not loading — so this async refusal is the ONLY word
        // they get. An absent/unknown id (disconnected since) is silently
        // dropped by the sink, which is all that can be done.
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

  /** Broadcasts through the room, or drops the message when none is attached. */
  private broadcast(type: string, payload: unknown): void {
    this.bridge?.sink.broadcast(type, payload);
  }

  /** Sends to one connection through the room, or drops when none is attached. */
  private sendTo(playerId: string, type: string, payload: unknown): void {
    this.bridge?.sink.sendTo(playerId, type, payload);
  }
}
