import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { resolvePress, resolveSculptPress, type ModifierState } from '../state/controlPrefs.ts';

/**
 * Pointer lock for camera gestures: the cursor stays put while movement
 * deltas drive the camera, so a pan never strands it off-window.
 * Every failure falls back to today's behavior.
 */
export interface CameraPointerLock {
  dispose(): void;
}

/** Camera verb for a press, or null when sculpt (or nothing) owns it. */
export function cameraPressVerb(button: number, mods: ModifierState): 'orbit' | 'pan' | null {
  const action = resolvePress(button, mods);
  if (action !== 'orbit' && action !== 'pan') return null;
  if (resolveSculptPress(button, mods) !== null) return null;
  return action;
}
/** True while this module holds the pointer for a camera gesture. */
let drivingPointerId: number | null = null;

export function pointerLockedForCamera(): boolean {
  return (
    drivingPointerId !== null &&
    typeof document !== 'undefined' &&
    document.pointerLockElement instanceof HTMLCanvasElement
  );
}

const tryLock = (canvas: HTMLCanvasElement): void => {
  try {
    const locked = canvas.requestPointerLock({
      unadjustedMovement: true,
    }) as unknown as Promise<void> | undefined;
    if (locked && typeof locked.catch === 'function') {
      locked.catch(() => {
        try {
          canvas.requestPointerLock();
        } catch {
          drivingPointerId = null;
        }
      });
    }
  } catch {
    try {
      canvas.requestPointerLock();
    } catch {
      drivingPointerId = null;
    }
  }
};

const release = (): void => {
  if (drivingPointerId === null) return;
  drivingPointerId = null;
  if (document.pointerLockElement instanceof HTMLCanvasElement) {
    document.exitPointerLock();
  }
};

export function createCameraPointerLock(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): CameraPointerLock {
  const verbOf = (event: PointerEvent): 'orbit' | 'pan' | null => {
    if (event.pointerType === 'touch') return null;
    return cameraPressVerb(event.button, event);
  };

  // Mirror OrbitControls pointer math, fed by lock deltas instead of a
  // travelling cursor. Speeds read live off controls, never constants.
  const drive = (verb: 'orbit' | 'pan', dx: number, dy: number): void => {
    if (!controls.enabled) return;
    const height = canvas.clientHeight;
    if (height === 0) return;
    if (verb === 'orbit') {
      const factor = (2 * Math.PI) / height;
      controls.rotateLeft(dx * factor * controls.rotateSpeed);
      controls.rotateUp(dy * factor * controls.rotateSpeed);
    } else {
      controls.pan(dx * controls.panSpeed, dy * controls.panSpeed);
    }
  };

  let verb: 'orbit' | 'pan' | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    if (drivingPointerId !== null) return;
    const gesture = verbOf(event);
    if (gesture === null || !controls.enabled) return;
    verb = gesture;
    drivingPointerId = event.pointerId;
    tryLock(canvas);
    if (drivingPointerId === null) verb = null;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (
      drivingPointerId === null ||
      event.pointerId !== drivingPointerId ||
      verb === null ||
      document.pointerLockElement !== canvas
    ) {
      return;
    }
    drive(verb, event.movementX ?? 0, event.movementY ?? 0);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== drivingPointerId) return;
    verb = null;
    release();
  };

  const onLockChange = (): void => {
    // Esc exits with no pointerup: stop driving; the held pointer keeps the
    // OrbitControls gesture (and its brush freeze) alive unlocked instead.
    if (document.pointerLockElement !== canvas) {
      verb = null;
      drivingPointerId = null;
    }
  };

  const onBlur = (): void => {
    verb = null;
    release();
  };

  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('pointermove', onPointerMove, { capture: true });
  window.addEventListener('pointerup', onPointerEnd, { capture: true });
  window.addEventListener('pointercancel', onPointerEnd, { capture: true });
  document.addEventListener('pointerlockchange', onLockChange);
  window.addEventListener('blur', onBlur);

  return {
    dispose(): void {
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('pointerup', onPointerEnd, { capture: true });
      window.removeEventListener('pointercancel', onPointerEnd, { capture: true });
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('blur', onBlur);
      verb = null;
      release();
    },
  };
}
