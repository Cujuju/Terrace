import { createSignal } from 'solid-js';
import type { RestorePoint, RollbackRefusal } from '@terrace/shared';

export type RollbackFeedback =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'listed' }
  | { kind: 'refused'; reason: RollbackRefusal }
  | { kind: 'rolledBack'; toId: number; undoId: number | null };

const [restorePanelOpen, setRestorePanelOpen] = createSignal(false);

const [restorePoints, setRestorePoints] = createSignal<readonly RestorePoint[]>([]);

const [restoreRetention, setRestoreRetention] = createSignal<number | null>(null);
const [restoreIntervalS, setRestoreIntervalS] = createSignal<number | null>(null);

const [rollbackFeedback, setRollbackFeedback] = createSignal<RollbackFeedback>({
  kind: 'idle',
});

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
  setRestorePoints([]);
}
