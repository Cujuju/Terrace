// Pointer → sculpt intent.
//
// CRITICAL CODE — this is the only place the client originates network
// traffic, and the client sends INTENTS, never heights (design doc §3.2). The
// brush amount is not ours to choose: the server owns DEFAULT_SCULPT_AMOUNT.
//
// Control scheme:
//   left drag/click            sculpt raise
//   shift + left drag/click    sculpt lower
//   right drag                 orbit        (OrbitControls, see render/scene)
//   middle drag                pan
//   wheel                      zoom
//
// The design brief offered "right button OR a modifier" for lower. The
// modifier is the one taken because the right button is needed for camera
// orbit: the left button is spent on the brush, so if right also sculpted, a
// mouse-only user would have no way to turn the camera.
//
// Only terrain meshes are raycast, never the water plane. That gives
// locked-chunk rejection for free on the client: a chunk we were never sent
// has no mesh, so the ray passes through and no intent is produced. (The
// server rejects such intents anyway — this just avoids sending them.)

import { Raycaster, Vector2, type Camera, type Mesh } from 'three';
import { CELL_WORLD_SIZE, SCULPT_REPEAT_INTERVAL_MS } from '../config.ts';
import { pointerToNdc, worldPointToCell } from '../terrain/picking.ts';
import {
  brushRadius,
  sculptDirection,
  sculptMode,
  setSculptMode,
} from '../state/hudState.ts';
import type { SculptIntent } from '@terrace/shared';

/** `PointerEvent.button` for the primary (left) button. */
const PRIMARY_BUTTON = 0;

export interface SculptInputOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  /** Re-read per pick: the mesh set grows as chunks stream in. */
  pickables: () => Mesh[];
  /** Live world size; 0 until the join snapshot arrives. */
  worldSize: () => number;
  send: (intent: SculptIntent) => void;
}

export interface SculptInput {
  dispose(): void;
}

export function createSculptInput(options: SculptInputOptions): SculptInput {
  const { canvas, camera, pickables, worldSize, send } = options;

  const raycaster = new Raycaster();
  const ndc = new Vector2();

  /** Latest pointer position in CSS pixels; null when the pointer is away. */
  let pointerClientX = 0;
  let pointerClientY = 0;
  let havePointer = false;

  let repeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Raycasts the current pointer position against the terrain and returns the
   * cell under it, or null if the ray missed (empty sea, locked territory, or
   * off-screen).
   */
  const pickCell = (): { x: number; y: number } | null => {
    const size = worldSize();
    if (size <= 0 || !havePointer) return null;

    const rect = canvas.getBoundingClientRect();
    const device = pointerToNdc(pointerClientX, pointerClientY, rect);
    if (device === null) return null;

    ndc.set(device.x, device.y);
    raycaster.setFromCamera(ndc, camera);

    // Non-recursive: pickables() is already the flat list of chunk meshes.
    const hits = raycaster.intersectObjects(pickables(), false);
    if (hits.length === 0) return null;

    const point = hits[0].point;
    return worldPointToCell(point.x / CELL_WORLD_SIZE, point.z / CELL_WORLD_SIZE, size);
  };

  const emitIntent = (): void => {
    const cell = pickCell();
    if (cell === null) return;
    send({
      type: 'sculpt',
      x: cell.x,
      y: cell.y,
      radius: brushRadius(),
      dir: sculptDirection(sculptMode()),
    });
  };

  const stopRepeat = (): void => {
    if (repeatTimer !== null) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
  };

  /**
   * Shift state drives the mode signal from every input event, so the HUD's
   * raise/lower indicator and the intents actually sent can never disagree —
   * there is one source of truth and it is updated before it is read.
   */
  const syncMode = (shiftKey: boolean): void => {
    setSculptMode(shiftKey ? 'lower' : 'raise');
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== PRIMARY_BUTTON) return;
    // Abandon any stroke still in flight (e.g. a missed pointerup) before
    // starting this one, so at most one repeat timer can ever exist.
    stopRepeat();

    syncMode(event.shiftKey);
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    havePointer = true;

    // One intent immediately, so a click is a click and does not wait out the
    // repeat interval.
    emitIntent();

    // Hold-repeat re-picks each time rather than reusing the pressed cell: the
    // terrain rises under the cursor and the pointer may be dragging, so the
    // intended target is wherever the cursor is NOW.
    repeatTimer = setInterval(emitIntent, SCULPT_REPEAT_INTERVAL_MS);
  };

  const onPointerMove = (event: PointerEvent): void => {
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    havePointer = true;
    syncMode(event.shiftKey);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== PRIMARY_BUTTON) return;
    stopRepeat();
  };

  // Right-drag orbits, so the browser's context menu must not interrupt it.
  const onContextMenu = (event: MouseEvent): void => event.preventDefault();

  // Shift pressed or released without moving the pointer still has to update
  // the HUD indicator.
  const onKeyChange = (event: KeyboardEvent): void => syncMode(event.shiftKey);

  // Releasing the button outside the window would otherwise leave the repeat
  // timer running forever.
  const onWindowBlur = (): void => stopRepeat();

  // A stroke STARTS on the canvas (so clicks on the HUD panel above it are not
  // sculpts) but is TRACKED on the window: the cursor routinely leaves the
  // canvas mid-drag, and a pointerup delivered elsewhere must still end the
  // stroke. Deliberately no setPointerCapture here — OrbitControls captures the
  // same pointer id on the same element for camera drags, and two owners
  // releasing one capture is how a right-drag orbit ends up cancelled by an
  // unrelated left-button release.
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', stopRepeat);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyChange);
  window.addEventListener('keyup', onKeyChange);
  window.addEventListener('blur', onWindowBlur);

  return {
    dispose(): void {
      stopRepeat();
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', stopRepeat);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyChange);
      window.removeEventListener('keyup', onKeyChange);
      window.removeEventListener('blur', onWindowBlur);
    },
  };
}
