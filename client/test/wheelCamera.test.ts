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

const EPSILON = 1e-9;

const ORIGIN = new Vector3(0, 0, 0);

function cameraLookingAt(position: Vector3, target: Vector3): PerspectiveCamera {
  const camera = new PerspectiveCamera();
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrix();
  return camera;
}

describe('groundPanOffset: direction', () => {
  const DISTANCE = 100;
  const camera = (): PerspectiveCamera =>
    cameraLookingAt(new Vector3(0, 0, DISTANCE), ORIGIN);
  const speed = DISTANCE * TRACKPAD_PAN_SPEED;

  it('moves the camera right when the wheel scrolls right', () => {
    const out = groundPanOffset(camera(), ORIGIN, 10, 0, new Vector3());
    expect(out.x).toBeCloseTo(10 * speed, 12);
    expect(out.y).toBe(0);
    expect(out.z).toBeCloseTo(0, 12);
  });

  it('moves the camera down-screen when the wheel scrolls down', () => {
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
    const camera = cameraLookingAt(new Vector3(0, 60, 80), ORIGIN);
    const out = groundPanOffset(camera, ORIGIN, 3, 4, new Vector3());
    expect(out.length()).toBeCloseTo(5 * 100 * TRACKPAD_PAN_SPEED, 9);
  });

  it('scales linearly with the camera-to-target distance', () => {
    const near = cameraLookingAt(new Vector3(0, 0, 50), ORIGIN);
    const far = cameraLookingAt(new Vector3(0, 0, 200), ORIGIN);
    const nearOut = groundPanOffset(near, ORIGIN, 10, 10, new Vector3());
    const farOut = groundPanOffset(far, ORIGIN, 10, 10, new Vector3());
    expect(farOut.length()).toBeCloseTo(4 * nearOut.length(), 9);
  });

  it('is measured from the target, not the world origin', () => {
    const target = new Vector3(300, 0, 300);
    const camera = cameraLookingAt(new Vector3(300, 0, 400), target);
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
    for (const height of [1, 40, 300]) {
      const camera = cameraLookingAt(new Vector3(10, height, 10), ORIGIN);
      const out = groundPanOffset(camera, ORIGIN, 13, -7, new Vector3());
      expect(out.y).toBe(0);
    }
  });

  it('pans sanely with the camera looking straight down', () => {
    const camera = cameraLookingAt(new Vector3(0, 100, 0), ORIGIN);
    const out = groundPanOffset(camera, ORIGIN, 0, 10, new Vector3());
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.z)).toBe(true);
    expect(out.y).toBe(0);
    expect(out.length()).toBeCloseTo(10 * 100 * TRACKPAD_PAN_SPEED, 9);
    expect(out.z).toBeGreaterThan(EPSILON);
  });
});

describe('pinchZoomedDistance', () => {
  it('closes in on a negative delta and backs off on a positive one', () => {
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
    let distance = 100;
    for (let i = 0; i < 10; i++) distance = pinchZoomedDistance(distance, -5);
    expect(distance).toBeCloseTo(pinchZoomedDistance(100, -50), 9);
  });

  it('clamps to the configured zoom bounds', () => {
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

const MIN_POLAR = 0;
const MAX_POLAR = MathUtils.degToRad(CAMERA_MAX_POLAR_ANGLE_DEGREES);

const UNLIMITED_MAX_POLAR = Math.PI;

const SPHERICAL_SAFE_EPSILON = 1e-6;

const WORLD_UP = new Vector3(0, 1, 0);

function polarAngleOf(position: Vector3, target: Vector3): number {
  return new Vector3().subVectors(position, target).angleTo(WORLD_UP);
}

function azimuthOf(position: Vector3, target: Vector3): number {
  const offset = new Vector3().subVectors(position, target);
  return Math.atan2(offset.x, offset.z);
}

describe('orbitedPosition: azimuth', () => {
  const TARGET = new Vector3(120, 4, -60);
  const DISTANCE = 140;
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
    expect(azimuthOf(out, ORIGIN)).toBeCloseTo(0, 9);
  });
});

describe('Alt+scroll orbit rates', () => {
  it('turns the view half way round in a full-trackpad swipe', () => {
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
    expect(classifyWheel(ALT, 'pan')).toBe('orbit');
    expect(classifyWheel(ALT, 'zoom')).toBe('orbit');
  });

  it('pinches on ctrl in both modes', () => {
    expect(classifyWheel(CTRL, 'pan')).toBe('pinch');
    expect(classifyWheel(CTRL, 'zoom')).toBe('pinch');
  });

  it('lets ctrl win the alt+ctrl chord', () => {
    expect(classifyWheel(CTRL_ALT, 'pan')).toBe('pinch');
    expect(classifyWheel(CTRL_ALT, 'zoom')).toBe('pinch');
  });

  it('follows the preference when no modifier is held', () => {
    expect(classifyWheel(NONE, 'pan')).toBe('pan');
    expect(classifyWheel(NONE, 'zoom')).toBe('defer');
  });
});

describe('safariTwistAzimuth', () => {
  it('reads the DELTA since the last event, not the absolute angle', () => {
    const first = safariTwistAzimuth(10, 0, false);
    const second = safariTwistAzimuth(20, 10, false);
    const third = safariTwistAzimuth(30, 20, false);
    expect(second).toBeCloseTo(first, 12);
    expect(third).toBeCloseTo(first, 12);
    expect(first + second + third).toBeCloseTo(safariTwistAzimuth(30, 0, false), 12);
  });

  it('asks for nothing when the fingers have not moved', () => {
    expect(Math.abs(safariTwistAzimuth(42, 42, false))).toBe(0);
    expect(Math.abs(safariTwistAzimuth(42, 42, true))).toBe(0);
  });

  it('turns the world with the fingers on a trackpad, at the configured sensitivity', () => {
    const azimuth = safariTwistAzimuth(30, 0, false);
    expect(azimuth).toBeLessThan(0);
    expect(azimuth).toBeCloseTo(
      -MathUtils.degToRad(30) * SAFARI_GESTURE_ROTATE_SENSITIVITY,
      12,
    );
  });

  it('takes the OPPOSITE sense on a touchscreen', () => {
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
