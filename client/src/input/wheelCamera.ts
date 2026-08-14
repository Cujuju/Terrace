// Trackpad camera gestures: pinch to zoom, two-finger scroll to pan the map.
//
// Installed by input/cameraBindings.ts. The classification of "is this a
// trackpad or a mouse wheel" lives in input/wheelGestures.ts (pure, tested);
// this module owns only the DOM plumbing and the camera maths.
//
// HOW IT COEXISTS WITH ORBITCONTROLS: OrbitControls registers its own
// non-capturing `wheel` listener on the same canvas, and it dollies on every
// event it sees. Our listener is registered in the CAPTURE phase, which the DOM
// dispatch algorithm runs before the non-capturing listeners of the same
// element, so we get first refusal on every wheel event:
//   - mouse notch  → return without touching the event; OrbitControls dollies
//                    it exactly as it did in Phase 1, damping and all.
//   - pinch or pan → preventDefault (no browser page zoom / no history swipe)
//                    + stopImmediatePropagation, so OrbitControls never sees it,
//                    and we move the camera ourselves.
//
// Both gestures write `camera.position` (and, for a pan, `controls.target`)
// directly. That is safe by construction: OrbitControls.update() re-derives its
// spherical offset from `position - target` at the top of every frame, so an
// external move is picked up rather than fought — and a pan that moves BOTH by
// the same vector leaves that offset untouched, so it cannot disturb an
// in-flight damped orbit.

import { Vector3 } from 'three';
import type { Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  PINCH_ZOOM_BASE,
  TRACKPAD_PAN_SPEED,
} from '../config.ts';
import { wheelBehaviour } from '../state/controlPrefs.ts';
import { classifyWheel, type WheelGestureState } from './wheelGestures.ts';

export interface WheelCameraGestures {
  dispose(): void;
}

/**
 * Scratch vectors. Module scope (three's own convention) because every handler
 * below runs to completion synchronously on the one JS thread — no two uses can
 * ever interleave.
 */
const scratchOffset = new Vector3();
const scratchRight = new Vector3();
const scratchForward = new Vector3();
const scratchMove = new Vector3();

/**
 * Squared length under which a ground-projected camera axis is treated as
 * having no ground direction at all. Reached when the camera looks straight
 * down (OrbitControls' default minPolarAngle is 0, so the user can orbit
 * there): the view direction is then vertical and its X/Z part is numerical
 * noise, which normalises to a random heading and would send a pan sideways.
 */
const MIN_GROUND_AXIS_LENGTH_SQ = 1e-8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fills `right` and `forward` with the ground-parallel screen axes of the
 * camera: screen-right and screen-up, both flattened onto the XZ plane and
 * normalised. Panning along these is what makes a two-finger scroll feel like
 * dragging the map rather than sliding the camera through the air.
 *
 * Reads `camera.matrix` — the same source OrbitControls' own pan uses. It is
 * recomposed once per frame by the renderer, so it can be one frame stale in
 * ORIENTATION; that is imperceptible, and it is the rotation columns only that
 * are read here (our own position writes never invalidate them).
 */
function groundAxes(camera: Camera, right: Vector3, forward: Vector3): void {
  // Column 0 is the camera's local +X in world space: screen-right.
  right.setFromMatrixColumn(camera.matrix, 0);
  right.y = 0;
  right.normalize();

  // A camera looks down its local -Z, so column 2 negated is the view
  // direction: screen-up once flattened onto the ground.
  forward.setFromMatrixColumn(camera.matrix, 2).negate();
  forward.y = 0;
  if (forward.lengthSq() < MIN_GROUND_AXIS_LENGTH_SQ) {
    // Straight down: the camera's own up axis (column 1) is what points up the
    // screen in ground terms. OrbitControls keeps the camera unrolled, so this
    // is always horizontal in exactly the case the view direction is not.
    forward.setFromMatrixColumn(camera.matrix, 1);
    forward.y = 0;
  }
  forward.normalize();
}

/**
 * Moves the camera to `distance` from the orbit target along the current view
 * ray, clamped to the configured zoom bounds. The target is left alone — this
 * is a dolly, not a pan.
 */
function setOrbitDistance(
  camera: Camera,
  target: Vector3,
  distance: number,
): void {
  scratchOffset.copy(camera.position).sub(target);
  const current = scratchOffset.length();
  // Camera exactly on its target: no ray to travel along, and no gesture can
  // put it there (the minimum distance is enforced on every path).
  if (current === 0) return;
  const wanted = clamp(distance, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
  camera.position.copy(target).addScaledVector(scratchOffset, wanted / current);
}

/**
 * Safari's proprietary pinch events. They are not in lib.dom, so the shape is
 * declared here — deliberately minimal: `scale` is the pinch magnification
 * relative to the START of the gesture (1 at gesturestart, >1 fingers apart).
 * Everything else on the event is unused. Feature-detected before use; Chrome,
 * Firefox and Edge never fire these (they send ctrl+wheel instead, which the
 * classifier reads as a pinch).
 */
interface SafariGestureEvent extends Event {
  readonly scale: number;
}

export function bindWheelCamera(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): WheelCameraGestures {
  const camera = controls.object;

  /** Threaded through classifyWheel; null until the first wheel event. */
  let gestureState: WheelGestureState | null = null;

  const dollyByPinchDelta = (deltaY: number): void => {
    // Exponential in the delta so the gesture is scale-invariant: the same
    // finger travel is the same zoom ratio whether close in or far out.
    // deltaY < 0 is the platform convention for "zoom in", and a base above 1
    // maps that to a shorter distance.
    const distance = camera.position.distanceTo(controls.target);
    setOrbitDistance(
      camera,
      controls.target,
      distance * Math.pow(PINCH_ZOOM_BASE, deltaY),
    );
  };

  const panByWheelDelta = (deltaX: number, deltaY: number): void => {
    groundAxes(camera, scratchRight, scratchForward);
    // Scale by the camera's distance from its target: at ten times the height
    // a pixel of finger travel covers ten times the ground, so the map appears
    // to move under the fingers at the same rate at every zoom level.
    const speed = camera.position.distanceTo(controls.target) * TRACKPAD_PAN_SPEED;
    // Wheel convention: positive delta scrolls the VIEWPORT right/down. On the
    // ground plane screen-down is -forward, hence the negation on Y — the
    // scene then travels with the fingers, as it does in every map app.
    scratchMove
      .set(0, 0, 0)
      .addScaledVector(scratchRight, deltaX * speed)
      .addScaledVector(scratchForward, -deltaY * speed);
    // Both ends move together: the orbit offset is unchanged, so this is a pure
    // translation and the next OrbitControls.update() has nothing to correct.
    camera.position.add(scratchMove);
    controls.target.add(scratchMove);
  };

  const onWheelCapture = (event: WheelEvent): void => {
    gestureState = classifyWheel(
      {
        ctrlKey: event.ctrlKey,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        timeStamp: event.timeStamp,
      },
      gestureState,
      wheelBehaviour(),
    );

    // A mouse notch is OrbitControls' business. Leave the event completely
    // untouched — including its default — so its handler behaves as before.
    if (gestureState.gesture === 'mouse') return;

    // Ours now: no browser page zoom (ctrl+wheel), no two-finger back-swipe,
    // and no OrbitControls dolly on top of what we are about to do.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (controls.enabled === false) return;
    if (gestureState.gesture === 'pinch-zoom') {
      if (controls.enableZoom === false) return;
      dollyByPinchDelta(event.deltaY);
      return;
    }
    if (controls.enablePan === false) return;
    panByWheelDelta(event.deltaX, event.deltaY);
  };

  canvas.addEventListener('wheel', onWheelCapture, {
    capture: true,
    // Required: a passive listener may not preventDefault, and preventDefault
    // is precisely how the page is stopped from zooming under a pinch.
    passive: false,
  });

  // ---- Safari pinch --------------------------------------------------------
  // Safari reports a trackpad pinch as gesturestart/gesturechange/gestureend
  // with a cumulative `scale`, not as ctrl+wheel. Distance is recomputed from
  // the distance at gesturestart on every change, so rounding cannot drift and
  // hitting a zoom limit mid-pinch does not lose the anchor.

  const supportsGestureEvents = 'ongesturestart' in window;
  let pinchStartDistance = 0;

  const onGestureStart = (event: Event): void => {
    event.preventDefault();
    pinchStartDistance = camera.position.distanceTo(controls.target);
  };

  const onGestureChange = (event: Event): void => {
    event.preventDefault();
    if (controls.enabled === false || controls.enableZoom === false) return;
    const { scale } = event as SafariGestureEvent;
    // A zero or negative scale is not a thing Safari sends; refuse to divide
    // by it if it ever does.
    if (!(scale > 0)) return;
    // Fingers apart (scale > 1) means zoom in, which is a SHORTER distance.
    setOrbitDistance(camera, controls.target, pinchStartDistance / scale);
  };

  const onGestureEnd = (event: Event): void => {
    event.preventDefault();
  };

  if (supportsGestureEvents) {
    canvas.addEventListener('gesturestart', onGestureStart, { passive: false });
    canvas.addEventListener('gesturechange', onGestureChange, { passive: false });
    canvas.addEventListener('gestureend', onGestureEnd, { passive: false });
  }

  return {
    dispose(): void {
      canvas.removeEventListener('wheel', onWheelCapture, { capture: true });
      if (supportsGestureEvents) {
        canvas.removeEventListener('gesturestart', onGestureStart);
        canvas.removeEventListener('gesturechange', onGestureChange);
        canvas.removeEventListener('gestureend', onGestureEnd);
      }
    },
  };
}
