// Contract tests for the wheel classifier (src/input/wheelGestures.ts).
//
// This is the module that decides whether a `wheel` event zooms, pans, or is
// handed to OrbitControls, and getting it wrong is what made a MacBook
// two-finger scroll lurch the camera. It is pure and clock-free by design, so
// every rule — including the time-dependent gesture lock — is driven here with
// synthetic timestamps rather than a real trackpad.

import { describe, expect, it } from 'vitest';
import {
  WHEEL_GESTURE_GAP_MS,
  WHEEL_MOUSE_NOTCH_MIN_DELTA,
} from '../src/config.ts';
import {
  classifyWheel,
  type WheelGestureState,
  type WheelSample,
} from '../src/input/wheelGestures.ts';

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** A wheel event with everything defaulted to "plain pixel-mode scroll". */
function sample(overrides: Partial<WheelSample> = {}): WheelSample {
  return {
    ctrlKey: false,
    deltaMode: DOM_DELTA_PIXEL,
    deltaX: 0,
    deltaY: 0,
    timeStamp: 0,
    ...overrides,
  };
}

/** Classifies one event with no history, in 'auto' mode. */
function classifyAlone(overrides: Partial<WheelSample>): string {
  return classifyWheel(sample(overrides), null, 'auto').gesture;
}

/** A typical discrete mouse notch: whole, pixel-mode, well over the threshold. */
const MOUSE_NOTCH_DELTA = 120;

describe('classifyWheel: pinch', () => {
  it('reads ctrlKey as a pinch whatever else the event says', () => {
    expect(classifyAlone({ ctrlKey: true, deltaY: -4.5 })).toBe('pinch-zoom');
    expect(classifyAlone({ ctrlKey: true, deltaY: MOUSE_NOTCH_DELTA })).toBe(
      'pinch-zoom',
    );
    expect(
      classifyAlone({
        ctrlKey: true,
        deltaMode: DOM_DELTA_LINE,
        deltaY: 3,
      }),
    ).toBe('pinch-zoom');
  });

  it('outranks the manual override — a pinch is never ambiguous', () => {
    for (const behaviour of ['auto', 'zoom', 'pan'] as const) {
      expect(
        classifyWheel(sample({ ctrlKey: true, deltaY: -2 }), null, behaviour)
          .gesture,
      ).toBe('pinch-zoom');
    }
  });
});

describe('classifyWheel: mouse vs trackpad in auto mode', () => {
  it('treats non-pixel delta modes as a mouse', () => {
    expect(classifyAlone({ deltaMode: DOM_DELTA_LINE, deltaY: 3 })).toBe('mouse');
    expect(classifyAlone({ deltaMode: DOM_DELTA_PAGE, deltaY: 1 })).toBe('mouse');
    // Even with a horizontal component: a line-mode event is not a trackpad.
    expect(
      classifyAlone({ deltaMode: DOM_DELTA_LINE, deltaX: 2, deltaY: 3 }),
    ).toBe('mouse');
  });

  it('treats a whole, large, purely vertical pixel delta as a mouse notch', () => {
    expect(classifyAlone({ deltaY: MOUSE_NOTCH_DELTA })).toBe('mouse');
    expect(classifyAlone({ deltaY: -MOUSE_NOTCH_DELTA })).toBe('mouse');
    // Exactly at the threshold counts as a notch (the bound is inclusive).
    expect(classifyAlone({ deltaY: WHEEL_MOUSE_NOTCH_MIN_DELTA })).toBe('mouse');
  });

  it('treats any horizontal component as a trackpad', () => {
    // A wheel has no X axis, so deltaX alone settles it — even when deltaY
    // looks exactly like a notch.
    expect(classifyAlone({ deltaX: 1, deltaY: MOUSE_NOTCH_DELTA })).toBe(
      'trackpad-pan',
    );
    expect(classifyAlone({ deltaX: -0.5, deltaY: 0 })).toBe('trackpad-pan');
  });

  it('treats a fractional delta as a trackpad', () => {
    expect(classifyAlone({ deltaY: 120.5 })).toBe('trackpad-pan');
    expect(classifyAlone({ deltaY: -0.25 })).toBe('trackpad-pan');
  });

  it('treats a sub-notch delta as a trackpad', () => {
    expect(classifyAlone({ deltaY: WHEEL_MOUSE_NOTCH_MIN_DELTA - 1 })).toBe(
      'trackpad-pan',
    );
    expect(classifyAlone({ deltaY: -(WHEEL_MOUSE_NOTCH_MIN_DELTA - 1) })).toBe(
      'trackpad-pan',
    );
  });
});

describe('classifyWheel: manual override', () => {
  it("'zoom' sends every non-pinch wheel to OrbitControls", () => {
    // Including deltas the heuristic would have called a trackpad — that is
    // the entire point of the override.
    expect(
      classifyWheel(sample({ deltaX: 3, deltaY: -1.5 }), null, 'zoom').gesture,
    ).toBe('mouse');
    expect(
      classifyWheel(sample({ deltaY: MOUSE_NOTCH_DELTA }), null, 'zoom').gesture,
    ).toBe('mouse');
  });

  it("'pan' sends every non-pinch wheel to the map pan", () => {
    expect(
      classifyWheel(sample({ deltaY: MOUSE_NOTCH_DELTA }), null, 'pan').gesture,
    ).toBe('trackpad-pan');
    expect(
      classifyWheel(sample({ deltaMode: DOM_DELTA_LINE, deltaY: 3 }), null, 'pan')
        .gesture,
    ).toBe('trackpad-pan');
  });

  it("'auto' leaves the heuristic in charge", () => {
    expect(classifyAlone({ deltaY: MOUSE_NOTCH_DELTA })).toBe('mouse');
    expect(classifyAlone({ deltaY: 2.5 })).toBe('trackpad-pan');
  });
});

describe('classifyWheel: gesture lock', () => {
  /** Feeds a stream of samples through the classifier, returning every verdict. */
  function classifyStream(
    samples: readonly WheelSample[],
    behaviour: 'auto' | 'zoom' | 'pan' = 'auto',
  ): string[] {
    let state: WheelGestureState | null = null;
    return samples.map((s) => {
      state = classifyWheel(s, state, behaviour);
      return state.gesture;
    });
  }

  it('keeps a pan a pan when one mid-stream delta looks like a notch', () => {
    // The regression this module exists for: a fast two-finger flick emits a
    // whole, large, purely vertical delta partway through.
    const verdicts = classifyStream([
      sample({ deltaY: -2.5, timeStamp: 1000 }),
      sample({ deltaY: -18.5, timeStamp: 1016 }),
      sample({ deltaY: -MOUSE_NOTCH_DELTA, timeStamp: 1032 }), // notch-shaped
      sample({ deltaY: -12.25, timeStamp: 1048 }),
    ]);
    expect(verdicts).toEqual([
      'trackpad-pan',
      'trackpad-pan',
      'trackpad-pan',
      'trackpad-pan',
    ]);
  });

  it('keeps a mouse stream a mouse stream through one odd delta', () => {
    const verdicts = classifyStream([
      sample({ deltaY: MOUSE_NOTCH_DELTA, timeStamp: 0 }),
      sample({ deltaY: 1.5, timeStamp: 50 }), // trackpad-shaped
      sample({ deltaY: MOUSE_NOTCH_DELTA, timeStamp: 100 }),
    ]);
    expect(verdicts).toEqual(['mouse', 'mouse', 'mouse']);
  });

  it('reclassifies once the events are a full gap apart', () => {
    const verdicts = classifyStream([
      sample({ deltaY: -2.5, timeStamp: 0 }),
      // Exactly one gap later: the previous gesture is over, so this event is
      // judged on its own merits.
      sample({ deltaY: MOUSE_NOTCH_DELTA, timeStamp: WHEEL_GESTURE_GAP_MS }),
    ]);
    expect(verdicts).toEqual(['trackpad-pan', 'mouse']);
  });

  it('holds the lock right up to the gap', () => {
    const verdicts = classifyStream([
      sample({ deltaY: -2.5, timeStamp: 0 }),
      sample({
        deltaY: MOUSE_NOTCH_DELTA,
        timeStamp: WHEEL_GESTURE_GAP_MS - 1,
      }),
    ]);
    expect(verdicts).toEqual(['trackpad-pan', 'trackpad-pan']);
  });

  it('measures the gap from the last event, not the first', () => {
    // A continuous stream stays locked however long it runs.
    const verdicts = classifyStream([
      sample({ deltaY: -2.5, timeStamp: 0 }),
      sample({ deltaY: -3.5, timeStamp: 150 }),
      sample({ deltaY: MOUSE_NOTCH_DELTA, timeStamp: 300 }),
    ]);
    expect(verdicts).toEqual(['trackpad-pan', 'trackpad-pan', 'trackpad-pan']);
  });

  it('lets a pinch break the lock — ctrlKey is not ambiguous', () => {
    const verdicts = classifyStream([
      sample({ deltaY: -2.5, timeStamp: 0 }),
      sample({ ctrlKey: true, deltaY: -4, timeStamp: 16 }),
      sample({ ctrlKey: true, deltaY: -6, timeStamp: 32 }),
    ]);
    expect(verdicts).toEqual(['trackpad-pan', 'pinch-zoom', 'pinch-zoom']);
  });

  it('treats a backwards timestamp as a new gesture rather than trusting it', () => {
    const verdicts = classifyStream([
      sample({ deltaY: -2.5, timeStamp: 1000 }),
      sample({ deltaY: MOUSE_NOTCH_DELTA, timeStamp: 10 }),
    ]);
    expect(verdicts).toEqual(['trackpad-pan', 'mouse']);
  });

  it('locks under a forced behaviour too, and reports the last timestamp', () => {
    const first = classifyWheel(
      sample({ deltaY: MOUSE_NOTCH_DELTA, timeStamp: 500 }),
      null,
      'pan',
    );
    expect(first).toEqual({ gesture: 'trackpad-pan', lastEventMs: 500 });
    const second = classifyWheel(
      sample({ deltaY: MOUSE_NOTCH_DELTA, timeStamp: 510 }),
      first,
      'pan',
    );
    expect(second).toEqual({ gesture: 'trackpad-pan', lastEventMs: 510 });
  });
});
