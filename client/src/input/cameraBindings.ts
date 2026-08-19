// Applies the user's control bindings to OrbitControls.
//
// OrbitControls decides what a button does by reading `controls.mouseButtons`
// inside its own pointerdown handler — it has no concept of modifier keys.
// Rather than fork or wrap its input path, this module updates `mouseButtons`
// JUST IN TIME: a capture-phase pointerdown listener (capture runs before
// OrbitControls' bubble-phase handler on the same element) asks the shared
// resolver who owns the press and maps each button to ROTATE, PAN, or null
// accordingly. The brush (input/sculptInput.ts) consults the same resolver,
// so a button the brush claims is always null here and vice versa — the two
// input owners cannot fight over a drag by construction.

import { MOUSE, TOUCH } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  TOUCH_DOLLY_MAX_STEP_RATIO,
  TOUCH_DOLLY_MIN_SEPARATION_PX,
} from '../config.ts';
import {
  resolvePress,
  twoFingerGesture,
  type ModifierState,
  type MouseButtonName,
} from '../state/controlPrefs.ts';
import { bindWheelCamera } from './wheelCamera.ts';

export interface CameraBindings {
  dispose(): void;
}

/** Camera verb for one button under the given modifier state, else null. */
function cameraVerb(
  button: MouseButtonName,
  mods: ModifierState,
): MOUSE | null {
  // resolvePress wants the numeric PointerEvent.button; invert buttonName.
  const eventButton = button === 'left' ? 0 : button === 'middle' ? 1 : 2;
  switch (resolvePress(eventButton, mods)) {
    case 'orbit':
      return MOUSE.ROTATE;
    case 'pan':
      return MOUSE.PAN;
    default:
      // Sculpt-owned or unbound: OrbitControls must ignore this button.
      return null;
  }
}

function applyBindings(controls: OrbitControls, mods: ModifierState): void {
  controls.mouseButtons = {
    LEFT: cameraVerb('left', mods),
    MIDDLE: cameraVerb('middle', mods),
    RIGHT: cameraVerb('right', mods),
  };
  // Touch: one finger belongs to the sculpt brush (ONE: null keeps
  // OrbitControls' hands off it); two fingers always pinch-zoom, with the drag
  // component per the user's preference. Re-derived on every press, so a
  // preference change applies to the very next gesture.
  controls.touches = {
    ONE: null,
    TWO:
      twoFingerGesture() === 'orbit' ? TOUCH.DOLLY_ROTATE : TOUCH.DOLLY_PAN,
  };
}

const NO_MODIFIERS: ModifierState = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
};

// ---------------------------------------------------------------------------
// Touch-dolly guard (2026-08-19).
//
// OrbitControls' two-finger dolly divides this move's finger separation by the
// last one it saw (`_dollyEnd.y / _dollyStart.y`, unguarded — verified in
// three 0.185.1). iOS coalesces two adjacent touches into one contact and
// re-splits them, so a two-finger tap can report a separation collapsing to
// ~zero for a frame; that one frame's ratio dollies the camera by hundreds of
// times, slamming the orbit distance to a zoom clamp. At the 900-unit far
// clamp the whole world is a distant overview — which the owner read as "the
// camera reset to a default location" — and the next drag pans at
// distance-scaled speed, the earlier "jumps across the map".
//
// Reproduced 2026-08-19 via CDP touch injection (client/test fixtures mirror
// it): a 200px→1px separation step slammed distance 80→900; a 0px pair's
// first spread slammed 80→20; even an honest 4px tap lurched 80→52.
//
// The guard sits in front of OrbitControls — three stays unpatched — with two
// independent layers (either alone stops the reproduction):
//   1. A pair born closer than TOUCH_DOLLY_MIN_SEPARATION_PX is a merged
//      contact, not a pinch: the capture-phase pointerdown rebind hands
//      OrbitControls `TWO: null` for that gesture, so it never starts.
//   2. A move showing a per-event separation step beyond
//      TOUCH_DOLLY_MAX_STEP_RATIO (or under the floor) is swallowed at
//      document capture before OrbitControls' document-level handler runs.
//      The baseline only advances on moves OrbitControls actually saw, so a
//      swallowed frame costs nothing: the true separation passes next event.
//
// Only touch pointers that went down on the canvas are tracked, and only
// exactly-two-pointer states are ever judged: mouse input, HUD touches and
// three-finger states pass through untouched.
// ---------------------------------------------------------------------------

/** What the guard says to do with one touch pointermove. */
export type TouchMoveVerdict = 'pass' | 'swallow';

export interface TouchDollyGuard {
  /** A touch pointer went down on the canvas. */
  down(pointerId: number, x: number, y: number): void;
  /** A touch pointer moved; the verdict applies to THIS event. */
  move(pointerId: number, x: number, y: number): TouchMoveVerdict;
  /** A touch pointer lifted or was cancelled. */
  up(pointerId: number): void;
  /**
   * True while exactly two tracked touches are down AND they were born (or
   * re-paired) closer than the merge floor — the state in which OrbitControls
   * must not be allowed to start a two-finger gesture at all.
   */
  pairIsDegenerate(): boolean;
}

export function createTouchDollyGuard(): TouchDollyGuard {
  const positions = new Map<number, { x: number; y: number }>();
  /**
   * Separation OrbitControls last ACCEPTED (its `_dollyStart`), or null while
   * the pair is degenerate/absent. Mirroring what OrbitControls saw — not the
   * raw finger truth — is the point: its next ratio is computed against this.
   */
  let acceptedSeparation: number | null = null;
  let degenerate = false;

  const separation = (): number | null => {
    if (positions.size !== 2) return null;
    const [a, b] = [...positions.values()];
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  /** (Re)judges the pair whenever the tracked set changes size to two. */
  const repair = (): void => {
    const sep = separation();
    if (sep === null) {
      acceptedSeparation = null;
      degenerate = false;
      return;
    }
    degenerate = sep < TOUCH_DOLLY_MIN_SEPARATION_PX;
    acceptedSeparation = degenerate ? null : sep;
  };

  return {
    down(pointerId, x, y): void {
      positions.set(pointerId, { x, y });
      repair();
    },
    move(pointerId, x, y): TouchMoveVerdict {
      const position = positions.get(pointerId);
      // Not ours (mouse, a HUD-born touch): never interfere.
      if (position === undefined) return 'pass';
      position.x = x;
      position.y = y;
      const sep = separation();
      // One or three fingers: OrbitControls is not dollying; stay out.
      if (sep === null) return 'pass';
      // Degenerate pair: TWO was nulled at pointerdown, so OrbitControls is
      // inert anyway — swallowing is the second, independent layer.
      if (acceptedSeparation === null) return 'swallow';
      if (sep < TOUCH_DOLLY_MIN_SEPARATION_PX) return 'swallow';
      const ratio = sep / acceptedSeparation;
      if (
        ratio > TOUCH_DOLLY_MAX_STEP_RATIO ||
        ratio < 1 / TOUCH_DOLLY_MAX_STEP_RATIO
      ) {
        return 'swallow';
      }
      acceptedSeparation = sep;
      return 'pass';
    },
    up(pointerId): void {
      positions.delete(pointerId);
      repair();
    },
    pairIsDegenerate(): boolean {
      return degenerate;
    },
  };
}

export function bindCameraControls(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): CameraBindings {
  // Sane state before the first press (and for anything that inspects
  // mouseButtons outside a press, e.g. devtools).
  applyBindings(controls, NO_MODIFIERS);

  const guard = createTouchDollyGuard();

  const onPointerDownCapture = (event: PointerEvent): void => {
    // Recompute all three buttons from this press's modifier state; the one
    // OrbitControls is about to look up is the one that matters. Rebinding
    // mid-session needs no extra wiring — every press re-derives from the
    // current bindings.
    applyBindings(controls, event);
    if (event.pointerType !== 'touch') return;
    guard.down(event.pointerId, event.pageX, event.pageY);
    // A pair born under the merge floor is one coalesced contact, not a
    // pinch: hand OrbitControls no TWO gesture for it. This must happen on
    // the capture phase of the SECOND finger's pointerdown — OrbitControls
    // reads `touches.TWO` inside its own bubble-phase handler for this very
    // event. The next pointerdown's applyBindings restores the binding.
    if (guard.pairIsDegenerate()) {
      controls.touches = { ONE: null, TWO: null };
    }
  };

  // Moves and lifts are judged at DOCUMENT capture: OrbitControls listens for
  // them on the document (it captures only the first pointer to the canvas),
  // and document capture is the one phase that runs before that listener for
  // every delivery path. Lifts are never swallowed — losing a pointerup is
  // how trackers corrupt.
  const onPointerMoveCapture = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    if (guard.move(event.pointerId, event.pageX, event.pageY) === 'swallow') {
      event.stopImmediatePropagation();
    }
  };
  const onPointerEndCapture = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    guard.up(event.pointerId);
  };

  canvas.addEventListener('pointerdown', onPointerDownCapture, {
    capture: true,
  });
  const doc = canvas.ownerDocument;
  doc.addEventListener('pointermove', onPointerMoveCapture, { capture: true });
  doc.addEventListener('pointerup', onPointerEndCapture, { capture: true });
  doc.addEventListener('pointercancel', onPointerEndCapture, {
    capture: true,
  });

  // Wheel events are the other half of camera input and follow the same
  // capture-phase pattern; kept in a sibling module because they carry camera
  // maths of their own rather than binding lookups.
  const wheelGestures = bindWheelCamera(canvas, controls);

  return {
    dispose(): void {
      canvas.removeEventListener('pointerdown', onPointerDownCapture, {
        capture: true,
      });
      doc.removeEventListener('pointermove', onPointerMoveCapture, {
        capture: true,
      });
      doc.removeEventListener('pointerup', onPointerEndCapture, {
        capture: true,
      });
      doc.removeEventListener('pointercancel', onPointerEndCapture, {
        capture: true,
      });
      wheelGestures.dispose();
    },
  };
}
