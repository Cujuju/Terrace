import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  pointerLock as pointerLockEnabled,
  resolvePress,
  type ModifierState,
} from '../state/controlPrefs.ts';

/**
 * Pointer lock for camera gestures: the cursor stays put while deltas drive
 * the camera. Off by default in Settings; every failure falls back to
 * cursor travel.
 */
export interface CameraPointerLock {
  dispose(): void;
  locked(): boolean;
}

/** Camera verb for a press, or null when it must not lock. */
export function cameraPressVerb(button: number, mods: ModifierState): 'orbit' | 'pan' | null {
  const action = resolvePress(button, mods);
  if (action !== 'orbit' && action !== 'pan') return null;
  return action;
}

/** Quiet window after a lock exit (Esc throttle) before trying again. */
const RELOCK_QUIET_MS = 1500;

export function createCameraPointerLock(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): CameraPointerLock {
  let drivingPointerId: number | null = null;
  let verb: 'orbit' | 'pan' | null = null;
  let lastExitAt = 0;

  const locked = (): boolean =>
    drivingPointerId !== null && document.pointerLockElement === canvas;

  const recordExit = (): void => {
    lastExitAt = Date.now();
  };

  const release = (): void => {
    drivingPointerId = null;
    verb = null;
    try {
      if (document.pointerLockElement === canvas) {
        recordExit();
        const done = document.exitPointerLock() as unknown as Promise<void> | undefined;
        if (done && typeof done.catch === 'function') done.catch(() => {});
      }
    } catch {
      // Already out; the change event (or its absence) settles state.
    }
  };

  const requestLock = (): void => {
    const settled = (grant: Promise<void> | undefined): void => {
      if (!grant || typeof grant.catch !== 'function') return;
      grant
        .then(() => {
          // A grant that arrives ownerless (blur beat it) must exit at once.
          if (drivingPointerId === null && document.pointerLockElement === canvas) {
            release();
          }
        })
        .catch(() => {
          // Async refusal: stay unlocked; OrbitControls still drives the drag.
          drivingPointerId = null;
          verb = null;
        });
    };
    // One attempt per press, inside the gesture handler. No async retry: a
    // rejected options call must not re-request outside user activation.
    try {
      settled(
        canvas.requestPointerLock({ unadjustedMovement: true }) as unknown as
          | Promise<void>
          | undefined,
      );
    } catch {
      try {
        settled(canvas.requestPointerLock() as unknown as Promise<void> | undefined);
      } catch {
        drivingPointerId = null;
        verb = null;
      }
    }
  };

  // Mirror OrbitControls pointer math, fed by lock deltas. Speeds read live
  // off controls. Two updates per orbit event versus one upstream; the extra
  // damping decay is negligible.
  const drive = (kind: 'orbit' | 'pan', dx: number, dy: number): void => {
    if (!controls.enabled) return;
    const el = controls.domElement;
    if (el === null) return;
    const height = el.clientHeight;
    const width = el.clientWidth;
    if (height === 0 || width === 0) return;
    if (kind === 'orbit') {
      if (controls.enableRotate === false) return;
      const factor = (2 * Math.PI) / height;
      controls.rotateLeft(dx * factor * controls.rotateSpeed);
      controls.rotateUp(dy * factor * controls.rotateSpeed);
    } else {
      if (controls.enablePan === false) return;
      controls.pan(dx * controls.panSpeed, dy * controls.panSpeed);
    }
    controls.update();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.target !== canvas || drivingPointerId !== null) return;
    if (!pointerLockEnabled()) return;
    // No cursor to hold for touch or pen; meta would desync the verb below.
    if (event.pointerType !== 'mouse' || event.metaKey) return;
    const gesture = cameraPressVerb(event.button, event);
    if (gesture === null || !controls.enabled) return;
    if (Date.now() - lastExitAt < RELOCK_QUIET_MS) return;
    verb = gesture;
    drivingPointerId = event.pointerId;
    // Defer past dispatch: OrbitControls captures the pointer at the target
    // phase, and a lock request in flight first makes that capture throw.
    // Activation survives the hop.
    const id = event.pointerId;
    queueMicrotask(() => {
      if (drivingPointerId !== id) return;
      requestLock();
    });
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
    // Deltas missing (older Safari/Firefox): abort to the unlocked fallback.
    if (event.movementX === undefined || event.movementY === undefined) {
      release();
      return;
    }
    drive(verb, event.movementX, event.movementY);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== drivingPointerId) return;
    release();
  };

  const onLockChange = (): void => {
    if (document.pointerLockElement !== canvas) {
      recordExit();
      // Esc exits with no pointerup: stop driving; the held pointer keeps
      // the OrbitControls gesture (and its brush freeze) alive unlocked.
      drivingPointerId = null;
      verb = null;
    }
  };

  const onLockError = (): void => {
    drivingPointerId = null;
    verb = null;
  };

  const onBlur = (): void => {
    release();
  };

  // Window capture beats the canvas-target listeners, so the lock request
  // precedes OrbitControls' pointer capture for the same press.
  window.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('pointermove', onPointerMove, { capture: true });
  window.addEventListener('pointerup', onPointerEnd, { capture: true });
  window.addEventListener('pointercancel', onPointerEnd, { capture: true });
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockError);
  window.addEventListener('blur', onBlur);

  return {
    dispose(): void {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('pointerup', onPointerEnd, { capture: true });
      window.removeEventListener('pointercancel', onPointerEnd, { capture: true });
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('pointerlockerror', onLockError);
      window.removeEventListener('blur', onBlur);
      release();
    },
    locked,
  };
}
