import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pointerLockedForCamera } from './cameraPointerLock.ts';

/** Wheel silence after the last tick before the gesture counts as complete. */
const WHEEL_QUIET_MS = 150;

export interface CameraGestureLock {
  /** True from gesture start until it completes; the brush stays frozen. */
  active(): boolean;
  dispose(): void;
}

export function createCameraGestureLock(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): CameraGestureLock {
  let pointers = 0;
  let wheelTimer = 0;
  const onStart = (): void => {
    pointers++;
  };
  const onEnd = (): void => {
    pointers = Math.max(0, pointers - 1);
  };
  const onWheel = (): void => {
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => {
      wheelTimer = 0;
    }, WHEEL_QUIET_MS);
  };
  controls.addEventListener('start', onStart);
  controls.addEventListener('end', onEnd);
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: true });
  return {
    active: () => pointers > 0 || wheelTimer !== 0 || pointerLockedForCamera(),
    dispose(): void {
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
      canvas.removeEventListener('wheel', onWheel, { capture: true });
      window.clearTimeout(wheelTimer);
      wheelTimer = 0;
    },
  };
}
