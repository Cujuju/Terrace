// Wheel and trackpad camera gestures: pinch to zoom, scroll to pan the map.
//
// Installed by input/cameraBindings.ts.
//
// THE RULE, and it is deliberately not a heuristic: a pinch zooms, and every
// other wheel event pans. OrbitControls dollies on every wheel event it sees,
// which on a MacBook made an idle two-finger scroll — the most reflexive
// gesture on the machine — lurch the camera. Trying to tell a trackpad scroll
// from a mouse notch by inspecting deltas is guesswork that fails on some
// hardware every time; panning on all of them is one predictable rule, and the
// mouse users who want a zooming wheel say so once in the Controls panel
// (state/controlPrefs.ts, 'zoom').
//
// HOW IT COEXISTS WITH ORBITCONTROLS: OrbitControls registers its own
// non-capturing `wheel` listener on the same canvas. Ours is registered in the
// CAPTURE phase, which the DOM dispatch algorithm runs before the
// non-capturing listeners of the same element, so we get first refusal:
//   - pinch, or scroll in 'pan' mode → preventDefault (no browser page zoom,
//     no two-finger back-swipe) + stopImmediatePropagation, so OrbitControls
//     never sees the event, and we move the camera ourselves.
//   - scroll in 'zoom' mode        → return without touching the event, and
//     OrbitControls dollies it exactly as it did in Phase 1, damping and all.
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

export interface WheelCameraGestures {
  dispose(): void;
}

/**
 * Scratch vectors. Module scope (three's own convention) because every function
 * below runs to completion synchronously on the one JS thread — no two uses can
 * ever interleave.
 */
const scratchOffset = new Vector3();
const scratchRight = new Vector3();
const scratchForward = new Vector3();
const scratchMove = new Vector3();

/**
 * Squared length under which a ground-projected camera axis is treated as
 * having no ground direction at all — i.e. a horizontal component below 1e-3
 * of a unit vector, which is a camera within 0.06° of straight down.
 *
 * That case is reachable: OrbitControls' default minPolarAngle is 0, so the
 * user can orbit to vertical, and three's own lookAt nudges the degenerate
 * orientation by 1e-4 rather than leaving it undefined. Normalising a vector
 * that short amplifies float noise into an arbitrary heading, which would send
 * a pan off sideways; the threshold sits above the nudge so the fallback below
 * takes over before that can happen.
 */
const MIN_GROUND_AXIS_LENGTH_SQ = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fills `right` and `forward` with the ground-parallel screen axes of the
 * camera: screen-right and screen-up, both flattened onto the XZ plane and
 * normalised. Panning along these is what makes a scroll feel like dragging the
 * map rather than sliding the camera through the air.
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
 * The ground-parallel translation one wheel event asks for, written into `out`
 * and returned. Exported for its unit tests: this vector IS the pan feel.
 *
 * Wheel convention: a positive delta scrolls the VIEWPORT right/down. On the
 * ground plane screen-down is -forward, hence the negation on Y — the scene
 * then travels with the fingers, as it does in every map app.
 *
 * The magnitude scales with the camera's distance from its target: at ten times
 * the height a pixel of finger travel covers ten times the ground, so the map
 * appears to move under the fingers at the same rate at every zoom level.
 */
export function groundPanOffset(
  camera: Camera,
  target: Vector3,
  deltaX: number,
  deltaY: number,
  out: Vector3,
): Vector3 {
  groundAxes(camera, scratchRight, scratchForward);
  const speed = camera.position.distanceTo(target) * TRACKPAD_PAN_SPEED;
  return out
    .set(0, 0, 0)
    .addScaledVector(scratchRight, deltaX * speed)
    .addScaledVector(scratchForward, -deltaY * speed);
}

/**
 * The orbit distance one pinch delta asks for, clamped to the zoom bounds.
 * Exported for its unit tests.
 *
 * Exponential in the delta so the gesture is scale-invariant: the same finger
 * travel is the same zoom RATIO whether close in or far out. deltaY < 0 is the
 * platform convention for "zoom in", and a base above 1 maps that to a shorter
 * distance.
 */
export function pinchZoomedDistance(distance: number, deltaY: number): number {
  return clamp(
    distance * Math.pow(PINCH_ZOOM_BASE, deltaY),
    CAMERA_MIN_DISTANCE,
    CAMERA_MAX_DISTANCE,
  );
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
 * Firefox and Edge never fire these (they send a wheel event with ctrlKey set
 * instead, which is the pinch signal this module reads).
 */
interface SafariGestureEvent extends Event {
  readonly scale: number;
}

export function bindWheelCamera(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): WheelCameraGestures {
  const camera = controls.object;

  const onWheelCapture = (event: WheelEvent): void => {
    // ctrlKey with no key held is how Chrome, Firefox and Edge encode a
    // trackpad pinch; a user actually holding ctrl to zoom means the same
    // thing. Either way it zooms, in both preference modes.
    const isPinch = event.ctrlKey;

    // 'zoom' mode: a plain scroll is OrbitControls' business. Leave the event
    // completely untouched — including its default — so its handler behaves
    // as it did before trackpad gestures existed.
    if (!isPinch && wheelBehaviour() === 'zoom') return;

    // Ours now: no browser page zoom (ctrl+wheel), no two-finger back-swipe,
    // and no OrbitControls dolly on top of what we are about to do.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (controls.enabled === false) return;
    if (isPinch) {
      if (controls.enableZoom === false) return;
      const distance = camera.position.distanceTo(controls.target);
      setOrbitDistance(
        camera,
        controls.target,
        pinchZoomedDistance(distance, event.deltaY),
      );
      return;
    }
    if (controls.enablePan === false) return;
    // Both ends move together: the orbit offset is unchanged, so this is a pure
    // translation and the next OrbitControls.update() has nothing to correct.
    groundPanOffset(
      camera,
      controls.target,
      event.deltaX,
      event.deltaY,
      scratchMove,
    );
    camera.position.add(scratchMove);
    controls.target.add(scratchMove);
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
