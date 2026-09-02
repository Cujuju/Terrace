// The AIM BANNER — the second step of an admin action (owner, 2026-09-01).
//
// A card in the admin panel ARMS an action; this strip, top-centre, says what
// is armed and that the next ground press fires it there, with a Cancel. The
// press itself is handled in main.tsx (the placement listener), which sends
// the request and clears the arm; the receipt that comes back is shown here
// for a few seconds, because the panel that would otherwise show it is
// closed — that is the whole point of aiming outside it.
//
// SOLID REACTIVITY: every reactive value is read through its accessor at the
// point of use — see Hud.tsx's header.

import { Show, createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import {
  armedAction,
  setArmedAction,
  worldFeedback,
  type WorldFeedback,
} from '../state/worldsState.ts';
import { refusalText } from './worldAdminCopy.ts';

/**
 * How long a receipt stays up after an aimed action, in milliseconds. Long
 * enough to read a two-clause sentence ("slide 3 started at (240, 252): drop
 * 5, run 41 cells"), short enough that it is gone before the next aim — the
 * next arm clears it anyway.
 */
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
  // The receipt on screen, if any; set when an actPlugin result arrives and
  // cleared by the timer or the next arm.
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
          <div class="world-banner admin-aim-banner" role="status" aria-live="polite">
            <span class="admin-aim-crosshair" aria-hidden="true" />
            <span>
              <strong>{armed().label}</strong> — click the ground where it should happen
            </span>
            <button
              type="button"
              class="chart-button admin-aim-cancel"
              title="Put the action down without firing it (Escape does the same)."
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
            class="world-banner admin-aim-banner admin-receipt"
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
