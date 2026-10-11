import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  KEY_PAN_SCREEN_HEIGHTS_PER_S,
  KEY_ROTATE_RADIANS_PER_S,
  KEY_TILT_RADIANS_PER_S,
  KEY_ZOOM_DOUBLINGS_PER_S,
} from '../config.ts';
import { cameraKeyAction, type CameraKeyAction } from '../state/cameraKeyPrefs.ts';
import { isTextEntry } from '../plugins/kit/textEntry.ts';

/**
 * Held-key camera through OrbitControls' own API, so damping and clamps match
 * the mouse. Leaves the brush alone: a stroke keeps sculpting while keys move.
 */
export interface KeyCamera {
  dispose(): void;
}

export function bindKeyCamera(
  controls: OrbitControls,
  onFrame: (handler: (dt: number) => void) => () => void,
): KeyCamera {
  const held = new Map<string, CameraKeyAction>();

  const onKeyDown = (event: KeyboardEvent): void => {
    // Chorded keys belong to the browser or the sculpt chords, not the camera.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextEntry(event.target)) return;
    const action = cameraKeyAction(event.code);
    if (action === null) return;
    event.preventDefault();
    held.set(event.code, action);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    held.delete(event.code);
  };

  const releaseAll = (): void => {
    held.clear();
  };

  const onVisibility = (): void => {
    if (document.hidden) releaseAll();
  };

  const axis = (positive: CameraKeyAction, negative: CameraKeyAction): number => {
    let value = 0;
    for (const action of held.values()) {
      if (action === positive) value += 1;
      else if (action === negative) value -= 1;
    }
    return Math.max(-1, Math.min(1, value));
  };

  const stopFrames = onFrame((dt) => {
    if (held.size === 0 || dt === 0 || !controls.enabled) return;
    const forward = axis('panForward', 'panBack');
    const right = axis('panRight', 'panLeft');
    const spin = axis('rotateLeft', 'rotateRight');
    const tilt = axis('tiltUp', 'tiltDown');
    const zoom = axis('zoomIn', 'zoomOut');

    const el = controls.domElement;
    if (controls.enablePan && el !== null && (forward !== 0 || right !== 0)) {
      // pan() takes drag pixels: dragging down moves the view forward, right moves it left.
      const pixels = KEY_PAN_SCREEN_HEIGHTS_PER_S * el.clientHeight * dt;
      controls.pan(-right * pixels, forward * pixels);
    }
    if (controls.enableRotate) {
      if (spin !== 0) controls.rotateLeft(spin * KEY_ROTATE_RADIANS_PER_S * dt);
      if (tilt !== 0) controls.rotateUp(tilt * KEY_TILT_RADIANS_PER_S * dt);
    }
    if (controls.enableZoom && zoom !== 0) {
      const scale = Math.pow(2, -KEY_ZOOM_DOUBLINGS_PER_S * dt);
      if (zoom > 0) controls.dollyIn(scale);
      else controls.dollyOut(scale);
    }
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    dispose(): void {
      stopFrames();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
      held.clear();
    },
  };
}
