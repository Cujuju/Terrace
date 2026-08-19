// Pointer → sculpt intent.
//
// CRITICAL CODE — this is the only place the client originates network
// traffic, and the client sends INTENTS, never heights (design doc §3.2). The
// brush amount is not ours to choose: the server owns DEFAULT_SCULPT_AMOUNT.
//
// Control scheme (user-configurable — state/controlPrefs.ts; defaults):
//   left drag/click            sculpt raise
//   shift + left drag/click    sculpt lower
//   right drag                 orbit        (OrbitControls, see cameraBindings)
//   middle drag                pan
//   wheel                      zoom         (not rebindable)
//   one-finger touch drag      sculpt in the HUD's sticky raise/lower mode
//   two-finger touch           pinch zoom + pan or orbit (configurable)
//
// Which action owns a press is decided by the shared resolver in
// state/controlPrefs.ts — the same one the camera consults — so the brush and
// OrbitControls can never both claim a drag.
//
// Only terrain meshes are raycast, never the water plane. That gives
// locked-chunk rejection for free on the client: a chunk we were never sent
// has no mesh, so the ray passes through and no intent is produced. (The
// server rejects such intents anyway — this just avoids sending them.)

import { Raycaster, Vector2, type Camera, type Mesh } from 'three';
import {
  CELL_WORLD_SIZE,
  SCULPT_REPEAT_INTERVAL_MS,
  TOUCH_STROKE_GRACE_MS,
} from '../config.ts';
import { pointerToNdc, worldPointToCell } from '../terrain/picking.ts';
import {
  brushRadius,
  brushProfile,
  brushTool,
  sculptMode,
  setSculptMode,
  sculptDirection,
} from '../state/hudState.ts';
import {
  controlBindings,
  modifierOf,
  resolvePress,
  type ModifierState,
  type SculptAction,
} from '../state/controlPrefs.ts';
import type { SculptIntent } from '@terrace/shared';

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
  /**
   * The cell under the cursor right now, with the picked surface height —
   * what the brush-outline preview (render/brushPreview.ts) follows. Cached
   * per pointer position: the underlying raycast re-runs only when the
   * pointer has actually moved (or the world changed size), so calling this
   * every frame costs nothing while the mouse is still.
   */
  hoverTarget(): { x: number; y: number; surfaceY: number } | null;
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

  /** Live modifier-key state, updated from every pointer/key event seen. */
  let mods: ModifierState = { shiftKey: false, ctrlKey: false, altKey: false };

  /**
   * The stroke in flight: which button started it and the sculpt action it
   * last resolved to. `strokeButton === null` means no stroke is active.
   * `strokePointerId` pins the stroke to one pointer so a second finger's
   * moves cannot drag the brush target around; `strokeIsTouch` strokes keep
   * their action fixed (touch has no modifiers to re-resolve from).
   */
  let strokeButton: number | null = null;
  let strokePointerId: number | null = null;
  let strokeIsTouch = false;
  let strokeAction: SculptAction = 'raise';

  /**
   * Touch pointers currently down on the canvas. One finger sculpts; the
   * moment a second lands the stroke is cancelled and the whole gesture is
   * handed to OrbitControls (two-finger pinch/drag — see cameraBindings.ts).
   */
  const activeTouchIds = new Set<number>();

  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending touch-stroke arming delay (TOUCH_STROKE_GRACE_MS). */
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Raycasts the current pointer position against the terrain and returns the
   * cell under it, or null if the ray missed (empty sea, locked territory, or
   * off-screen).
   */
  const pickCell = (): { x: number; y: number; surfaceY: number } | null => {
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
    const cell = worldPointToCell(point.x / CELL_WORLD_SIZE, point.z / CELL_WORLD_SIZE, size);
    // surfaceY rides along for the hover preview; intents ignore it.
    return cell === null ? null : { ...cell, surfaceY: point.y };
  };

  /**
   * hoverTarget's cache — see the interface doc for the contract. The key
   * covers BOTH things that move the ray: the pointer AND the camera (owner,
   * 2026-08-14: the outline "needs to follow the mouse even during a pan" —
   * a pointer-only key froze it mid-pan and snapped it on the next move).
   * The camera part quantises position and orientation finely enough that a
   * one-cell change of aim can never hide inside one bucket, while damping's
   * sub-visible tail settles into a bucket instead of re-picking every frame.
   */
  let hoverKey = '';
  let hoverCache: { x: number; y: number; surfaceY: number } | null = null;
  const hoverTarget = (): { x: number; y: number; surfaceY: number } | null => {
    const p = camera.position;
    const q = camera.quaternion;
    const key = havePointer
      ? `${pointerClientX},${pointerClientY},${worldSize()},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`
      : 'away';
    if (key !== hoverKey) {
      hoverKey = key;
      hoverCache = pickCell();
    }
    return hoverCache;
  };

  /**
   * The action for the stroke RIGHT NOW. Modifiers may change mid-stroke
   * (press or release shift while holding the button): if the stroke's button
   * currently resolves to a sculpt action, follow it — that preserves the
   * long-standing "release shift mid-drag to switch back to raise" behaviour.
   * If it resolves to a camera action or nothing (the user mashed a modifier
   * that unbinds the button), keep the last sculpt action rather than
   * stopping: a stroke never changes owner mid-flight.
   */
  const currentStrokeAction = (): SculptAction => {
    if (strokeButton !== null && !strokeIsTouch) {
      const resolved = resolvePress(strokeButton, mods);
      if (resolved === 'raise' || resolved === 'lower') {
        strokeAction = resolved;
      }
    }
    return strokeAction;
  };

  /**
   * Monotonic per-session correlation id stamped on every intent. The server
   * echoes it on a sculptDenied nack, which is how the prediction store rolls
   * back exactly the stroke a plugin (mana, cooldowns…) refused — without it a
   * denied prediction lingers on screen until its reconciliation deadline.
   */
  let nextSeq = 1;

  const emitIntent = (): void => {
    // THE ONE PICK AUTHORITY (issue #25): the intent targets the SAME cached
    // cell the brush-outline preview draws, so the two can never disagree.
    // The cache re-picks when the pointer or camera moves — a drag still
    // steers the brush — but deliberately NOT when the terrain changes:
    // re-picking each repeat against the stroke's OWN rising ground made the
    // ray land on the new mound's skirt, which picking resolves to the higher
    // cell, so a stationary held raise on a slope marched uphill cell by cell,
    // building ahead of the outline the player was shown.
    const cell = hoverTarget();
    if (cell === null) return;
    const action = currentStrokeAction();
    setSculptMode(action);
    // tool/profile are read (not captured) per intent, so switching the HUD
    // toggles mid-stroke takes effect on the very next repeat.
    send({
      type: 'sculpt',
      x: cell.x,
      y: cell.y,
      radius: brushRadius(),
      dir: sculptDirection(action),
      tool: brushTool(),
      profile: brushProfile(),
      seq: nextSeq++,
    });
  };

  const stopRepeat = (): void => {
    strokeButton = null;
    strokePointerId = null;
    strokeIsTouch = false;
    if (repeatTimer !== null) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  /** First intent now, then hold-repeat. Each repeat reads the shared hover
   * pick rather than reusing the pressed cell, so a DRAG still re-targets
   * wherever the cursor is now — but a stationary hold keeps its cell even as
   * the terrain rises (see emitIntent's issue-#25 comment). */
  const armStroke = (): void => {
    emitIntent();
    repeatTimer = setInterval(emitIntent, SCULPT_REPEAT_INTERVAL_MS);
  };

  const startStroke = (event: PointerEvent, action: SculptAction): void => {
    // Abandon any stroke still in flight (e.g. a missed pointerup) before
    // starting this one, so at most one repeat timer can ever exist.
    stopRepeat();

    strokeButton = event.button;
    strokePointerId = event.pointerId;
    strokeIsTouch = event.pointerType === 'touch';
    strokeAction = action;
    setSculptMode(action);
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    havePointer = true;

    if (strokeIsTouch) {
      // Touch arms after a grace delay so the second finger of a camera
      // gesture can cancel the stroke before it ever sculpts (see
      // TOUCH_STROKE_GRACE_MS). stopRepeat clears the pending timer, so a
      // cancelled stroke sends nothing at all.
      graceTimer = setTimeout(() => {
        graceTimer = null;
        armStroke();
      }, TOUCH_STROKE_GRACE_MS);
      return;
    }

    // Mouse fires immediately, so a click is a click and does not wait out
    // the repeat interval.
    armStroke();
  };

  /**
   * Keeps the HUD's raise/lower indicator honest while no stroke is active:
   * it shows what the current modifier state would sculpt. The prediction is
   * deliberately button-agnostic (raise checked before lower, mirroring the
   * resolver's precedence) — with both sculpt actions on one button, exactly
   * today's shift behaviour; with them on separate buttons the indicator
   * favours raise until a stroke disambiguates.
   */
  const syncMode = (state: ModifierState): void => {
    mods = {
      shiftKey: state.shiftKey,
      ctrlKey: state.ctrlKey,
      altKey: state.altKey,
    };
    if (strokeButton !== null) return; // the active stroke owns the indicator
    const modifier = modifierOf(mods);
    if (modifier === null) return;
    const bindings = controlBindings();
    if (bindings.raise.modifier === modifier) setSculptMode('raise');
    else if (bindings.lower.modifier === modifier) setSculptMode('lower');
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      activeTouchIds.add(event.pointerId);
      if (activeTouchIds.size > 1) {
        // Second finger: this is a camera gesture, not a wider brush. Cancel
        // the sculpt stroke and let OrbitControls own both pointers.
        stopRepeat();
        return;
      }
      // One finger sculpts in the HUD's sticky mode — touch has no modifier
      // keys, so raise/lower is chosen by tapping the Mode toggle.
      startStroke(event, sculptMode());
      return;
    }

    syncMode(event);
    const action = resolvePress(event.button, event);
    if (action !== 'raise' && action !== 'lower') return;
    startStroke(event, action);
  };

  const onPointerMove = (event: PointerEvent): void => {
    // While a stroke is live, only its own pointer may steer the brush — a
    // second touch (or a stray pen) must not yank the target across the map.
    if (strokePointerId === null || event.pointerId === strokePointerId) {
      pointerClientX = event.clientX;
      pointerClientY = event.clientY;
      havePointer = true;
    }
    // Touch moves carry no modifier keys; letting them into syncMode would
    // reset the sticky touch mode to 'raise' on every frame.
    if (event.pointerType !== 'touch') syncMode(event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') activeTouchIds.delete(event.pointerId);
    if (event.pointerId !== strokePointerId) return;
    // A tap quicker than the grace delay ended before the stroke armed. It is
    // unambiguous now — no second finger arrived in its whole lifetime — so
    // it earns its single intent here; otherwise fast taps would do nothing.
    if (graceTimer !== null) emitIntent();
    stopRepeat();
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') activeTouchIds.delete(event.pointerId);
    if (event.pointerId === strokePointerId) stopRepeat();
  };

  // The context menu must never interrupt a drag: any button can be bound to
  // orbit or the brush, so suppress it on the canvas unconditionally.
  const onContextMenu = (event: MouseEvent): void => event.preventDefault();

  // A modifier pressed or released without moving the pointer still has to
  // update the HUD indicator (and a held stroke's direction).
  const onKeyChange = (event: KeyboardEvent): void => syncMode(event);

  // Releasing the button outside the window would otherwise leave the repeat
  // timer running forever. Touch bookkeeping resets too: no pointerup will
  // ever arrive for fingers lifted while another window had focus.
  const onWindowBlur = (): void => {
    activeTouchIds.clear();
    stopRepeat();
  };

  // A stroke STARTS on the canvas (so clicks on the HUD panel above it are not
  // sculpts) but is TRACKED on the window: the cursor routinely leaves the
  // canvas mid-drag, and a pointerup delivered elsewhere must still end the
  // stroke. Deliberately no setPointerCapture here — OrbitControls captures the
  // same pointer id on the same element for camera drags, and two owners
  // releasing one capture is how a camera drag ends up cancelled by an
  // unrelated sculpt-button release.
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyChange);
  window.addEventListener('keyup', onKeyChange);
  window.addEventListener('blur', onWindowBlur);

  return {
    hoverTarget,
    dispose(): void {
      stopRepeat();
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyChange);
      window.removeEventListener('keyup', onKeyChange);
      window.removeEventListener('blur', onWindowBlur);
    },
  };
}
