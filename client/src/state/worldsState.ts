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
  /** An action succeeded. */
  | { kind: 'done'; action: WorldAdminAction; id: string | null; archivedPath: string | null }
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

const [worldFeedback, setWorldFeedback] = createSignal<WorldFeedback>({ kind: 'idle' });

/** The world-admin key, for this tab only. See this file's header. */
const [worldAdminKey, setWorldAdminKey] = createSignal('');

export {
  activeWorldId,
  archivedWorlds,
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

/** Applies an action receipt from the server. Called by the network layer. */
export function applyWorldAdminResult(message: {
  action: WorldAdminAction;
  ok: boolean;
  id?: string;
  archivedPath?: string;
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
  });
}

/** Applies a switch countdown (or its cancellation). */
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
