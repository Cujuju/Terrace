// Contract tests for the wheel camera maths (src/input/wheelCamera.ts).
//
// The DOM plumbing around these two functions is a handful of lines
// (preventDefault, one preference read, add the vector); the FEEL of the
// gestures is entirely in the two pure functions tested here, so that is where
// the tests are: which way a scroll moves the map, how fast, and what a pinch
// does to the orbit distance.
//
// Cameras are built with real three objects and `updateMatrix()`, because the
// functions read `camera.matrix` exactly as OrbitControls' own pan does.

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MIN_DISTANCE,
  PINCH_ZOOM_BASE,
  TRACKPAD_PAN_SPEED,
} from '../src/config.ts';
import {
  groundPanOffset,
  pinchZoomedDistance,
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
