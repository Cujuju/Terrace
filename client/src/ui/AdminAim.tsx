import { Show, createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import {
  armedAction,
  setArmedAction,
  worldFeedback,
  type WorldFeedback,
} from '../state/worldsState.ts';
import { refusalText } from './worldAdminCopy.ts';

const RECEIPT_VISIBLE_MS = 6000;

type ActionReceipt = Extract<WorldFeedback, { kind: 'done' | 'refused' }>;

function actionReceipt(feedback: WorldFeedback): ActionReceipt | null {
  if (feedback.kind !== 'done' && feedback.kind !== 'refused') return null;
  return feedback.action === 'actPlugin' ? feedback : null;
}

function receiptTone(receipt: ActionReceipt): 'ok' | 'declined' | 'refused' {
  if (receipt.kind === 'done') return 'ok';
  return receipt.reason === 'actionDeclined' ? 'declined' : 'refused';
}

function receiptText(receipt: ActionReceipt): string {
  if (receipt.kind === 'done') return receipt.detail ?? 'Done.';
  if (receipt.reason === 'actionDeclined') return receipt.detail ?? refusalText(receipt.reason);
  return refusalText(receipt.reason);
}

export function AdminAim(): JSX.Element {
  const [receipt, setReceipt] = createSignal<ActionReceipt | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  createEffect(
    on(worldFeedback, (feedback) => {
      const next = actionReceipt(feedback);
      if (next === null) return;
      clearTimer();
      setReceipt(next);
      timer = setTimeout(() => setReceipt(null), RECEIPT_VISIBLE_MS);
    }, { defer: true }),
  );
  createEffect(
    on(armedAction, (armed) => {
      if (armed !== null) {
        clearTimer();
        setReceipt(null);
      }
    }, { defer: true }),
  );
  onCleanup(clearTimer);

  return (
    <>
      <Show when={armedAction()}>
        {(armed) => (
          <div class="admin-aim-banner" role="status" aria-live="polite">
            <span class="admin-aim-crosshair" aria-hidden="true" />
            <span>
              <strong>{armed().label}</strong> — click the ground where it should happen
            </span>
            <button
              type="button"
              class="chart-button admin-aim-cancel"
              title="Cancel: drop it unfired (or Escape)"
              onClick={() => setArmedAction(null)}
            >
              Cancel
            </button>
          </div>
        )}
      </Show>
      <Show when={receipt()}>
        {(shown) => (
          <div
            class="admin-aim-banner admin-receipt"
            classList={{ [`admin-receipt-${receiptTone(shown())}`]: true }}
            role="status"
            aria-live="polite"
          >
            <span class="admin-receipt-dot" aria-hidden="true" />
            <span>{receiptText(shown())}</span>
          </div>
        )}
      </Show>
    </>
  );
}
