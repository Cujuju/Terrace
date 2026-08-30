// Reactive state for the world-manager panel (multi-world, 2026-08-22).
//
// Module-scope signals, written by the network layer and read by the panel —
// the same arrangement, and for the same two reasons, as state/rollbackState.ts
// and state/hudState.ts: the imperative layer has to write them from outside
// any reactive root, and there is no component body here for a reactive read
// to be frozen in.
//
// NOTHING HERE IS PERSISTED, and the world-admin key is the reason — the same
// reason rollbackState gives for its own key, one blast radius up. A key that
// can ARCHIVE a world must not outlive the tab it was typed into. The world
// listing is not persisted either, on hudState's existing rule for
// server-derived readouts: a cached copy could only be a stale lie about which
// worlds the server still has.
//
// THE SWITCH NOTICE IS NOT OPERATOR STATE. `pendingSwitch` and `worldLoaded`
// are written from messages every client receives, whether or not it holds a
// key or has ever opened the panel — a player being moved between worlds needs
// to be told regardless. They live here because this is the world-lifecycle
// module, not because they are privileged.

import { createSignal } from 'solid-js';
import type {
  WorldAdminAction,
  WorldAdminRefusal,
  WorldPluginSetting,
  WorldSummary,
  WorldSwitchStatus,
} from '@terrace/shared';

/**
 * What the panel is currently telling the operator. A single discriminated
 * signal rather than a spread of booleans (`loading`, `error`, `done`), which
 * is the shape that lets the UI show two contradictory things at once.
 */
export type WorldFeedback =
  /** Nothing asked for yet. */
  | { kind: 'idle' }
  /** A request is in flight. */
  | { kind: 'working' }
  /** A listing arrived; `worlds` and `archivedWorlds` hold it. */
  | { kind: 'listed' }
  /** An action succeeded. `plugin` is carried only by reloadPlugin (#211). */
  | {
      kind: 'done';
      action: WorldAdminAction;
      id: string | null;
      archivedPath: string | null;
      plugin: string | null;
    }
  /** The server said no. */
  | { kind: 'refused'; action: WorldAdminAction; reason: WorldAdminRefusal };

const [worldPanelOpen, setWorldPanelOpen] = createSignal(false);

const [worlds, setWorlds] = createSignal<readonly WorldSummary[]>([]);
const [archivedWorlds, setArchivedWorlds] = createSignal<readonly WorldSummary[]>([]);

/** Id of the world the server has loaded, or null when it has none. */
const [activeWorldId, setActiveWorldId] = createSignal<string | null>(null);

/**
 * The switch counting down right now, or null.
 *
 * Server-driven, and deliberately not decremented locally: the server sends
 * one notice per second and is the only thing that knows whether the switch
 * was cancelled. A client-side timer would keep counting through a cancel.
 */
const [pendingSwitch, setPendingSwitch] = createSignal<WorldSwitchStatus | null>(null);

/**
 * False once the server has said it has no world loaded, true again on the
 * next snapshot.
 *
 * STARTS TRUE, because a client that has just connected and heard nothing is
 * in the ordinary case — waiting for its first snapshot — and showing "no
 * world is loaded" during a normal join would be a lie that flickers on every
 * page load.
 */
const [worldLoaded, setWorldLoaded] = createSignal(true);

/**
 * Seconds until the server process restarts, or null when none is announced.
 *
 * Server-driven and never decremented locally, for `pendingSwitch`'s reason:
 * the server sends one notice per second and is the only thing that knows the
 * schedule. Zero is a real value — "restarting now" — and is what the terminal
 * notice of a countdown and an unannounced restart both carry.
 *
 * Cleared by the next snapshot rather than by a timer: the honest end of a
 * restart is the server being back, and a snapshot is proof of that.
 */
const [pendingRestartSeconds, setPendingRestartSeconds] = createSignal<number | null>(null);

/**
 * The plugin enablement the server last reported, for ONE world.
 *
 * One world at a time, not a map keyed by world id, because the panel asks
 * about the world whose row the operator opened — a cache of every world's
 * plugins would be a set of answers nothing on screen is asking, going stale
 * the moment another operator toggles something.
 */
export interface WorldPlugins {
  /** The world these lists describe. */
  readonly id: string;
  /** Every plugin installed on this server. */
  readonly installed: readonly string[];
  /** Those of `installed` this world does not run. */
  readonly disabled: readonly string[];
  /**
   * Every setting the installed plugins DECLARE, with the value in force here.
   *
   * Rendered generically — a control per row, labelled by its key, offering
   * its own values. Nothing in the client knows what any of these strings
   * mean, and nothing here may grow a list of them.
   */
  readonly settings: readonly WorldPluginSetting[];
  /**
   * Which build of each installed plugin the server loaded, by name.
   *
   * Shown beside each toggle so an operator who updated a plugin and restarted
   * can see the new code is live. Empty from a server too old to say, which the
   * panel renders as nothing rather than as a version.
   */
  readonly versions: Readonly<Record<string, string>>;
}

const [worldPlugins, setWorldPlugins] = createSignal<WorldPlugins | null>(null);

const [worldFeedback, setWorldFeedback] = createSignal<WorldFeedback>({ kind: 'idle' });

/** The world-admin key, for this tab only. See this file's header. */
const [worldAdminKey, setWorldAdminKey] = createSignal('');

export {
  activeWorldId,
  archivedWorlds,
  pendingRestartSeconds,
  setPendingRestartSeconds,
  pendingSwitch,
  setPendingSwitch,
  setWorldAdminKey,
  setWorldFeedback,
  setWorldLoaded,
  setWorldPanelOpen,
  worldAdminKey,
  worldFeedback,
  worldLoaded,
  worldPanelOpen,
  worldPlugins,
  worlds,
};

/** Applies a world listing from the server. Called by the network layer. */
export function applyWorldListing(message: {
  worlds: WorldSummary[];
  archived: WorldSummary[];
  activeId: string | null;
  pending?: WorldSwitchStatus;
  refused?: WorldAdminRefusal;
}): void {
  if (message.refused !== undefined) {
    // A refused listing carries empty arrays. Leaving the previous listing on
    // screen would be kinder-looking and wrong: the operator would be acting
    // on worlds this server has not confirmed it still has.
    setWorlds([]);
    setArchivedWorlds([]);
    setWorldFeedback({ kind: 'refused', action: 'load', reason: message.refused });
    return;
  }

  setWorlds(message.worlds);
  setArchivedWorlds(message.archived);
  setActiveWorldId(message.activeId);
  setPendingSwitch(message.pending ?? null);
  // A listing that names an active world is proof one is loaded, which is how
  // an operator who unloaded and then loaded again gets the banner cleared
  // without waiting for a snapshot to arrive.
  if (message.activeId !== null) setWorldLoaded(true);
  setWorldFeedback({ kind: 'listed' });
}

/**
 * Applies one world's plugin lists from the server. Called by the network layer.
 *
 * A refusal clears the lists rather than leaving the previous world's on
 * screen, on applyWorldListing's rule: an operator must not toggle against a
 * set the server has not just confirmed.
 */
export function applyWorldPluginListing(message: {
  id: string;
  installed: string[];
  disabled: string[];
  settings: WorldPluginSetting[];
  versions?: Record<string, string>;
  refused?: WorldAdminRefusal;
}): void {
  if (message.refused !== undefined) {
    setWorldPlugins(null);
    setWorldFeedback({ kind: 'refused', action: 'setPlugin', reason: message.refused });
    return;
  }
  setWorldPlugins({
    id: message.id,
    installed: message.installed,
    disabled: message.disabled,
    settings: message.settings,
    // Absent from a server built before per-plugin stamps existed; empty means
    // "not stated", which the panel shows as nothing at all.
    versions: message.versions ?? {},
  });
}

/** Applies an action receipt from the server. Called by the network layer. */
export function applyWorldAdminResult(message: {
  action: WorldAdminAction;
  ok: boolean;
  id?: string;
  archivedPath?: string;
  plugin?: string;
  refused?: WorldAdminRefusal;
}): void {
  if (!message.ok) {
    setWorldFeedback({
      kind: 'refused',
      action: message.action,
      // A result with ok:false always carries a reason; 'failed' is the
      // honest fallback for a server that somehow did not send one.
      reason: message.refused ?? 'failed',
    });
    return;
  }

  if (message.action === 'unload') setWorldLoaded(false);
  setWorldFeedback({
    kind: 'done',
    action: message.action,
    id: message.id ?? null,
    archivedPath: message.archivedPath ?? null,
    plugin: message.plugin ?? null,
  });
}

/**
 * Applies a switch countdown (or its cancellation).
 *
 * TWO TERMINAL SHAPES end a countdown, and both must clear `pendingSwitch`:
 * `cancelled: true` (the operator called it off; the world stays put) and
 * `secondsRemaining <= 0` (the swap is firing NOW — sent by the server just
 * before it blocks the thread saving/opening worlds). A snapshot arriving
 * afterwards also clears, as belt-and-braces against a lost terminal notice
 * (see client/src/world.ts onSnapshot).
 */
export function applyWorldSwitchNotice(message: {
  toId: string;
  toName: string;
  secondsRemaining: number;
  cancelled?: boolean;
}): void {
  if (message.cancelled === true || message.secondsRemaining <= 0) {
    setPendingSwitch(null);
    return;
  }
  setPendingSwitch({
    toId: message.toId,
    toName: message.toName,
    secondsRemaining: message.secondsRemaining,
  });
}
