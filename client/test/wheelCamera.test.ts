// Contract tests for the wheel camera maths (src/input/wheelCamera.ts).
//
// The DOM plumbing around these functions is a handful of lines
// (preventDefault, one preference read, add the vector); the FEEL of the
// gestures is entirely in the pure functions tested here, so that is where the
// tests are: which way a scroll moves the map, how fast, what a pinch does to
// the orbit distance, what an orbit does to the camera's place on its sphere,
// and which modifier key means which gesture.
//
// Cameras are built with real three objects and `updateMatrix()`, because the
// functions read `camera.matrix` exactly as OrbitControls' own pan does.

import { describe, expect, it } from 'vitest';
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MAX_POLAR_ANGLE_DEGREES,
  CAMERA_MIN_DISTANCE,
  PINCH_ZOOM_BASE,
  SAFARI_GESTURE_ROTATE_SENSITIVITY,
  TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL,
  TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL,
  TRACKPAD_PAN_SPEED,
} from '../src/config.ts';
import {
  classifyWheel,
  groundPanOffset,
  orbitedPosition,
  pinchZoomedDistance,
  safariTwistAzimuth,
} from '../src/input/wheelCamera.ts';

/** Float comparison tolerance for world-space distances, in world units. */
const EPSILON = 1e-9;

const ORIGIN = new Vector3(0, 0, 0);

/**
 * A camera at `position` looking at `target`, with its matrix composed — the
 * state OrbitControls leaves it in after an update.
 */
function cameraLookingAt(position: Vector3, target: Vector3): PerspectiveCamera {
  const camera = new PerspectiveCamera();
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrix();
  return camera;
}

describe('groundPanOffset: direction', () => {
  // Camera on +Z looking at the origin: screen-right is +X and screen-up
  // (flattened onto the ground) is -Z. Every expectation below is stated in
  // those terms so a sign error cannot hide behind the maths.
  const DISTANCE = 100;
  const camera = (): PerspectiveCamera =>
    cameraLookingAt(new Vector3(0, 0, DISTANCE), ORIGIN);
  const speed = DISTANCE * TRACKPAD_PAN_SPEED;

  it('moves the camera right when the wheel scrolls right', () => {
    // Positive deltaX scrolls the viewport right, so the scene must travel
    // left — which means the camera goes right.
    const out = groundPanOffset(camera(), ORIGIN, 10, 0, new Vector3());
    expect(out.x).toBeCloseTo(10 * speed, 12);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(0, 12);
  });

  it('moves the camera down-screen when the wheel scrolls down', () => {
    // Positive deltaY scrolls the viewport down; down-screen on the ground is
    // toward the viewer, i.e. +Z for this camera.
    const out = groundPanOffset(camera(), ORIGIN, 0, 10, new Vector3());
    expect(out.z).toBeCloseTo(10 * speed, 12);
    expect(out.y).toBe(0);
    expect(out.x).toBeCloseTo(0, 12);
  });

  it('mirrors exactly on the sign of the delta', () => {
    const forward = groundPanOffset(camera(), ORIGIN, 7, -3, new Vector3());
    const backward = groundPanOffset(camera(), ORIGIN, -7, 3, new Vector3());
    expect(backward.x).toBeCloseTo(-forward.x, 12);
    expect(backward.z).toBeCloseTo(-forward.z, 12);
  });

  it('follows the camera round the compass', () => {
    // Camera on +X instead: screen-right is now -Z and screen-up is -X, so the
    // same deltas produce the same motion RELATIVE TO THE VIEW.
    const rotated = cameraLookingAt(new Vector3(DISTANCE, 0, 0), ORIGIN);
    const right = groundPanOffset(rotated, ORIGIN, 10, 0, new Vector3());
    expect(right.z).toBeCloseTo(-10 * speed, 12);
    expect(right.x).toBeCloseTo(0, 12);

    const down = groundPanOffset(rotated, ORIGIN, 0, 10, new Vector3());
    expect(down.x).toBeCloseTo(10 * speed, 12);
    expect(down.z).toBeCloseTo(0, 12);
  });
});

describe('groundPanOffset: magnitude', () => {
  it('is deltaPixels × distance × TRACKPAD_PAN_SPEED', () => {
    const camera = cameraLookingAt(new Vector3(0, 60, 80), ORIGIN); // 100 away
    const out = groundPanOffset(camera, ORIGIN, 3, 4, new Vector3());
    // The two axes are orthogonal unit vectors, so the length is the length of
    // the (3,4) delta — 5 — scaled by the speed.
    expect(out.length()).toBeCloseTo(5 * 100 * TRACKPAD_PAN_SPEED, 9);
  });

  it('scales linearly with the camera-to-target distance', () => {
    const near = cameraLookingAt(new Vector3(0, 0, 50), ORIGIN);
    const far = cameraLookingAt(new Vector3(0, 0, 200), ORIGIN);
    const nearOut = groundPanOffset(near, ORIGIN, 10, 10, new Vector3());
    const farOut = groundPanOffset(far, ORIGIN, 10, 10, new Vector3());
    // Four times the distance, four times the ground covered: that is what
    // makes the pan feel identical at every zoom level.
    expect(farOut.length()).toBeCloseTo(4 * nearOut.length(), 9);
  });

  it('is measured from the target, not the world origin', () => {
    const target = new Vector3(300, 0, 300);
    const camera = cameraLookingAt(new Vector3(300, 0, 400), target); // 100 away
    const out = groundPanOffset(camera, target, 10, 0, new Vector3());
    expect(out.length()).toBeCloseTo(10 * 100 * TRACKPAD_PAN_SPEED, 9);
  });

  it('produces no motion for a zero delta', () => {
    const camera = cameraLookingAt(new Vector3(0, 0, 100), ORIGIN);
    const out = groundPanOffset(camera, ORIGIN, 0, 0, new Vector3());
    expect(out.length()).toBe(0);
  });
});

describe('groundPanOffset: degenerate views', () => {
  it('stays on the ground plane for a tilted camera', () => {
    // The whole point of flattening the axes: no scroll may change altitude.
    for (const height of [1, 40, 300]) {
      const camera = cameraLookingAt(new Vector3(10, height, 10), ORIGIN);
      const out = groundPanOffset(camera, ORIGIN, 13, -7, new Vector3());
      expect(out.y).toBe(0);
    }
  });

  it('pans sanely with the camera looking straight down', () => {
    // Reachable: OrbitControls' minPolarAngle default is 0. The view direction
    // then has no ground component at all, so the fallback axis has to carry
    // the pan — a NaN or a wild heading here is the failure being guarded.
    const camera = cameraLookingAt(new Vector3(0, 100, 0), ORIGIN);
    const out = groundPanOffset(camera, ORIGIN, 0, 10, new Vector3());
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.z)).toBe(true);
    expect(out.y).toBe(0);
    expect(out.length()).toBeCloseTo(10 * 100 * TRACKPAD_PAN_SPEED, 9);
    // With the camera's up axis along -Z (three's own resolution of the
    // degenerate lookAt), screen-down on the ground is +Z.
    expect(out.z).toBeGreaterThan(EPSILON);
  });
});

describe('pinchZoomedDistance', () => {
  it('closes in on a negative delta and backs off on a positive one', () => {
    // Platform convention: pinch out / scroll up is a negative delta = zoom in.
    expect(pinchZoomedDistance(100, -50)).toBeLessThan(100);
    expect(pinchZoomedDistance(100, 50)).toBeGreaterThan(100);
    expect(pinchZoomedDistance(100, 0)).toBe(100);
  });

  it('applies PINCH_ZOOM_BASE to the power of the delta', () => {
    expect(pinchZoomedDistance(100, -30)).toBeCloseTo(
      100 * Math.pow(PINCH_ZOOM_BASE, -30),
      9,
    );
  });

  it('is a constant RATIO at every distance — the same pinch, the same zoom', () => {
    const near = pinchZoomedDistance(50, -20) / 50;
    const far = pinchZoomedDistance(400, -20) / 400;
    expect(far).toBeCloseTo(near, 12);
  });

  it('accumulates across a stream of deltas without drifting', () => {
    // A pinch arrives as many small events; ten steps of -5 must land where
    // one step of -50 does, or the gesture would feel different when it is
    // reported more finely.
    let distance = 100;
    for (let i = 0; i < 10; i++) distance = pinchZoomedDistance(distance, -5);
    expect(distance).toBeCloseTo(pinchZoomedDistance(100, -50), 9);
  });

  it('clamps to the configured zoom bounds', () => {
    // A hard flick must stop at the limit, not sail past it.
    expect(pinchZoomedDistance(CAMERA_MIN_DISTANCE, -10000)).toBe(
      CAMERA_MIN_DISTANCE,
    );
    expect(pinchZoomedDistance(CAMERA_MAX_DISTANCE, 10000)).toBe(
      CAMERA_MAX_DISTANCE,
    );
    expect(pinchZoomedDistance(CAMERA_MIN_DISTANCE, -1)).toBe(
      CAMERA_MIN_DISTANCE,
    );
  });
});

// ---------------------------------------------------------------------------
// Orbit
// ---------------------------------------------------------------------------

/**
 * The polar limits the app actually runs with: OrbitControls' own default
 * minimum (straight down) and render/scene.ts's maximum, which holds the
 * camera above the horizon. Using the real pair means these tests fail if the
 * limits and the orbit ever stop agreeing.
 */
const MIN_POLAR = 0;
const MAX_POLAR = MathUtils.degToRad(CAMERA_MAX_POLAR_ANGLE_DEGREES);

/**
 * OrbitControls' own default maximum (straight up through the pole). Used by
 * the tests that read an azimuth off a camera ON the equator, which the app's
 * own 85° limit deliberately puts out of reach: the clamp is applied to the
 * resulting angle, not merely to the delta, exactly as OrbitControls' update()
 * clamps every frame regardless of where the position came from.
 */
const UNLIMITED_MAX_POLAR = Math.PI;

/**
 * three's `Spherical.makeSafe()` epsilon (Spherical.js, verified in three
 * 0.185.1): phi is held inside (0, π) by exactly this margin, so a clamp
 * against a zero minimum lands here rather than on zero.
 */
const SPHERICAL_SAFE_EPSILON = 1e-6;

const WORLD_UP = new Vector3(0, 1, 0);

/** Polar angle (from +Y) of a camera position about its target, in radians. */
function polarAngleOf(position: Vector3, target: Vector3): number {
  return new Vector3().subVectors(position, target).angleTo(WORLD_UP);
}

/** Azimuth of a camera position about its target: 0 on +Z, +π/2 on +X. */
function azimuthOf(position: Vector3, target: Vector3): number {
  const offset = new Vector3().subVectors(position, target);
  return Math.atan2(offset.x, offset.z);
}

describe('orbitedPosition: azimuth', () => {
  const TARGET = new Vector3(120, 4, -60);
  const DISTANCE = 140;
  /** An ordinary game view: well off the pole, well off the horizon limit. */
  const position = (): Vector3 =>
    new Vector3().setFromSphericalCoords(DISTANCE, MAX_POLAR / 2, 0).add(TARGET);

  it('preserves the orbit distance and leaves the target alone', () => {
    const target = TARGET.clone();
    for (const delta of [0.01, 0.5, -1.3, 7]) {
      const out = orbitedPosition(
        position(),
        target,
        delta,
        0,
        MIN_POLAR,
        MAX_POLAR,
        new Vector3(),
      );
      // An orbit is not a dolly and not a pan: radius and centre both survive.
      expect(out.distanceTo(target)).toBeCloseTo(DISTANCE, 9);
      expect(target.equals(TARGET)).toBe(true);
    }
  });

  it('holds the polar angle while the heading turns', () => {
    const out = orbitedPosition(
      position(),
      TARGET,
      1.1,
      0,
      MIN_POLAR,
      MAX_POLAR,
      new Vector3(),
    );
    expect(polarAngleOf(out, TARGET)).toBeCloseTo(MAX_POLAR / 2, 9);
    expect(azimuthOf(out, TARGET)).toBeCloseTo(1.1, 9);
  });

  it('turns the world with the fingers', () => {
    // Camera due +Z of its target. A positive azimuth delta — what a positive
    // deltaX (fingers moving LEFT) produces — must swing it toward +X, which
    // is the side the map turns away toward.
    const out = orbitedPosition(
      new Vector3(0, 0, DISTANCE),
      ORIGIN,
      Math.PI / 2,
      0,
      MIN_POLAR,
      UNLIMITED_MAX_POLAR,
      new Vector3(),
    );
    expect(out.x).toBeCloseTo(DISTANCE, 9);
    expect(out.z).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
  });

  it('accumulates across a stream of deltas', () => {
    // A trackpad swipe arrives as many small events; ten of them must land
    // where one big one does.
    let stepped = position();
    for (let i = 0; i < 10; i++) {
      stepped = orbitedPosition(
        stepped,
        TARGET,
        0.05,
        0,
        MIN_POLAR,
        MAX_POLAR,
        new Vector3(),
      );
    }
    const once = orbitedPosition(
      position(),
      TARGET,
      0.5,
      0,
      MIN_POLAR,
      MAX_POLAR,
      new Vector3(),
    );
    expect(stepped.distanceTo(once)).toBeLessThan(1e-9);
  });

  it('does not move the camera for a zero delta', () => {
    const start = position();
    const out = orbitedPosition(
      start,
      TARGET,
      0,
      0,
      MIN_POLAR,
      MAX_POLAR,
      new Vector3(),
    );
    expect(out.distanceTo(start)).toBeLessThan(1e-9);
  });

  it('leaves a camera sitting on its target where it is', () => {
    // Degenerate and unreachable in the app (the minimum distance is enforced
    // on every path), but it must not produce a NaN position if it ever is.
    const out = orbitedPosition(
      TARGET.clone(),
      TARGET,
      1,
      1,
      MIN_POLAR,
      MAX_POLAR,
      new Vector3(),
    );
    expect(out.equals(TARGET)).toBe(true);
  });
});

describe('orbitedPosition: polar clamps', () => {
  const DISTANCE = 100;
  const start = (): Vector3 =>
    new Vector3().setFromSphericalCoords(DISTANCE, MAX_POLAR / 2, 0);

  it('stops at the horizon limit however hard the swipe', () => {
    // The limit that keeps the camera above the sea: overshooting it must
    // stop, not tip the view under the water.
    const out = orbitedPosition(
      start(),
      ORIGIN,
      0,
      100,
      MIN_POLAR,
      MAX_POLAR,
      new Vector3(),
    );
    expect(polarAngleOf(out, ORIGIN)).toBeCloseTo(MAX_POLAR, 9);
    expect(out.distanceTo(ORIGIN)).toBeCloseTo(DISTANCE, 9);
  });

  it('stops just short of straight down at a zero minimum', () => {
    // OrbitControls' default minimum is 0, where the azimuth is undefined and
    // lookAt degenerates; Spherical.makeSafe() is what holds it off the pole,
    // and matching that is what stops OrbitControls correcting us next frame.
    const out = orbitedPosition(
      start(),
      ORIGIN,
      0,
      -100,
      MIN_POLAR,
      MAX_POLAR,
      new Vector3(),
    );
    expect(polarAngleOf(out, ORIGIN)).toBeCloseTo(SPHERICAL_SAFE_EPSILON, 9);
    expect(out.distanceTo(ORIGIN)).toBeCloseTo(DISTANCE, 9);
  });

  it('honours a non-zero minimum exactly', () => {
    // The limits are read live off OrbitControls, so a tighter minimum set at
    // runtime has to be obeyed as given.
    const tighterMin = MathUtils.degToRad(30);
    const out = orbitedPosition(
      start(),
      ORIGIN,
      0,
      -100,
      tighterMin,
      MAX_POLAR,
      new Vector3(),
    );
    expect(polarAngleOf(out, ORIGIN)).toBeCloseTo(tighterMin, 9);
  });

  it('tips away from the viewer for a positive delta', () => {
    // Positive deltaY = fingers moving up = the map tips away, which is the
    // camera dropping toward the horizon: a LARGER polar angle.
    const out = orbitedPosition(
      start(),
      ORIGIN,
      0,
      0.2,
      MIN_POLAR,
      MAX_POLAR,
      new Vector3(),
    );
    expect(polarAngleOf(out, ORIGIN)).toBeCloseTo(MAX_POLAR / 2 + 0.2, 9);
    // A tilt is not a turn: the heading is untouched.
    expect(azimuthOf(out, ORIGIN)).toBeCloseTo(0, 9);
  });
});

describe('Alt+scroll orbit rates', () => {
  it('turns the view half way round in a full-trackpad swipe', () => {
    // The tuning the constant encodes, stated as the behaviour rather than the
    // number: the pixels needed for a half-turn must be a swipe a hand can
    // actually make in one go.
    const halfTurnPixels = Math.PI / TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL;
    expect(halfTurnPixels).toBeGreaterThan(200);
    expect(halfTurnPixels).toBeLessThan(1000);

    const out = orbitedPosition(
      new Vector3(0, 0, 100),
      ORIGIN,
      halfTurnPixels * TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL,
      0,
      MIN_POLAR,
      UNLIMITED_MAX_POLAR,
      new Vector3(),
    );
    expect(out.z).toBeCloseTo(-100, 6);
  });

  it('rotates at one rate on both axes', () => {
    // Isotropy is what makes a diagonal swipe rotate along the diagonal
    // instead of skewing; OrbitControls' own drag-orbit does the same.
    expect(TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL).toBe(
      TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL,
    );
  });
});

describe('classifyWheel', () => {
  const NONE = { ctrlKey: false, altKey: false };
  const CTRL = { ctrlKey: true, altKey: false };
  const ALT = { ctrlKey: false, altKey: true };
  const CTRL_ALT = { ctrlKey: true, altKey: true };

  it('orbits on Alt in BOTH wheel-behaviour modes', () => {
    // The preference governs the ambient, modifier-free scroll only. Holding
    // Alt is an explicit gesture and always means orbit.
    expect(classifyWheel(ALT, 'pan')).toBe('orbit');
    expect(classifyWheel(ALT, 'zoom')).toBe('orbit');
  });

  it('pinches on ctrl in both modes', () => {
    expect(classifyWheel(CTRL, 'pan')).toBe('pinch');
    expect(classifyWheel(CTRL, 'zoom')).toBe('pinch');
  });

  it('lets ctrl win the alt+ctrl chord', () => {
    // Whatever else it means, ctrl+wheel is the browser's page-zoom chord and
    // has to be claimed — no camera gesture can undo a zoomed page.
    expect(classifyWheel(CTRL_ALT, 'pan')).toBe('pinch');
    expect(classifyWheel(CTRL_ALT, 'zoom')).toBe('pinch');
  });

  it('follows the preference when no modifier is held', () => {
    expect(classifyWheel(NONE, 'pan')).toBe('pan');
    // 'defer' is the only outcome that leaves the event for OrbitControls.
    expect(classifyWheel(NONE, 'zoom')).toBe('defer');
  });
});

describe('safariTwistAzimuth', () => {
  it('reads the DELTA since the last event, not the absolute angle', () => {
    // Safari's `rotation` is cumulative since gesturestart. Three events of a
    // steady twist must each ask for the same turn — an absolute reading would
    // ask for 10°, then 20°, then 30°.
    const first = safariTwistAzimuth(10, 0, false);
    const second = safariTwistAzimuth(20, 10, false);
    const third = safariTwistAzimuth(30, 20, false);
    expect(second).toBeCloseTo(first, 12);
    expect(third).toBeCloseTo(first, 12);
    // And the stream must land exactly where one big event would.
    expect(first + second + third).toBeCloseTo(safariTwistAzimuth(30, 0, false), 12);
  });

  it('asks for nothing when the fingers have not moved', () => {
    // Math.abs, because negating a zero delta yields -0: the same angle, and
    // an equally exact no-op, but not Object.is-equal to 0.
    expect(Math.abs(safariTwistAzimuth(42, 42, false))).toBe(0);
    expect(Math.abs(safariTwistAzimuth(42, 42, true))).toBe(0);
  });

  it('turns the world with the fingers on a trackpad, at the configured sensitivity', () => {
    // A clockwise finger twist (Safari's positive direction) turns the map
    // clockwise, which is a NEGATIVE azimuth delta for the camera.
    const azimuth = safariTwistAzimuth(30, 0, false);
    expect(azimuth).toBeLessThan(0);
    expect(azimuth).toBeCloseTo(
      -MathUtils.degToRad(30) * SAFARI_GESTURE_ROTATE_SENSITIVITY,
      12,
    );
  });

  it('takes the OPPOSITE sense on a touchscreen', () => {
    // Direct touch (iPhone/iPad): the owner-reported inversion (2026-08-14).
    // Same magnitude, mirrored sign, for every delta.
    expect(safariTwistAzimuth(30, 0, true)).toBeCloseTo(
      -safariTwistAzimuth(30, 0, false),
      12,
    );
    expect(safariTwistAzimuth(-15, 5, true)).toBeCloseTo(
      -safariTwistAzimuth(-15, 5, false),
      12,
    );
  });

  it('is 1:1 with the fingers by default', () => {
    // The whole point of the default: twist 30°, the map turns 30°.
    expect(SAFARI_GESTURE_ROTATE_SENSITIVITY).toBe(1);
    expect(Math.abs(safariTwistAzimuth(30, 0, false))).toBeCloseTo(
      MathUtils.degToRad(30),
      12,
    );
  });

  it('mirrors on the direction of the twist', () => {
    expect(safariTwistAzimuth(-15, 0, false)).toBeCloseTo(
      -safariTwistAzimuth(15, 0, false),
      12,
    );
  });
});
