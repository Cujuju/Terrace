import { For, Show, createSignal, type JSX } from 'solid-js';
import type { RestorePoint, RollbackRefusal } from '@terrace/shared';
import {
  operatorKey,
  restoreIntervalS,
  restorePoints,
  restoreRetention,
  rollbackFeedback,
  setOperatorKey,
  setRestorePanelOpen,
  setRollbackFeedback,
} from '../state/rollbackState.ts';

export interface RollbackActions {
  list(key: string): void;
  apply(key: string, toId: number): void;
}

const SECONDS_PER_MINUTE = 60;

const OUTLIER_MEDIAN_MULTIPLE = 8;

const OUTLIER_MINIMUM_CELLS = 500;

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatAge(epochMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < SECONDS_PER_MINUTE) return 'just now';
  return `${Math.round(seconds / SECONDS_PER_MINUTE)}m ago`;
}

function outlierThreshold(points: readonly RestorePoint[]): number | null {
  const counts = points
    .map((point) => point.cellsChanged)
    .filter((count): count is number => count !== null)
    .sort((a, b) => a - b);
  if (counts.length === 0) return null;
  const median = counts[Math.floor(counts.length / 2)];
  return Math.max(OUTLIER_MINIMUM_CELLS, median * OUTLIER_MEDIAN_MULTIPLE);
}

function refusalText(reason: RollbackRefusal): string {
  switch (reason) {
    case 'disabled':
      return 'This server has no rollback key set. Set ROLLBACK_KEY in its environment and restart it.';
    case 'badKey':
      return 'That key does not match this server’s ROLLBACK_KEY.';
    case 'throttled':
      return 'Too many wrong keys. Wait a minute, then try again.';
    case 'unknownRestorePoint':
      return 'That restore point is gone — it aged out of the history. Pick another.';
    case 'sizeMismatch':
      return 'That restore point belongs to a differently sized world and cannot be applied.';
    case 'failed':
      return 'The restore failed and the world was left as it was. Check the server log.';
  }
}

export function RestorePoints(props: { actions: RollbackActions }): JSX.Element {
  const [armedId, setArmedId] = createSignal<number | null>(null);

  const [listedAtMs, setListedAtMs] = createSignal(Date.now());

  const requestList = (): void => {
    setArmedId(null);
    setListedAtMs(Date.now());
    setRollbackFeedback({ kind: 'working' });
    props.actions.list(operatorKey());
  };

  const applyRollback = (toId: number): void => {
    setArmedId(null);
    setRollbackFeedback({ kind: 'working' });
    props.actions.apply(operatorKey(), toId);
  };

  const historyDepth = (): string | null => {
    const retention = restoreRetention();
    const intervalS = restoreIntervalS();
    if (retention === null || intervalS === null) return null;
    const minutes = Math.round((retention * intervalS) / SECONDS_PER_MINUTE);
    return `${retention} restore points — about ${minutes} minutes of history.`;
  };

  return (
    <div class="restore-overlay" role="dialog" aria-label="Restore points">
      <div class="restore-sheet">
        <div class="restore-header">
          <span class="status-label">Restore points</span>
          <button
            type="button"
            class="chart-button"
            aria-label="Close restore points"
            title="Close: put the panel away"
            onClick={() => setRestorePanelOpen(false)}
          >
            ✕
          </button>
        </div>

        <p class="hud-hint">
          Put the whole world back to how it was at an earlier moment. The world
          you roll away from is saved first, so this can be undone.
        </p>

        {
}
        <form
          class="restore-key-row"
          onSubmit={(event) => {
            event.preventDefault();
            requestList();
          }}
        >
          <label class="controls-label" for="rollback-key">
            Operator key
          </label>
          <input
            id="rollback-key"
            class="restore-key-input"
            type="password"
            autocomplete="off"
            placeholder="ROLLBACK_KEY"
            value={operatorKey()}
            onInput={(event) => setOperatorKey(event.currentTarget.value)}
          />
          <button type="submit" class="chart-button" disabled={operatorKey() === ''}>
            List
          </button>
        </form>

        <Show when={rollbackFeedback().kind === 'refused'}>
          {
}
          <p class="restore-refusal">
            {refusalText((rollbackFeedback() as { reason: RollbackRefusal }).reason)}
          </p>
        </Show>

        <Show when={rollbackFeedback().kind === 'rolledBack'}>
          <p class="restore-done">
            World restored. The world you rolled away from was saved as restore
            point #{(rollbackFeedback() as { undoId: number | null }).undoId ?? '—'} —
            list again to roll forward to it.
          </p>
        </Show>

        <Show when={restorePoints().length > 0}>
          <ul class="restore-list">
            <For each={restorePoints()}>
              {(point) => {
                const flagged = (): boolean => {
                  const threshold = outlierThreshold(restorePoints());
                  return (
                    threshold !== null &&
                    point.cellsChanged !== null &&
                    point.cellsChanged >= threshold
                  );
                };
                return (
                  <li class="restore-row" classList={{ flagged: flagged() }}>
                    <span class="restore-when">
                      {formatWhen(point.createdAt)}
                      <span class="restore-age">{formatAge(point.createdAt, listedAtMs())}</span>
                    </span>
                    <span class="restore-delta">
                      <Show when={point.cellsChanged !== null} fallback="oldest kept">
                        {point.cellsChanged?.toLocaleString()} cells changed
                        <Show when={flagged()}>
                          <span class="restore-flag" title="Flag: far above the usual minute">
                            {' '}
                            ⚠ large change
                          </span>
                        </Show>
                      </Show>
                    </span>
                    <Show
                      when={armedId() === point.id}
                      fallback={
                        <button
                          type="button"
                          class="chart-button"
                          disabled={point.isCurrent}
                          title={
                            point.isCurrent
                              ? 'Current: you are already here'
                              : 'Arm: choose this restore point'
                          }
                          onClick={() => setArmedId(point.id)}
                        >
                          {point.isCurrent ? 'Current' : 'Restore…'}
                        </button>
                      }
                    >
                      <span class="restore-confirm">
                        <button
                          type="button"
                          class="chart-button danger"
                          title="Restore: everyone goes back to this"
                          onClick={() => applyRollback(point.id)}
                        >
                          Roll back to {formatWhen(point.createdAt)}
                        </button>
                        <button
                          type="button"
                          class="chart-button"
                          title="Cancel: leave the world as is"
                          onClick={() => setArmedId(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={historyDepth() !== null}>
          <p class="hud-hint">
            This server keeps {historyDepth()} Raise SNAPSHOT_RETENTION in its
            environment to keep more.
          </p>
        </Show>
      </div>
    </div>
  );
}
