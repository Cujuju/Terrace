// The restore-points panel — "put the world back the way it was at 19:16"
// (world rollback, 2026-08-21).
//
// WHY THIS PANEL EXISTS AT ALL. A misbehaving terraform can change a large
// part of the map in one cast, and until now the only recourse was hand-editing
// SQLite. The server already writes a restore point every SNAPSHOT_INTERVAL_S;
// this is the door to them.
//
// WHAT MAKES IT USABLE IS THE SECOND COLUMN, not the timestamps. Two adjacent
// restore points a minute apart look identical in a list of times, while one of
// them moved 108 cells and the other moved 11,673. Every row therefore states
// how far the world moved to reach it, and the rows that moved it furthest are
// called out — that is how an operator finds the moment things went wrong
// without knowing when it happened.
//
// DESTRUCTIVE ACTION, SO IT CONFIRMS. Restore is a two-step: the row's button
// arms it, and a second, differently-labelled button commits. No dialog — the
// project's UI rule is that an error banner with a retry button is a
// capitulation, and the same reasoning says a confirm dialog that always says
// the same thing trains people to dismiss it. Arming shows what will actually
// happen, in the row it will happen to.
//
// SOLID REACTIVITY: every reactive value is read by CALLING its accessor at
// the point of use, inside JSX or inside an event handler. There are no
// component-body consts holding a reactive read in this file, by construction.

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

/** What the panel can ask the server to do. Supplied by main.tsx. */
export interface RollbackActions {
  list(key: string): void;
  apply(key: string, toId: number): void;
}

/** Seconds per minute — named because it is a unit conversion, not a tuning knob. */
const SECONDS_PER_MINUTE = 60;

/**
 * How many times the median restore point's cell count a row must exceed to be
 * flagged as an outlier.
 *
 * MEDIAN-RELATIVE, NOT AN ABSOLUTE CELL COUNT, because "big" has no fixed
 * value: on a quiet world 200 cells is an event, and on one being actively
 * terraformed by five people it is a Tuesday. The median of the retained
 * history is what this world's ordinary minute looks like, and 8× that is far
 * enough above ordinary that a run of normal sculpting cannot reach it while
 * the incident this panel was built for (~100× a normal stroke) clears it
 * comfortably. The flag is a HINT — it never changes what a button does.
 */
const OUTLIER_MEDIAN_MULTIPLE = 8;

/** Rows below this are never flagged, however quiet the world has been. */
const OUTLIER_MINIMUM_CELLS = 500;

/** Local time, to the second: restore points are often a minute apart. */
function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** "4m ago" / "just now" — the reading an operator actually navigates by. */
function formatAge(epochMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < SECONDS_PER_MINUTE) return 'just now';
  return `${Math.round(seconds / SECONDS_PER_MINUTE)}m ago`;
}

/**
 * The cells-changed threshold above which a row is flagged, or null when the
 * history holds nothing to compare against.
 */
function outlierThreshold(points: readonly RestorePoint[]): number | null {
  const counts = points
    .map((point) => point.cellsChanged)
    .filter((count): count is number => count !== null)
    .sort((a, b) => a - b);
  if (counts.length === 0) return null;
  // MEDIAN, not mean: the mean of a history containing one 11,673-cell event
  // is dragged up by that event, so the very row that should be flagged raises
  // the bar it has to clear. The median is unmoved by it.
  const median = counts[Math.floor(counts.length / 2)];
  return Math.max(OUTLIER_MINIMUM_CELLS, median * OUTLIER_MEDIAN_MULTIPLE);
}

/** Plain-language reason, so the server never composes player-facing prose. */
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
  // Which row is armed for restore, by id; null when nothing is armed. Local
  // to the panel because it is a property of this operator's current look at
  // it, not of the world or the server.
  const [armedId, setArmedId] = createSignal<number | null>(null);

  // Captured when the list arrives, so every row's age is measured against one
  // instant instead of each row rendering against a slightly different now().
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
            title="Close this panel."
            onClick={() => setRestorePanelOpen(false)}
          >
            ✕
          </button>
        </div>

        <p class="hud-hint">
          Put the whole world back to how it was at an earlier moment. The world
          you roll away from is saved first, so this can be undone.
        </p>

        {/* The key is typed, never stored: see state/rollbackState.ts. A
            password field so it is not shoulder-read off a shared screen. */}
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
          {/* Narrowed through a local, non-reactive read inside the guard: the
              Show above has already established the kind. */}
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
                // Accessors, not consts: the threshold moves with the list.
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
                          <span class="restore-flag" title="Far more than this world's usual minute.">
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
                              ? 'This is the world you are already in.'
                              : 'Arm this restore point.'
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
                          title="Roll the whole world back to this moment, for everyone."
                          onClick={() => applyRollback(point.id)}
                        >
                          Roll back to {formatWhen(point.createdAt)}
                        </button>
                        <button
                          type="button"
                          class="chart-button"
                          title="Leave the world as it is."
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
