// Reactive state for the restore-points panel (world rollback, 2026-08-21).
//
// Module-scope signals, written by the network layer and read by the panel —
// the same arrangement, and for the same two reasons, as state/hudState.ts:
// the imperative layer has to write them from outside any reactive root, and
// there is no component body here for a reactive read to be frozen in.
//
// NOTHING HERE IS PERSISTED, and the operator key is the reason. hudState
// writes every player choice through to localStorage; a secret is the one
// thing that must not be, because a rollback key cached in a browser turns
// "someone used my machine" into "someone rolled back my world". It is held
// for the life of the tab and no longer. The restore points are not persisted
// either, on hudState's existing rule for server-derived readouts: a cached
// copy could only be a stale lie about what the server still holds.

import { createSignal } from 'solid-js';
import type { RestorePoint, RollbackRefusal } from '@terrace/shared';

/**
 * What the panel is currently telling the operator. A single discriminated
 * signal rather than a spread of booleans (`loading`, `error`, `done`), which
 * is the shape that lets the UI show two contradictory things at once.
 */
export type RollbackFeedback =
  /** Nothing asked for yet. */
  | { kind: 'idle' }
  /** A request is in flight. */
  | { kind: 'working' }
  /** A list arrived; `points` holds it. */
  | { kind: 'listed' }
  /** The server said no. */
  | { kind: 'refused'; reason: RollbackRefusal }
  /** The world was rolled back, and where the previous world was saved. */
  | { kind: 'rolledBack'; toId: number; undoId: number | null };

const [restorePanelOpen, setRestorePanelOpen] = createSignal(false);

const [restorePoints, setRestorePoints] = createSignal<readonly RestorePoint[]>([]);

/**
 * The server's retention depth and snapshot cadence, as it reported them.
 * Null until a list has been received: the panel states the real depth of the
 * safety net ("about 10 minutes of history") and must not invent it from the
 * client's own assumptions about a server it has not heard from.
 */
const [restoreRetention, setRestoreRetention] = createSignal<number | null>(null);
const [restoreIntervalS, setRestoreIntervalS] = createSignal<number | null>(null);

const [rollbackFeedback, setRollbackFeedback] = createSignal<RollbackFeedback>({
  kind: 'idle',
});

/** The operator key, for this tab only. See this file's header. */
const [operatorKey, setOperatorKey] = createSignal('');

export {
  operatorKey,
  restoreIntervalS,
  restorePanelOpen,
  restorePoints,
  restoreRetention,
  rollbackFeedback,
  setOperatorKey,
  setRestorePanelOpen,
  setRollbackFeedback,
};

/**
 * Applies a restore-point list from the server. Called by the network layer.
 *
 * A REFUSED list clears the points rather than leaving the previous ones on
 * screen: the operator has just been told the server will not talk to them, so
 * a stale list beside that message would read as "here is what you can still
 * restore", which is exactly wrong.
 */
export function applyRestorePointList(msg: {
  points: RestorePoint[];
  retention: number;
  intervalS: number;
  refused?: RollbackRefusal;
}): void {
  setRestoreRetention(msg.retention);
  setRestoreIntervalS(msg.intervalS);
  if (msg.refused !== undefined) {
    setRestorePoints([]);
    setRollbackFeedback({ kind: 'refused', reason: msg.refused });
    return;
  }
  setRestorePoints(msg.points);
  setRollbackFeedback({ kind: 'listed' });
}

/** Applies a rollback receipt from the server. Called by the network layer. */
export function applyRollbackResult(msg: {
  ok: boolean;
  toId?: number;
  undoId?: number;
  refused?: RollbackRefusal;
}): void {
  if (!msg.ok || msg.toId === undefined) {
    setRollbackFeedback({ kind: 'refused', reason: msg.refused ?? 'failed' });
    return;
  }
  setRollbackFeedback({
    kind: 'rolledBack',
    toId: msg.toId,
    undoId: msg.undoId ?? null,
  });
  // The list the operator was looking at is now out of date — the rollback
  // itself wrote two new restore points (the undo point and the rewound
  // world). Cleared rather than re-requested from here: this module holds no
  // connection, and the panel re-lists on the operator's next look.
  setRestorePoints([]);
}
