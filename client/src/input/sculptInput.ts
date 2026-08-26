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
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
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
import { BAND_HEIGHT } from '@terrace/shared';
import type { SculptIntent } from '@terrace/shared';


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
   * The terrace band whose lip this PICK is pointing at, or null for none
   * (World.highlightLayerEdge →
   * render/layerEdgeOverlay.ts). This is the SAME query that lights the lip up
   * on screen, so what the player sees highlighted is exactly what a press
   * grabs — the highlight is the affordance, and two answers to "is there a
   * lip here" would make it a lie.
   */
  grabbableLip: (pick: TerrainRayPick | null) => number | null;
  /**
   * The band this PICK has hold of — the intent's `spanBand`, or null for the
   * topmost span (World.graspSpanBand). Null on every ordinary column, so an
   * unlayered world puts nothing new on the wire.
   */
  graspSpanBand: (pick: TerrainRayPick | null) => number | null;
  /**
   * Emits one intent, and reports whether it went out — false when a client
   * plugin vetoed it (out of mana) or the socket was not ready.
   *
   * NO LONGER LOAD-BEARING FOR DRAGS, and the reason is the whole point of the
   * 2026-08-24 rework. A drag used to be a CHAIN of per-cell intents, each one
   * legal only because the previous had landed, so an emitter that could not
   * tell a sent intent from a dropped one walked past the hole it had just
   * made and every remaining cell was refused. A drag now sends its WHOLE
   * region absolutely on every emission, so a dropped intent is simply a frame
   * the lip did not move — the next pointer move re-sends the same region and
   * it heals itself (issue #120).
   */
  send: (intent: SculptIntent) => boolean;
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
    grabbableLip,
    graspSpanBand,
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
   * null for an ordinary brush stroke.
   *
   * FROZEN, NOT RE-QUERIED, and this is what stops the wander (issue #119). A
   * pull MOVES the lip, so re-asking "what lip is under the cursor now"
   * mid-stroke lets the stroke re-grab the edge it just built — the edit
   * chasing its own result — or hand off to a different band's lip the pull
   * happened to sweep past, with the player unable to predict which terrace
   * they were moving.
   */
  let strokeGrab: number | null = null;

  /**
   * Whether the stroke has actually started sculpting. A touch stroke waits out
   * TOUCH_STROKE_GRACE_MS first, and a drag must not emit on pointer motion
   * during that window or the second finger of a camera gesture would carve a
   * furrow before it could cancel the stroke.
   */
  let strokeArmed = false;

  /**
   * The cursor cell the last drag intent named, so an unmoved cursor sends
   * nothing.
   *
   * A RATE LIMIT, NOT A CHAIN — the distinction the per-cell build got wrong.
   * Every drag intent describes the whole region absolutely, so skipping a
   * duplicate loses no information whatsoever: the next one that does go out
   * carries everything the skipped one would have. It exists purely so a
   * hundred pointermove events inside one cell do not become a hundred
   * messages.
   */
  let lastDragToX = 0;
  let lastDragToY = 0;
  let haveDragTo = false;

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
  /**
   * How steeply the pointer ray must descend for its meeting with the drag
   * plane to mean anything, as the downward component of a unit direction.
   *
   * A ray nearly parallel to the plane meets it a very long way off, and moves
   * that meeting point by an enormous distance for one pixel of mouse travel —
   * the caveat raised against plane projection when it was proposed (issue
   * #99). Below this the sample is not merely imprecise, it is unusable, so it
   * is discarded and the pull keeps the depth it last had.
   *
   * 0.05 is one part in twenty: at the horizon-most usable camera pitch the
   * plane is still met within twenty times the camera's height above it. Above
   * that the arithmetic is fine and the drag is simply a shallow-angle drag,
   * which is the player's business.
   */
  const MIN_DRAG_PLANE_DESCENT = 0.05;

  /**
   * WHERE THE CURSOR IS, FOR A DRAG: the cell where the pointer ray meets a
   * FIXED HORIZONTAL PLANE at the grabbed lip's height.
   *
   * NOT the terrain pick, and that is the whole point (issue #119). The
   * ordinary hover pick marches the height field, so during a drag it is
   * reading ground the drag itself is raising: the pull builds land, the new
   * land intercepts the ray earlier, the picked cell moves back toward the
   * grab, and the depth stops growing — the lip moves a cell or two and then
   * stalls no matter how far the player keeps pulling. A plane frozen at the
   * height the lip was grabbed at cannot be disturbed by the edit, so the
   * cursor means the same thing at the end of the stroke as at the start.
   *
   * Null when the world is not up, the pointer is off the canvas, or the ray
   * is too shallow to trust (MIN_DRAG_PLANE_DESCENT); the caller keeps its
   * last depth rather than lurching.
   */
  const dragPlaneCell = (band: number): { x: number; y: number } | null => {
    const size = worldSize();
    if (size <= 0 || !havePointer) return null;

    const rect = canvas.getBoundingClientRect();
    const device = pointerToNdc(pointerClientX, pointerClientY, rect);
    if (device === null) return null;
    ndc.set(device.x, device.y);
    raycaster.setFromCamera(ndc, camera);

    const origin = raycaster.ray.origin;
    const direction = raycaster.ray.direction;
    // World Y of the grabbed band's floor — the plane the lip lies in. Derived
    // from the band, so it is exactly the surface the player took hold of.
    const planeY = band * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
    // Looking up, or level, or from below: the ray never reaches the plane
    // ahead of the camera.
    if (direction.y > -MIN_DRAG_PLANE_DESCENT) return null;
    const distance = (planeY - origin.y) / direction.y;
    if (!Number.isFinite(distance) || distance <= 0) return null;

    const worldX = origin.x + direction.x * distance;
    const worldZ = origin.z + direction.z * distance;
    const x = Math.floor(worldX / CELL_WORLD_SIZE);
    const y = Math.floor(worldZ / CELL_WORLD_SIZE);
    // Off the world: the plane is infinite, the world is not.
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    return { x, y };
  };

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
    // hitRiser, hitY and spanIndex ride along unchanged: all three are facts
    // about the RAY, and this branch only refreshes the cached cell's height
    // after the ground moved under a stationary pointer. The next pointermove
    // re-picks and re-decides them.
    //
    // The refreshed height is `terrainHeightAt`, i.e. the TOPMOST span's cap,
    // so this is only the right surface for a pick on the topmost span. That
    // is every pick while every column holds exactly one (columns.ts); a
    // layered world has to re-pick here instead of re-reading.
    hoverCache = {
      x: hoverCache.x,
      y: hoverCache.y,
      surfaceY,
      spanIndex: hoverCache.spanIndex,
      hitRiser: hoverCache.hitRiser,
      hitY: hoverCache.hitY,
    };
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
    const action = currentStrokeAction();
    // A DRAG READS THE PLANE, NOT THE GROUND (issue #119). Resolved before the
    // hover pick so a drag never touches it: the pick marches terrain the drag
    // is raising, and reading it here is what made the pull stall a cell or
    // two in (see dragPlaneCell). setSculptMode still runs first for both, so
    // the HUD's raise/lower indicator is honest either way.
    setSculptMode(action);
    // A Pull with nothing in its grasp emits nothing at all. Without this the
    // generic send below would put a `drag` intent with no band on the wire,
    // which the shared math treats as a no-op — a message, and a mana charge,
    // for an edit that was never going to happen.
    if (brushTool() === 'drag' && strokeGrab === null) return;
    if (strokeGrab !== null) {
      const to = dragPlaneCell(strokeGrab);
      // Too shallow a ray, or off the world: hold the pull where it was rather
      // than lurch. The intent is absolute, so skipping one sample loses
      // nothing — the next usable one carries the whole pull.
      if (to === null) return;
      emitDrag(to.x, to.y, action, strokeGrab);
      return;
    }
    const cell = hoverTarget();
    if (cell === null) return;
    // WHICH SPAN THIS STROKE HAS HOLD OF, omitted entirely on an ordinary
    // column so an unlayered world's intents are byte-identical to before the
    // field existed (World.graspSpanBand returns null there).
    const spanBand = graspSpanBand(cell);
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
      ...(spanBand !== null ? { spanBand } : {}),
      seq: nextSeq++,
    });
  };

  /**
   * THE PULL EMISSION — one self-contained intent describing the disc under
   * the cursor right now.
   *
   * Not a step, not an increment, not a link in a chain: the cursor cell and
   * the radius name the whole edit, and the server re-derives it from its own
   * heightmap (shared/heightmap.ts, applyDragRegion). Re-sending the same one
   * changes nothing. That is why a dropped intent costs a frame rather than
   * the rest of the stroke — the failure of the per-cell chain this replaces
   * (issue #120).
   *
   * Skips a repeat of the same cursor cell, which is a rate limit and nothing
   * more (see lastDragTo).
   */
  const emitDrag = (toX: number, toY: number, action: SculptAction, band: number): void => {
    if (haveDragTo && toX === lastDragToX && toY === lastDragToY) return;
    const sent = send({
      type: 'sculpt',
      // THE CURSOR CELL, which for this tool is where the edit happens — the
      // same meaning x/y carry for every brush. The cell the lip was first
      // grabbed at does not appear in the intent at all: a pull is wherever
      // the hand is now, not a measurement from where it started, which is
      // what lets the lip turn and curve instead of advancing as one straight
      // front (owner report, 2026-08-24).
      x: toX,
      y: toY,
      radius: brushRadius(),
      dir: sculptDirection(action),
      tool: 'drag',
      // Read live, so switching the toggle mid-stroke reshapes the very next
      // intent — soft advances the lip as a smooth face, hard fills every
      // legal cell of the disc.
      profile: brushProfile(),
      targetBand: band,
      // NO `spanBand` HERE YET, and that is a decision rather than an
      // oversight. A pull's x/y is the CURSOR cell, not the cell whose lip is
      // in the player's grasp, so a grasp derived here would name a span of the
      // wrong column — and the shared math's whole-stroke guard would then
      // no-op legitimate pulls over layered ground. The pull's grasp travels as
      // `targetBand` plus the per-cell neighbour rule inside applyDragRegion,
      // which is where the span-aware form belongs (plan step 4.5, D5).
      seq: nextSeq++,
    });
    // A dropped intent leaves lastDragTo alone, so the very next pointermove
    // — even one inside the same cell — retries the identical disc.
    if (!sent) return;
    lastDragToX = toX;
    lastDragToY = toY;
    haveDragTo = true;
  };

  const stopRepeat = (): void => {
    strokeButton = null;
    strokePointerId = null;
    strokeIsTouch = false;
    strokeGrab = null;
    strokeArmed = false;
    haveDragTo = false;
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
    // CURSOR CELL CHANGE, not per event: a hundred pointermove events inside
    // one cell send nothing at all (see lastDragTo).
    // THE PULL NEVER REPEATS, whether it grabbed a lip or seeded a new layer.
    // A held stamp stacking bands in one place is the whole thing a stamp
    // does; standing still with the Pull tool means the lip is already where
    // the player put it, and a seeded layer is "a single layer" by the owner's
    // instruction — a repeat would turn either into a tower.
    if (brushTool() === 'drag') return;
    scheduleRepeat(0);
  };

  /**
   * RAISES ONE LAYER where there is no lip to take hold of (owner, 2026-08-24:
   * "if there is no edge to pull, pop up a new layer that we can start pulling
   * — just a single layer").
   *
   * A `hard` stamp, which level-fills its footprint to the next band, so what
   * appears is a flat one-band plateau with a clean lip all the way round —
   * the thing the pull needs in order to have anything to grab. `hard`
   * regardless of the edge toggle: a soft stamp's falloff would leave a mound
   * whose rim crosses no band at all on flat ground, i.e. no lip and nothing
   * gained.
   *
   * EXACTLY ONE, never a stack. The press that seeds a layer does not start
   * the hold-repeat (see armStroke), so holding the button steadies the new
   * plateau rather than building a tower out of it.
   *
   * Returns whether the intent reached the wire; a seed that did not go out
   * has raised nothing, so there is no new lip to grab either.
   */
  const seedLayer = (cell: { x: number; y: number }): boolean =>
    send({
      type: 'sculpt',
      x: cell.x,
      y: cell.y,
      radius: brushRadius(),
      dir: sculptDirection('raise'),
      tool: 'stamp',
      profile: 'hard',
      seq: nextSeq++,
    });

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
    // GRAB, OR BRUSH — decided here, once, after the pointer position is
    // recorded, because the lip query has to run against the cell THIS press
    // is over.
    //
    // THE PULL IS A TOOL YOU SELECT, not a mode a press falls into (owner
    // decision 2026-08-24). It used to grab whenever a press happened to land
    // near a lip, whatever tool was chosen, which meant the same click did two
    // different things depending on ground the player could easily misjudge.
    // Now Stamp and Smooth always brush and Pull always pulls, so the HUD
    // states which of the two a press will be before the press happens. The
    // lip query is still the one that highlights the edge on screen, so within
    // the Pull tool what is lit up is exactly what a press takes hold of.
    //
    // BOTH DIRECTIONS (issue #99 step 3, 2026-08-24). The lower modifier pulls
    // the grabbed lip INWARD and the band retreats, exposing the ground it was
    // standing proud of; the stop rule that direction needed now exists in the
    // shared math (applyDragRegion/retreatHeightAt — only cells at exactly the
    // grabbed band move, so a lip pulled in never strips the ground standing on
    // it). The grab itself is direction-blind: it is the same lip either way.
    const pulling = brushTool() === 'drag';
    strokeGrab = pulling ? grabbableLip(hoverTarget()) : null;
    // SEEDING IS A RAISE-ONLY RESCUE. A lower press with nothing in its grasp
    // has nothing to retreat, and stamping a plateau to pull in would be the
    // opposite of what the player just asked for — it emits nothing instead.
    if (pulling && action === 'raise' && strokeGrab === null) {
      // NOTHING TO PULL, SO MAKE SOMETHING. The seed is applied locally by the
      // prediction the moment it is sent (main.tsx's send), and the layer-edge
      // overlay re-contours on the same dirty set, so the lip it creates
      // already exists by the time the next line asks for it — this press
      // becomes a pull of the layer it just raised, in one gesture.
      const seedCell = hoverTarget();
      if (seedCell !== null && seedLayer(seedCell)) strokeGrab = grabbableLip(hoverTarget());
    }

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
      if (strokeArmed && strokeGrab !== null) emitIntent();
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
