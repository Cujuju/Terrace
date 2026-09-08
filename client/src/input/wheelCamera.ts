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

const scratchOffset = new Vector3();
const scratchRight = new Vector3();
const scratchForward = new Vector3();
const scratchMove = new Vector3();
const scratchOrbit = new Vector3();
const scratchOrbitResult = new Vector3();
const scratchSpherical = new Spherical();

const MIN_GROUND_AXIS_LENGTH_SQ = 1e-6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type WheelGesture = 'pinch' | 'orbit' | 'pan' | 'defer';

export function classifyWheel(
  mods: Pick<ModifierState, 'ctrlKey' | 'altKey'>,
  behaviour: WheelBehaviour,
): WheelGesture {
  if (mods.ctrlKey) return 'pinch';
  if (mods.altKey) return 'orbit';
  return behaviour === 'zoom' ? 'defer' : 'pan';
}

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

function groundAxes(camera: Camera, right: Vector3, forward: Vector3): void {
  right.setFromMatrixColumn(camera.matrix, 0);
  right.y = 0;
  right.normalize();

  forward.setFromMatrixColumn(camera.matrix, 2).negate();
  forward.y = 0;
  if (forward.lengthSq() < MIN_GROUND_AXIS_LENGTH_SQ) {
    forward.setFromMatrixColumn(camera.matrix, 1);
    forward.y = 0;
  }
  forward.normalize();
}

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

export function pinchZoomedDistance(distance: number, deltaY: number): number {
  return clamp(
    distance * Math.pow(PINCH_ZOOM_BASE, deltaY),
    CAMERA_MIN_DISTANCE,
    CAMERA_MAX_DISTANCE,
  );
}

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

function setOrbitDistance(
  camera: Camera,
  target: Vector3,
  distance: number,
): void {
  scratchOffset.copy(camera.position).sub(target);
  const current = scratchOffset.length();
  if (current === 0) return;
  const wanted = clamp(distance, CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE);
  camera.position.copy(target).addScaledVector(scratchOffset, wanted / current);
}

interface SafariGestureEvent extends Event {
  readonly scale: number;
  readonly rotation: number;
}

export function bindWheelCamera(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): WheelCameraGestures {
  const camera = controls.object;

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

    if (gesture === 'defer') return;

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
      orbitBy(
        event.deltaX * TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL,
        event.deltaY * TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL,
      );
      return;
    }
    if (controls.enablePan === false) return;
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
    passive: false,
  });

  const supportsGestureEvents = 'ongesturestart' in window;
  const directTouch = navigator.maxTouchPoints > 0;
  let pinchStartDistance = 0;
  let lastGestureRotationDegrees = 0;

  const onGestureStart = (event: Event): void => {
    event.preventDefault();
    pinchStartDistance = camera.position.distanceTo(controls.target);
    lastGestureRotationDegrees = (event as SafariGestureEvent).rotation;
  };

  const onGestureChange = (event: Event): void => {
    event.preventDefault();
    if (controls.enabled === false) return;
    const { scale, rotation } = event as SafariGestureEvent;

    orbitBy(safariTwistAzimuth(rotation, lastGestureRotationDegrees, directTouch), 0);
    lastGestureRotationDegrees = rotation;

    if (controls.enableZoom === false) return;
    if (!(scale > 0)) return;
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
