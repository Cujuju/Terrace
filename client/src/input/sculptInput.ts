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
// A press fires ONE intent immediately and then repeats on an ACCELERATING
// schedule (repeatDelayMs, below): slow enough at the top that a click is a
// click, ramping to full sculpting speed over the first second or so of a hold.
//
// Which action owns a press is decided by the shared resolver in
// state/controlPrefs.ts — the same one the camera consults — so the brush and
// OrbitControls can never both claim a drag.
//
// Only terrain is picked, never the water plane. That gives locked-chunk
// rejection for free on the client: the pick skips cells in chunks we were
// never sent, so the ray passes through and no intent is produced. (The
// server rejects such intents anyway — this just avoids sending them.)
// It used to fall out of "a chunk we were never sent has no mesh"; since the
// pick marches the height mirror instead of the meshes, terrain/picking.ts
// enforces it against `mirror.received` directly.

import { Raycaster, Vector2, type Camera } from 'three';
import {
  DRAG_CELLS_PER_EMIT,
  SCULPT_REPEAT_DELAY_MS,
  SCULPT_REPEAT_INTERVAL_MS,
  SCULPT_REPEAT_RAMP_FACTOR,
  TOUCH_STROKE_GRACE_MS,
} from '../config.ts';
import {
  pointerToNdc,
  type TerrainRayPick,
  type Vec3,
} from '../terrain/picking.ts';
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
import { MIN_BRUSH_RADIUS } from '@terrace/shared';
import type { SculptIntent } from '@terrace/shared';

/**
 * THE DRAG BRUSH IS ONE CELL (owner decision 2026-08-23). A drag's whole point
 * is that the terrace lip follows the cursor exactly; any wider footprint and
 * the edge lands somewhere the player did not point, which is the one thing the
 * stamp already does. MIN_BRUSH_RADIUS rather than a literal 1: the brush's own
 * floor is what "the smallest possible edit" means, and if that floor ever
 * moves the drag should move with it.
 *
 * Deliberately NOT the HUD's brush radius. That slider sizes the STAMP, and a
 * radius-7.75 drag is a bulldozer rather than an edge tool.
 */
const DRAG_BRUSH_RADIUS = MIN_BRUSH_RADIUS;

export interface SculptInputOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  /**
   * The world's ray pick (World.pickCell) — one shared implementation, so the
   * brush and plugin clicks can never disagree about which cell a ray means.
   */
  pickCell: (origin: Vec3, direction: Vec3) => TerrainRayPick | null;
  /**
   * World-space Y of the RENDERED surface at a cell (World.terrainHeightAt) —
   * read LIVE, every time the hover pick is read, so the brush outline sits on
   * the ground as it is NOW rather than as it was when the ray last flew. See
   * hoverTarget for why the cell is cached but its height is not.
   */
  terrainHeightAt: (x: number, y: number) => number | null;
  /** Live world size; 0 until the join snapshot arrives. */
  worldSize: () => number;
  /**
   * The terrace band whose lip is within grabbing range of `cell`, or null for
   * none (World.highlightLayerEdge → render/layerEdgeOverlay.ts). This is the
   * SAME query that lights the lip up on screen, so what the player sees
   * highlighted is exactly what a press grabs — the highlight is the
   * affordance, and two answers to "is there a lip here" would make it a lie.
   */
  grabbableBand: (cell: { x: number; y: number } | null) => number | null;
  send: (intent: SculptIntent) => void;
}

export interface SculptInput {
  /**
   * The cell under the cursor right now, with the picked surface height —
   * what the brush-outline preview (render/brushPreview.ts) follows. Cached
   * on the pointer position AND the camera pose (see hoverKey), because both
   * move the ray; a pan therefore re-picks every frame by design. That is
   * affordable only because the pick is a height-field march — when it was a
   * mesh raycast the same per-frame re-pick cost 29.5 ms a frame.
   *
   * The CELL is what the cache holds. `surfaceY` is re-read live from the
   * terrain on every call, so the outline tracks ground the player is actively
   * sculpting without the ray being re-fired (which would move the target —
   * see hoverTarget's own note and emitIntent's issue-#25 comment).
   */
  hoverTarget(): TerrainRayPick | null;
  dispose(): void;
}

/**
 * THE HOLD-REPEAT RAMP: milliseconds to wait before repeat number
 * `repeatIndex`, where 0 is the first repeat — the second intent of the
 * stroke. The first intent itself is never delayed (a click is a click).
 *
 * Geometric decay from SCULPT_REPEAT_DELAY_MS by SCULPT_REPEAT_RAMP_FACTOR,
 * floored at SCULPT_REPEAT_INTERVAL_MS: 400, 300, 225, 169, 127, then 120 ms
 * forever. Owner, 2026-08-19: a single click was raising land too fast, because
 * the old flat interval made a 150 ms click indistinguishable from a hold and
 * landed two bands for one press.
 *
 * The floor is what keeps the wire-rate bound honest — see
 * SCULPT_REPEAT_INTERVAL_MS. Pure and exported so the schedule can be pinned by
 * test without a DOM or a fake clock; `createSculptInput` is the only caller.
 */
export function repeatDelayMs(repeatIndex: number): number {
  const ramped = SCULPT_REPEAT_DELAY_MS * SCULPT_REPEAT_RAMP_FACTOR ** repeatIndex;
  return Math.max(SCULPT_REPEAT_INTERVAL_MS, ramped);
}

export function createSculptInput(options: SculptInputOptions): SculptInput {
  const {
    canvas,
    camera,
    pickCell: pickCellByRay,
    terrainHeightAt,
    worldSize,
    grabbableBand,
    send,
  } = options;

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
   * THE GRABBED BAND, decided once at pointerdown and fixed for the stroke —
   * null for an ordinary stamp stroke. Fixed rather than re-queried per repeat
   * for the same reason the stroke's target cell is cached (see emitIntent's
   * issue-#25 note): a drag MOVES the lip, so re-asking "what lip is under the
   * cursor now" mid-stroke would let the stroke re-grab the edge it just built
   * — or worse, hand off to a different band's lip the drag happened to sweep
   * past — and the player would have no way to predict which terrace they were
   * pulling.
   */
  let strokeBand: number | null = null;

  /**
   * Whether the stroke has actually started sculpting. A touch stroke waits out
   * TOUCH_STROKE_GRACE_MS first, and a drag must not emit on pointer motion
   * during that window or the second finger of a camera gesture would carve a
   * furrow before it could cancel the stroke.
   */
  let strokeArmed = false;

  /**
   * The last cell this DRAG emitted an intent for, so the next emission can
   * walk the path from there and leave no gap in the lip. Null before the
   * stroke's first intent, and for every non-drag stroke.
   */
  let lastDragCellX = 0;
  let lastDragCellY = 0;
  let haveDragCell = false;

  /**
   * Touch pointers currently down on the canvas. One finger sculpts; the
   * moment a second lands the stroke is cancelled and the whole gesture is
   * handed to OrbitControls (two-finger pinch/drag — see cameraBindings.ts).
   */
  const activeTouchIds = new Set<number>();

  /**
   * The NEXT repeat's pending timeout. A self-rescheduling chain rather than a
   * setInterval, because the gap between repeats is not constant — see
   * repeatDelayMs.
   */
  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending touch-stroke arming delay (TOUCH_STROKE_GRACE_MS). */
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Raycasts the current pointer position against the terrain and returns the
   * cell under it, or null if the ray missed (empty sea, locked territory, or
   * off-screen).
   */
  const pickCell = (): TerrainRayPick | null => {
    const size = worldSize();
    if (size <= 0 || !havePointer) return null;

    const rect = canvas.getBoundingClientRect();
    const device = pointerToNdc(pointerClientX, pointerClientY, rect);
    if (device === null) return null;

    // Three is used for the ONE step that needs the camera — unprojecting the
    // pointer into a world-space ray. The ray then goes to the height-field
    // march, which never touches the scene graph.
    ndc.set(device.x, device.y);
    raycaster.setFromCamera(ndc, camera);
    // surfaceY rides along for the hover preview; intents ignore it.
    return pickCellByRay(raycaster.ray.origin, raycaster.ray.direction);
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
  let hoverCache: TerrainRayPick | null = null;
  const hoverTarget = (): TerrainRayPick | null => {
    const p = camera.position;
    const q = camera.quaternion;
    const key = havePointer
      ? `${pointerClientX},${pointerClientY},${worldSize()},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`
      : 'away';
    if (key !== hoverKey) {
      hoverKey = key;
      hoverCache = pickCell();
    }
    // THE CELL IS CACHED; ITS HEIGHT IS NOT (owner bug report 2026-08-22,
    // "lowering does not always seem to work"). The key deliberately carries
    // nothing about the terrain — re-picking when the ground moves is what
    // marched a held raise uphill (see emitIntent's issue-#25 note) — but that
    // also froze the SURFACE the outline is drawn on, so after a sculpt with a
    // still mouse the ring hung at the pre-stroke height while the ground
    // moved out from under it. Lowering wore that worst: a raise pushes ground
    // up through a stale ring, a lower leaves the ring floating over its own
    // pit, which reads as "the click did nothing".
    //
    // Re-reading the height for the CACHED cell keeps both promises: the
    // stroke still targets the cell the player aimed at, and the outline still
    // lies on the ground. A cell whose chunk has gone (a rejoin between the
    // pick and this read) yields null rather than a stale Y.
    if (hoverCache === null) return null;
    const surfaceY = terrainHeightAt(hoverCache.x, hoverCache.y);
    if (surfaceY === null) return null;
    if (surfaceY === hoverCache.surfaceY) return hoverCache;
    // hitRiser rides along unchanged: it is a fact about the RAY, and this
    // branch only refreshes the cached cell's height after the ground moved
    // under a stationary pointer. The next pointermove re-picks and re-decides
    // it.
    hoverCache = { x: hoverCache.x, y: hoverCache.y, surfaceY, hitRiser: hoverCache.hitRiser };
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
    if (strokeBand !== null) {
      emitDrag(cell.x, cell.y, action);
      return;
    }
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

  /** One drag intent at (x, y), pulling the grabbed band onto that cell. */
  const sendDragAt = (x: number, y: number, action: SculptAction): void => {
    send({
      type: 'sculpt',
      x,
      y,
      // One cell, not the HUD's stamp radius — see DRAG_BRUSH_RADIUS.
      radius: DRAG_BRUSH_RADIUS,
      dir: sculptDirection(action),
      // A drag is a HORIZONTAL edit (owner, 2026-08-23): it extends a level
      // sideways and must not slope anything, so it is always a stamp
      // regardless of the HUD's tool toggle — the smooth tool's relaxation
      // would carry height away from the lip the player is placing. `hard` for
      // the same reason: the drag speaks in whole bands, so a falloff cone
      // across a one-cell footprint is a distinction without a difference on
      // the centre cell and a wrong one on any future wider drag.
      tool: 'stamp',
      profile: 'hard',
      targetBand: strokeBand ?? undefined,
      seq: nextSeq++,
    });
  };

  /**
   * THE DRAG WALK — emits one intent per cell along the path from the last
   * cell this stroke touched to (x, y), so a fast pull leaves a continuous
   * terrace lip instead of a dotted one.
   *
   * Bresenham over the integer cell lattice, because the path has to be the
   * same set of cells however the sampling fell: two players making the same
   * gesture at different frame rates should carve the same edge.
   *
   * Capped at DRAG_CELLS_PER_EMIT cells per call (see that constant). The cap
   * SKIPS NOTHING — the walk stops early and `lastDragCell` records where, so
   * the next repeat resumes from that cell and the lip merely trails the
   * cursor for a tick.
   */
  const emitDrag = (x: number, y: number, action: SculptAction): void => {
    if (!haveDragCell) {
      sendDragAt(x, y, action);
      lastDragCellX = x;
      lastDragCellY = y;
      haveDragCell = true;
      return;
    }

    let px = lastDragCellX;
    let py = lastDragCellY;
    const dx = Math.abs(x - px);
    const dy = -Math.abs(y - py);
    const stepX = px < x ? 1 : -1;
    const stepY = py < y ? 1 : -1;
    let error = dx + dy;

    for (let emitted = 0; emitted < DRAG_CELLS_PER_EMIT; emitted++) {
      // The path's FIRST cell is the one already emitted last time, so every
      // iteration advances before it sends — no cell is ever sculpted twice by
      // the walk, and a stationary cursor emits nothing at all.
      if (px === x && py === y) break;
      const doubled = 2 * error;
      if (doubled >= dy) {
        error += dy;
        px += stepX;
      }
      if (doubled <= dx) {
        error += dx;
        py += stepY;
      }
      sendDragAt(px, py, action);
      lastDragCellX = px;
      lastDragCellY = py;
    }
  };

  const stopRepeat = (): void => {
    strokeButton = null;
    strokePointerId = null;
    strokeIsTouch = false;
    strokeBand = null;
    strokeArmed = false;
    haveDragCell = false;
    if (repeatTimer !== null) {
      clearTimeout(repeatTimer);
      repeatTimer = null;
    }
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  /**
   * Schedules repeat number `repeatIndex` (0 = the first repeat, i.e. the
   * SECOND intent of the stroke) and, when it fires, the one after it.
   *
   * A chain of timeouts rather than one interval: the gap grows shorter as the
   * hold is sustained (repeatDelayMs), and an interval has exactly one period.
   * `repeatTimer` is nulled before the body runs because a timeout that has
   * fired is no longer pending — stopRepeat must never clear a spent handle
   * and believe it cancelled something.
   */
  const scheduleRepeat = (repeatIndex: number): void => {
    repeatTimer = setTimeout(() => {
      repeatTimer = null;
      emitIntent();
      scheduleRepeat(repeatIndex + 1);
    }, repeatDelayMs(repeatIndex));
  };

  /** First intent now, then the accelerating hold-repeat. Each repeat reads the
   * shared hover pick rather than reusing the pressed cell, so a DRAG still
   * re-targets wherever the cursor is now — but a stationary hold keeps its
   * cell even as the terrain rises (see emitIntent's issue-#25 comment). */
  const armStroke = (): void => {
    strokeArmed = true;
    emitIntent();
    // A DRAG IS DRIVEN BY MOTION, NOT BY A TIMER (owner report, 2026-08-23:
    // "I get one drag, and then it's like I've unclicked"). The hold-repeat
    // ramp exists so a HELD stamp keeps stacking bands in one place — that is
    // the whole thing a stamp does when the cursor is still. A drag does the
    // opposite: standing still means the lip is already where the player put
    // it, so there is nothing to repeat. Emission therefore comes from
    // onPointerMove below, and scheduling a repeat here would only re-run a
    // walk that has no cells left to cross.
    //
    // The wire rate stays bounded WITHOUT a timer, because a drag emits per
    // CELL CROSSED, not per event: a hundred pointermove events inside one
    // cell send nothing at all, and a fast sweep is capped by
    // DRAG_CELLS_PER_EMIT per emission.
    if (strokeBand !== null) return;
    scheduleRepeat(0);
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
    // GRAB, OR STAMP — decided here, once, after the pointer position is
    // recorded, because the lip query has to run against the cell THIS press
    // is over. A press over a terrace lip starts a DRAG of that band; anywhere
    // else it is the stamp it has always been. The query is the same one that
    // highlights the edge on screen, so the player has already been shown,
    // before pressing, which of the two this press will be.
    //
    // RAISE ONLY, for now. Dragging a lip INWARD is the same gesture with the
    // lower modifier held, and it is the direction that needs a real stop rule
    // (a lip pulled in must not strip the ground standing on it) — the next
    // piece of this tool, deliberately not this one. Until it exists, a lower
    // press over a lip stays an ordinary lowering stamp rather than silently
    // doing something the player cannot predict.
    strokeBand = action === 'raise' ? grabbableBand(hoverTarget()) : null;

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
      // A live, armed DRAG follows the cursor directly — see armStroke.
      if (strokeArmed && strokeBand !== null) emitIntent();
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
