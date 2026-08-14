// Tells a trackpad two-finger scroll apart from a mouse wheel notch.
//
// WHY THIS EXISTS: a browser reports both through the SAME `wheel` event, and
// OrbitControls treats every wheel event as a dolly. On a MacBook that makes an
// idle two-finger scroll — the most reflexive gesture there is — zoom the
// camera violently. The fix is to classify the event first and hand only real
// mouse notches to OrbitControls; pinches dolly explicitly and trackpad scrolls
// pan the map (input/wheelCamera.ts).
//
// This module is PURE on purpose: no DOM types, no clock, no signals. The
// caller supplies the timestamp and threads the returned state back in, so the
// whole state machine — including the gesture lock, which is time-dependent —
// is unit-testable with synthetic timestamps.

import {
  WHEEL_GESTURE_GAP_MS,
  WHEEL_MOUSE_NOTCH_MIN_DELTA,
} from '../config.ts';
import type { WheelBehaviour } from '../state/controlPrefs.ts';

/** What a wheel event should drive. */
export type WheelGesture =
  /** Trackpad pinch: dolly the camera ourselves. */
  | 'pinch-zoom'
  /** Trackpad two-finger scroll: translate across the ground plane. */
  | 'trackpad-pan'
  /** A discrete mouse notch: leave it for OrbitControls' own handler. */
  | 'mouse';

/**
 * The fields of a `WheelEvent` this classifier reads. Declared structurally so
 * tests can pass plain objects and so nothing here depends on lib.dom.
 */
export interface WheelSample {
  readonly ctrlKey: boolean;
  /** `WheelEvent.deltaMode`; 0 is DOM_DELTA_PIXEL. */
  readonly deltaMode: number;
  readonly deltaX: number;
  readonly deltaY: number;
  /** Milliseconds on any single monotonic clock (event.timeStamp works). */
  readonly timeStamp: number;
}

/**
 * Carried between events by the caller. `null` means "no gesture in flight",
 * which is also the correct starting value.
 */
export interface WheelGestureState {
  readonly gesture: WheelGesture;
  readonly lastEventMs: number;
}

/** `WheelEvent.DOM_DELTA_PIXEL`. Line/page modes only ever come from a mouse. */
const DOM_DELTA_PIXEL = 0;

/**
 * Classifies one event on its own merits — no history. See classifyWheel for
 * the gesture lock that wraps this.
 */
function classifyFresh(
  sample: WheelSample,
  behaviour: WheelBehaviour,
): WheelGesture {
  // A pinch is unambiguous: Chrome, Firefox and Edge all encode a trackpad
  // pinch as a wheel event with ctrlKey set (no key is actually held). It is
  // therefore decided before the manual override — the override exists to
  // resolve AMBIGUOUS hardware, and a pinch is never ambiguous.
  if (sample.ctrlKey) return 'pinch-zoom';

  // Manual override: the escape hatch for hardware the heuristic below reads
  // wrong. 'zoom' hands every non-pinch wheel back to OrbitControls (the
  // Phase 1 behaviour); 'pan' treats every one as a trackpad scroll.
  if (behaviour === 'zoom') return 'mouse';
  if (behaviour === 'pan') return 'trackpad-pan';

  // Line- and page-mode deltas come from a classic wheel; a trackpad always
  // reports pixels.
  if (sample.deltaMode !== DOM_DELTA_PIXEL) return 'mouse';

  // Three independent trackpad tells, any one of which is enough:
  //  - a horizontal component at all (a wheel has no X axis),
  //  - a fractional delta (notches are whole numbers),
  //  - a delta too small to be a notch (see WHEEL_MOUSE_NOTCH_MIN_DELTA).
  if (
    sample.deltaX !== 0 ||
    !Number.isInteger(sample.deltaY) ||
    Math.abs(sample.deltaY) < WHEEL_MOUSE_NOTCH_MIN_DELTA
  ) {
    return 'trackpad-pan';
  }

  return 'mouse';
}

/**
 * Classifies one wheel event, given the state returned for the previous one.
 *
 * GESTURE LOCK: events less than WHEEL_GESTURE_GAP_MS apart are one continuous
 * gesture and keep the FIRST classification. Without it a single mid-stream
 * delta that happens to look like a notch (a trackpad scroll can emit a whole
 * number ≥ the threshold at speed) would flip a pan into a zoom halfway
 * through — the exact jolt this module exists to prevent.
 *
 * The one thing that breaks the lock is ctrlKey: the user putting two fingers
 * down to pinch during scroll momentum means the pinch, and there is no
 * ambiguity to protect them from. The lock guards the heuristic, not the
 * unambiguous signal.
 *
 * A timestamp that goes backwards (clock swap, replayed event) is treated as a
 * new gesture rather than trusted to be within the gap.
 */
export function classifyWheel(
  sample: WheelSample,
  previous: WheelGestureState | null,
  behaviour: WheelBehaviour,
): WheelGestureState {
  const gesture = ((): WheelGesture => {
    if (previous === null) return classifyFresh(sample, behaviour);
    const gapMs = sample.timeStamp - previous.lastEventMs;
    if (gapMs < 0 || gapMs >= WHEEL_GESTURE_GAP_MS) {
      return classifyFresh(sample, behaviour);
    }
    if (sample.ctrlKey) return 'pinch-zoom';
    return previous.gesture;
  })();

  return { gesture, lastEventMs: sample.timeStamp };
}
