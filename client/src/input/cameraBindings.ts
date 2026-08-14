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

export function bindCameraControls(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): CameraBindings {
  // Sane state before the first press (and for anything that inspects
  // mouseButtons outside a press, e.g. devtools).
  applyBindings(controls, NO_MODIFIERS);

  const onPointerDownCapture = (event: PointerEvent): void => {
    // Recompute all three buttons from this press's modifier state; the one
    // OrbitControls is about to look up is the one that matters. Rebinding
    // mid-session needs no extra wiring — every press re-derives from the
    // current bindings.
    applyBindings(controls, event);
  };

  canvas.addEventListener('pointerdown', onPointerDownCapture, {
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
      wheelGestures.dispose();
    },
  };
}
