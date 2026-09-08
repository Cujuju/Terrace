import { MOUSE, TOUCH } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  TOUCH_DOLLY_MAX_STEP_RATIO,
  TOUCH_DOLLY_MIN_SEPARATION_PX,
} from '../config.ts';
import {
  resolvePress,
  twoFingerGesture,
  type ModifierState,
  type MouseButtonName,
} from '../state/controlPrefs.ts';
import { bindWheelCamera } from './wheelCamera.ts';

export interface CameraBindings {
  dispose(): void;
}

function cameraVerb(
  button: MouseButtonName,
  mods: ModifierState,
): MOUSE | null {
  const eventButton = button === 'left' ? 0 : button === 'middle' ? 1 : 2;
  switch (resolvePress(eventButton, mods)) {
    case 'orbit':
      return MOUSE.ROTATE;
    case 'pan':
      return MOUSE.PAN;
    default:
      return null;
  }
}

function applyBindings(controls: OrbitControls, mods: ModifierState): void {
  controls.mouseButtons = {
    LEFT: cameraVerb('left', mods),
    MIDDLE: cameraVerb('middle', mods),
    RIGHT: cameraVerb('right', mods),
  };
  controls.touches = {
    ONE: null,
    TWO:
      twoFingerGesture() === 'orbit' ? TOUCH.DOLLY_ROTATE : TOUCH.DOLLY_PAN,
  };
}

const NO_MODIFIERS: ModifierState = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
};

export type TouchMoveVerdict = 'pass' | 'swallow';

export interface TouchDollyGuard {
  down(pointerId: number, x: number, y: number): void;
  move(pointerId: number, x: number, y: number): TouchMoveVerdict;
  up(pointerId: number): void;
  pairIsDegenerate(): boolean;
}

export function createTouchDollyGuard(): TouchDollyGuard {
  const positions = new Map<number, { x: number; y: number }>();
  let acceptedSeparation: number | null = null;
  let degenerate = false;

  const separation = (): number | null => {
    if (positions.size !== 2) return null;
    const [a, b] = [...positions.values()];
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const repair = (): void => {
    const sep = separation();
    if (sep === null) {
      acceptedSeparation = null;
      degenerate = false;
      return;
    }
    degenerate = sep < TOUCH_DOLLY_MIN_SEPARATION_PX;
    acceptedSeparation = degenerate ? null : sep;
  };

  return {
    down(pointerId, x, y): void {
      positions.set(pointerId, { x, y });
      repair();
    },
    move(pointerId, x, y): TouchMoveVerdict {
      const position = positions.get(pointerId);
      if (position === undefined) return 'pass';
      position.x = x;
      position.y = y;
      const sep = separation();
      if (sep === null) return 'pass';
      if (acceptedSeparation === null) return 'swallow';
      if (sep < TOUCH_DOLLY_MIN_SEPARATION_PX) return 'swallow';
      const ratio = sep / acceptedSeparation;
      if (
        ratio > TOUCH_DOLLY_MAX_STEP_RATIO ||
        ratio < 1 / TOUCH_DOLLY_MAX_STEP_RATIO
      ) {
        return 'swallow';
      }
      acceptedSeparation = sep;
      return 'pass';
    },
    up(pointerId): void {
      positions.delete(pointerId);
      repair();
    },
    pairIsDegenerate(): boolean {
      return degenerate;
    },
  };
}

export function bindCameraControls(
  canvas: HTMLCanvasElement,
  controls: OrbitControls,
): CameraBindings {
  applyBindings(controls, NO_MODIFIERS);

  const guard = createTouchDollyGuard();

  const onPointerDownCapture = (event: PointerEvent): void => {
    applyBindings(controls, event);
    if (event.pointerType !== 'touch') return;
    guard.down(event.pointerId, event.pageX, event.pageY);
    if (guard.pairIsDegenerate()) {
      controls.touches = { ONE: null, TWO: null };
    }
  };

  const onPointerMoveCapture = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    if (guard.move(event.pointerId, event.pageX, event.pageY) === 'swallow') {
      event.stopImmediatePropagation();
    }
  };
  const onPointerEndCapture = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    guard.up(event.pointerId);
  };

  canvas.addEventListener('pointerdown', onPointerDownCapture, {
    capture: true,
  });
  const doc = canvas.ownerDocument;
  doc.addEventListener('pointermove', onPointerMoveCapture, { capture: true });
  doc.addEventListener('pointerup', onPointerEndCapture, { capture: true });
  doc.addEventListener('pointercancel', onPointerEndCapture, {
    capture: true,
  });

  const wheelGestures = bindWheelCamera(canvas, controls);

  return {
    dispose(): void {
      canvas.removeEventListener('pointerdown', onPointerDownCapture, {
        capture: true,
      });
      doc.removeEventListener('pointermove', onPointerMoveCapture, {
        capture: true,
      });
      doc.removeEventListener('pointerup', onPointerEndCapture, {
        capture: true,
      });
      doc.removeEventListener('pointercancel', onPointerEndCapture, {
        capture: true,
      });
      wheelGestures.dispose();
    },
  };
}
