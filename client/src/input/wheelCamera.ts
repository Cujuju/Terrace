// Wheel and trackpad camera gestures: manipulating the trackpad manipulates
// the world — pinch to zoom, scroll to pan the map, Alt+scroll (and, on
// Safari, a two-finger twist) to orbit it.
//
// Installed by input/cameraBindings.ts.
//
// THE RULE, and it is deliberately not a heuristic — every wheel event is
// classified by its modifier keys alone (see `classifyWheel`), never by
// guessing at its deltas:
//   - ctrl held (which is how Chrome, Firefox and Edge encode a trackpad
//     pinch) → zoom, in both preference modes.
//   - alt held → orbit, in both preference modes. Alt+scroll is an explicit
//     two-handed gesture, not the ambient scroll the 'zoom' preference is
//     about, so the preference has no say over it.
//   - anything else → the preference: in 'zoom' mode (the default — owner
//     decision 2026-08-19, issue #24) hand the event to OrbitControls; in
//     'pan' mode translate the map.
// OrbitControls dollies on every wheel event it sees, which on a MacBook made
// an idle two-finger scroll — the most reflexive gesture on the machine —
// lurch the camera. Telling a trackpad scroll from a mouse notch by inspecting
// deltas is guesswork that fails on some hardware every time; the preference
// is one predictable rule instead, and the trackpad users who want a panning
// scroll say so once in the Controls panel (state/controlPrefs.ts, 'pan').
//
// WHY ALT FOR ORBIT: Option+drag is the orbit convention in Mac 3D apps
// (Blender, SketchUp, Fusion), ctrl is already spoken for by pinch, and shift
// is not available — browsers turn shift+wheel into horizontal scroll, so the
// deltas arrive on the wrong axis.
//
// RESIDUAL FAILURE MODE, no fix available from inside the page: a window
// manager that grabs alt+scroll for itself (some Linux desktops bind it to
// window opacity or volume) consumes the gesture before the browser sees it,
// so no event arrives here at all. Nothing else regresses — pinch, pan and
// drag-orbit are untouched — and the workaround is the WM's own binding.
//
// TRACKPAD ROTATION IS SAFARI-ONLY. The two-finger twist gesture reaches the
// web through Safari's proprietary gesture events (`rotation`, in degrees,
// alongside `scale`) and NOWHERE ELSE: Chrome, Edge and Firefox report a twist
// as nothing at all — no event, no flag, not even the ctrl+wheel they synthesise
// for a pinch. That is why Alt+scroll exists as well rather than instead: it is
// the orbit path every browser can offer, and on Safari the two coexist.
//
// HOW IT COEXISTS WITH ORBITCONTROLS: OrbitControls registers its own
// non-capturing `wheel` listener on the same canvas. Ours is registered in the
// CAPTURE phase, which the DOM dispatch algorithm runs before the
// non-capturing listeners of the same element, so we get first refusal:
//   - pinch, orbit, or scroll in 'pan' mode → preventDefault (no browser page
//     zoom, no two-finger back-swipe) + stopImmediatePropagation, so
//     OrbitControls never sees the event, and we move the camera ourselves.
//   - plain scroll in 'zoom' mode → return without touching the event, and
//     OrbitControls dollies it exactly as it did in Phase 1, damping and all.
//
// Every gesture writes `camera.position` (and, for a pan, `controls.target`)
// directly. That is safe by construction: OrbitControls.update() re-derives its
// spherical offset from `position - target` at the top of every frame (verified
// in three 0.185.1 OrbitControls.js, update() line 692), so an external move is
// picked up rather than fought — and a pan that moves BOTH by the same vector
// leaves that offset untouched, so it cannot disturb an in-flight damped orbit.

import { MathUtils, Spherical, Vector3 } from 'three';
import type { Camera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  PINCH_ZOOM_BASE,
  SAFARI_GESTURE_ROTATE_SENSITIVITY,
  TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL,
  TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL,
  TRACKPAD_PAN_SPEED,
} from '../config.ts';
import {
  wheelBehaviour,
  type ModifierState,
  type WheelBehaviour,
} from '../state/controlPrefs.ts';

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
const scratchOrbit = new Vector3();
const scratchOrbitResult = new Vector3();
const scratchSpherical = new Spherical();

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
 * What a wheel event means. 'defer' is the one outcome that leaves the event
 * alone for OrbitControls to dolly.
 */
export type WheelGesture = 'pinch' | 'orbit' | 'pan' | 'defer';

/**
 * The whole modifier-key rule table for wheel events, in one pure function so
 * the rules can be tested without a DOM. Order is the precedence:
 *
 * 1. ctrl → pinch. It is the browsers' own encoding of a trackpad pinch AND
 *    the browser's page-zoom chord, so it must be claimed even when another
 *    modifier is held alongside it (alt+ctrl+wheel would otherwise zoom the
 *    PAGE, which no camera gesture can undo).
 * 2. alt → orbit, in BOTH wheel-behaviour modes. Holding a modifier is an
 *    explicit request; the preference only governs what an ambient,
 *    modifier-free scroll does.
 * 3. otherwise → the preference: pan the map, or defer to OrbitControls.
 */
export function classifyWheel(
  mods: Pick<ModifierState, 'ctrlKey' | 'altKey'>,
  behaviour: WheelBehaviour,
): WheelGesture {
  if (mods.ctrlKey) return 'pinch';
  if (mods.altKey) return 'orbit';
  return behaviour === 'zoom' ? 'defer' : 'pan';
}

/**
 * The camera position that orbiting by `azimuthDelta` (radians about the world
 * Y axis through the target) and `polarDelta` (radians of tilt) asks for,
 * written into `out` and returned. Exported for its unit tests: this function
 * IS the orbit.
 *
 * Deliberately the same maths OrbitControls does in its own update(), so a
 * position written here survives the next frame untouched: decompose
 * `position - target` into spherical coordinates, add the deltas, clamp phi to
 * the caller's polar limits, then `makeSafe()` — the EPS nudge that keeps the
 * camera off the poles, where the azimuth would be undefined and lookAt
 * degenerate. Passing the SAME limits OrbitControls holds means its own clamp
 * on the next update is a no-op rather than a correction the user can see.
 *
 * Assumption, and it holds today: the camera's up axis is world +Y (three's
 * default, never reassigned in render/scene.ts), which is exactly the case in
 * which OrbitControls' up-axis quaternion is the identity and its spherical
 * frame is this one. A camera with a tilted up axis would need that
 * quaternion applied on both sides, as OrbitControls does.
 *
 * The radius is untouched: an orbit is not a dolly, so distance and target both
 * come out exactly as they went in.
 */
export function orbitedPosition(
  position: Vector3,
  target: Vector3,
  azimuthDelta: number,
  polarDelta: number,
  minPolarAngle: number,
  maxPolarAngle: number,
  out: Vector3,
): Vector3 {
  scratchOrbit.copy(position).sub(target);
  // Camera exactly on its target: no offset to rotate, and no gesture can put
  // it there (the minimum distance is enforced on every path).
  if (scratchOrbit.lengthSq() === 0) return out.copy(position);

  scratchSpherical.setFromVector3(scratchOrbit);
  scratchSpherical.theta += azimuthDelta;
  scratchSpherical.phi = clamp(
    scratchSpherical.phi + polarDelta,
    minPolarAngle,
    maxPolarAngle,
  );
  scratchSpherical.makeSafe();
  return out.setFromSpherical(scratchSpherical).add(target);
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
 * The orbit azimuth, in radians, that one Safari gesture event asks for.
 * Exported for its unit tests.
 *
 * Both arguments are the CUMULATIVE twist since gesturestart, in degrees —
 * this event's and the previous event's — because that is what Safari reports;
 * the difference is what the fingers did since the last frame. Taking the
 * difference here rather than trusting the absolute angle is what lets an
 * orbit from any other source (a clamp, an Alt+scroll, a plugin) survive a
 * gesture in progress instead of being overwritten by it.
 *
 * Negated so the world follows the fingers: a clockwise twist (Safari's
 * positive direction) must turn the map clockwise, which is the camera going
 * counter-clockwise about the target — the opposite sense of the azimuth.
 *
 * `directTouch` FLIPS that sign. The same gesture events fire on a Mac
 * trackpad (indirect — the fingers are not on the world) and on an
 * iPhone/iPad screen (direct — they are), and the two read as opposite
 * senses: on the touchscreen the owner reported the map turning AGAINST the
 * twist (2026-08-14, iPhone), so direct touch takes the un-negated delta.
 * The trackpad sense is kept as originally calibrated. Assumption: the
 * macOS-trackpad direction was right as shipped — it is unverified on real
 * hardware, and if it ever gets the same report, the fix is this same flag,
 * not another negation.
 */
export function safariTwistAzimuth(
  rotationDegrees: number,
  previousRotationDegrees: number,
  directTouch: boolean,
): number {
  const trackpadSense =
    -MathUtils.degToRad(rotationDegrees - previousRotationDegrees) *
    SAFARI_GESTURE_ROTATE_SENSITIVITY;
  return directTouch ? -trackpadSense : trackpadSense;
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
 * Safari's proprietary two-finger gesture events. They are not in lib.dom, so
 * the shape is declared here — deliberately minimal:
 *   - `scale`: pinch magnification relative to the START of the gesture (1 at
 *     gesturestart, >1 fingers apart).
 *   - `rotation`: finger twist relative to the START of the gesture, in
 *     DEGREES (0 at gesturestart, positive clockwise).
 * Both arrive on the same event, because they are one two-finger manipulation:
 * fingers that spread while they twist zoom while they orbit.
 *
 * Everything else on the event is unused. Feature-detected before use; Chrome,
 * Firefox and Edge never fire these (they send a wheel event with ctrlKey set
 * for a pinch — which is the pinch signal this module reads — and nothing
 * whatsoever for a twist).
 */
interface SafariGestureEvent extends Event {
  readonly scale: number;
  readonly rotation: number;
}

export function bindWheelCamera(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): WheelCameraGestures {
  const camera = controls.object;

  /**
   * Orbits the camera about `controls.target`, honouring the live polar limits
   * OrbitControls itself holds (render/scene.ts sets maxPolarAngle from
   * CAMERA_MAX_POLAR_ANGLE_DEGREES so the camera never dips under the sea).
   * Shared by both orbit paths — Alt+scroll and Safari's twist — so the two
   * can never drift apart in clamping or in frame.
   */
  const orbitBy = (azimuthDelta: number, polarDelta: number): void => {
    if (controls.enableRotate === false) return;
    orbitedPosition(
      camera.position,
      controls.target,
      azimuthDelta,
      polarDelta,
      controls.minPolarAngle,
      controls.maxPolarAngle,
      scratchOrbitResult,
    );
    camera.position.copy(scratchOrbitResult);
  };

  const onWheelCapture = (event: WheelEvent): void => {
    const gesture = classifyWheel(event, wheelBehaviour());

    // 'zoom' mode, no modifier: a plain scroll is OrbitControls' business.
    // Leave the event completely untouched — including its default — so its
    // handler behaves as it did before trackpad gestures existed.
    if (gesture === 'defer') return;

    // Ours now: no browser page zoom (ctrl+wheel), no two-finger back-swipe,
    // and no OrbitControls dolly on top of what we are about to do.
    event.preventDefault();
    event.stopImmediatePropagation();

    if (controls.enabled === false) return;
    if (gesture === 'pinch') {
      if (controls.enableZoom === false) return;
      const distance = camera.position.distanceTo(controls.target);
      setOrbitDistance(
        camera,
        controls.target,
        pinchZoomedDistance(distance, event.deltaY),
      );
      return;
    }
    if (gesture === 'orbit') {
      // Signs follow the pan's convention — the world turns WITH the fingers.
      // A positive delta scrolls the viewport right/down, i.e. the fingers
      // moved left/up, so the map must turn left and tip away from the viewer.
      // Both are a positive delta on the spherical angles: increasing theta
      // swings the camera one way round the target and so carries the map the
      // other, and increasing phi drops the camera toward the horizon. (Both
      // signs are the mirror of OrbitControls' own drag-orbit, which is
      // correct: a drag moves the pointer where a scroll moves the viewport,
      // and those are opposite senses of the same hand movement.)
      orbitBy(
        event.deltaX * TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL,
        event.deltaY * TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL,
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

  // ---- Safari two-finger pinch + twist -------------------------------------
  // Safari reports the whole two-finger manipulation as
  // gesturestart/gesturechange/gestureend with a cumulative `scale` and
  // `rotation`, not as ctrl+wheel. Both are applied on every change event, so
  // a gesture that spreads while it twists zooms while it orbits — one fluid
  // manipulation, which is what the fingers are actually doing.
  //
  // The two are accumulated differently, and deliberately:
  //   - scale is ABSOLUTE against the distance at gesturestart, so rounding
  //     cannot drift and hitting a zoom limit mid-pinch does not lose the
  //     anchor (the anchor distance is still there when the fingers come back).
  //   - rotation is applied as the DELTA since the previous event, because the
  //     azimuth it feeds has no start anchor to recompute from: a pan or an
  //     Alt+scroll during the gesture would be overwritten by an absolute
  //     re-derivation, and the polar clamp can swallow travel that an absolute
  //     angle would then silently re-apply.

  const supportsGestureEvents = 'ongesturestart' in window;
  // Whether a gesture on THIS device is fingers on the world (touchscreen) or
  // fingers beside it (trackpad) — see safariTwistAzimuth. Static per device:
  // maxTouchPoints is 0 on macOS Safari and >0 on iOS/iPadOS, including iPads
  // masquerading as desktop Safari.
  const directTouch = navigator.maxTouchPoints > 0;
  let pinchStartDistance = 0;
  /** Cumulative `rotation` of the last gesture event seen, in degrees. */
  let lastGestureRotationDegrees = 0;

  const onGestureStart = (event: Event): void => {
    event.preventDefault();
    pinchStartDistance = camera.position.distanceTo(controls.target);
    // Safari sends rotation 0 at gesturestart; reading it rather than assuming
    // costs nothing and makes the first delta correct either way.
    lastGestureRotationDegrees = (event as SafariGestureEvent).rotation;
  };

  const onGestureChange = (event: Event): void => {
    event.preventDefault();
    if (controls.enabled === false) return;
    const { scale, rotation } = event as SafariGestureEvent;

    // Twist first: it preserves the orbit radius, so the dolly below still
    // lands on exactly the distance the pinch asked for. Polar delta 0 — a
    // twist is a heading change and nothing else.
    orbitBy(safariTwistAzimuth(rotation, lastGestureRotationDegrees, directTouch), 0);
    lastGestureRotationDegrees = rotation;

    if (controls.enableZoom === false) return;
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
