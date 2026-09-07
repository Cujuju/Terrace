// Pointer → sculpt intent.
//
// CRITICAL CODE — this is the only place the client originates network
// traffic, and the client sends INTENTS, never heights (design doc). The
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
// THE DIRECTION IS THE TOOL'S WHEN THE TOOL HAS ONLY ONE (shared's
// TOOLS_WITHOUT_DIRECTION). With Carve selected, every press above sculpts
// DOWN: the modifier still decides who owns the press (so the camera stands
// down exactly as before) but no longer decides the direction, and the HUD's
// sticky mode is neither read nor written. Carving must not require a chord,
// and there is no second direction for one to select.
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
  HEIGHT_WORLD_SCALE,
  SCULPT_REPEAT_DELAY_MS,
  SCULPT_REPEAT_INTERVAL_MS,
  SCULPT_REPEAT_RAMP_FACTOR,
  TOUCH_STROKE_GRACE_MS,
} from '../config.ts';
import {
  pointerToNdc,
  worldPointToCell,
  type TerrainRayPick,
  type Vec3,
} from '../terrain/picking.ts';
import { footOfFaceCell } from '../terrain/faceFoot.ts';
import {
  DEFAULT_BRUSH_TOOL,
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
import {
  BAND_HEIGHT,
  MAX_DRAG_SWEEP_CELLS,
  TOOLS_WITHOUT_DIRECTION,
  TOOLS_WITHOUT_EDGE_PROFILE,
  chebyshevDistance,
} from '@terrace/shared';
import type { SculptIntent, SculptTool } from '@terrace/shared';

/**
 * THE TOOLS THAT ANCHOR TO THE TREAD AT THE FOOT OF A STRUCK FACE (issue #347,
 * owner 2026-09-05: a Plateau press near a lip "raises the clicked band and
 * extends the band above").
 *
 * A brush anchors to the CENTRE cell's own ceiling plus one band (shared's
 * `anchoredTargetHeight`), so a press that names the upper cell of a step
 * targets two bands up and fills both. These tools mean the surface the player
 * is looking at, which on a riser is the tread the face rises from.
 *
 * NOT `drag` and NOT `carve`, deliberately: the drag GRABS the struck face's
 * band and the carve CUTS it, so for both of them the upper cell is not an
 * off-by-one — it is the thing being acted on.
 */
const TOOLS_WITH_FOOT_ANCHOR: readonly SculptTool[] = ['stamp', 'smooth'];


export interface SculptInputOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  /**
   * The world's ray pick (World.pickCell) — one shared implementation, so the
   * brush and plugin clicks can never disagree about which cell a ray means.
   */
  pickCell: (origin: Vec3, direction: Vec3) => TerrainRayPick | null;
  /**
   * The SAME ray, re-asked of ONE column of the LIVE map (World.pickInColumn).
   *
   * THE WHOLE OF THE HOVER CACHE (issue #324, 2026-09-04). `hoverTarget` pins
   * the cell the player aimed at and the ray that aimed at it — both facts
   * about the RAY, which edits cannot invalidate — and re-derives everything
   * the pick says about the MAP through this, every read. No `spanIndex`, no
   * `surfaceY`, no `hitY` is ever copied from one frame to the next.
   *
   * Null when the ray meets nothing in that column at all, which is
   * `hoverTarget`'s signal to march again.
   */
  pickInColumn: (
    x: number,
    y: number,
    origin: Vec3,
    direction: Vec3,
  ) => TerrainRayPick | null;
  /** Live world size; 0 until the join snapshot arrives. */
  worldSize: () => number;
  /**
   * The band of the RISER under the pointer — guard-admitted — or null
   * (World.highlightLayerEdge → render/layerEdgeOverlay.ts).
   *
   * Null on a tread, on a cave roof's underside, and off the world: a lip has
   * no width, so being "on the lip" means being on the riser FACE (owner,
   * 2026-08-26). No search radius, no nearest-lip snap.
   *
   * This is the SAME query that lights the lip up on screen, so what the player
   * sees highlighted is exactly what a press grabs — the highlight is the
   * affordance, and two answers to "is there a lip here" would make it a lie.
   */
  riserBand: (pick: TerrainRayPick | null) => number | null;
  /**
   * The terrace band of the terrain at a cell (World.bandAtCell) — read before
   * and after a seed to learn whether the seed actually raised the ground. See
   * `takeHold`; the unit is BANDS, which is why it is asked of the world rather
   * than derived from world-unit heights here.
   */
  bandAtCell: (x: number, y: number) => number | null;
  /**
   * The band this PICK has hold of — the intent's `spanBand`, or null for the
   * topmost span (World.graspSpanBand). Null on every ordinary column, so an
   * unlayered world puts nothing new on the wire.
   */
  graspSpanBand: (pick: TerrainRayPick | null) => number | null;
  /**
   * The band a CARVE cuts from at this pick (World.carveBand) — the same
   * derivation `graspSpanBand` uses, but answered for an ordinary column too,
   * because the first cut of any tunnel is made into unlayered rock.
   */
  carveBand: (pick: TerrainRayPick | null) => number | null;
  /**
   * WHERE A HELD CARVE CUTS NEXT (World.carveReach): the first cell along this
   * ray that still has material at `band`, or null when the aim runs out of
   * solid material — the "no more cutting" that ends a tunnel.
   *
   * NOT `pickCell`, and that is the point (GH #349). A repeat that re-picked
   * asked "what surface is under the pointer", and after the first cut the
   * answer is the FLOOR of the hole the cut just made, INSIDE THE SAME CELL —
   * so the repeat re-cut a band that column no longer had and moved nothing.
   * A tunnel's question is "where along my aim is there still rock", which is
   * this.
   */
  carveReach: (
    origin: Vec3,
    direction: Vec3,
    band: number,
  ) => { x: number; y: number } | null;
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
   * THE CELL AND THE RAY ARE WHAT THE CACHE HOLDS. Everything else — the span
   * index, `surfaceY`, `hitY`, the face kind — is re-derived from the LIVE map
   * on every call by re-asking the pinned ray of the pinned column
   * (`pickInColumn`), so the outline tracks ground the player is actively
   * sculpting while the target cell stays the one they aimed at. Re-firing the
   * ray instead would move that target — see hoverTarget's own note and
   * emitIntent's issue-#25 comment.
   */
  hoverTarget(): TerrainRayPick | null;
  /**
   * The band the LIVE stroke has hold of, or null when no stroke is dragging
   * one — the frozen `strokeGrab`.
   *
   * Exposed so the frame loop can keep the grabbed lip lit for as long as it is
   * held. The highlight is otherwise re-derived from the live pick every frame,
   * and a drag moves the pointer OFF the riser it grabbed within the first
   * cell — so the lip the player is holding went dark while they were holding
   * it.
   */
  heldBand(): number | null;
  /**
   * ENDS THE LIVE STROKE AS A POINTERUP WOULD — the grab dropped, the aimed
   * cell unpinned, the drag's sent-region bookkeeping cleared, the repeat
   * timer cancelled — while the button is still physically held.
   *
   * FOR A CLIENT-SIDE REFUSAL (owner, 2026-09-06: "disable the click... like
   * the user let off the click, so that if they're continuing to drag around
   * while holding the mouse, they don't get inconsistent sculpting"). The
   * plugin interceptor chain vetoes ONE intent (main.tsx's `send`), but a held
   * stroke re-emits on every pointer move and every repeat tick, so without
   * this a stroke that ran out of mana kept firing intents into a gate that
   * kept refusing them — sculpting again the instant regen crossed the price,
   * mid-drag, without the player having pressed anything.
   *
   * The stroke does NOT resume on its own: a fresh pointerdown is required,
   * which is the intentional re-click the owner asked for.
   */
  releaseStroke(): void;
  /**
   * IS A REFUSED BUTTON STILL DOWN — true from the veto that called
   * `releaseStroke` until that same pointer comes up (or is cancelled, or the
   * window loses it, or a new press supersedes it).
   *
   * WHAT THE RED OUTLINE IS DRAWN FROM (render/brushPreview.ts's `denied`).
   * The refusal is not an event that happens and is gone, it is the state the
   * press is in — owner, 2026-09-06: "if it just goes back to the normal
   * colour and they can't draw, then they have no idea what's going on". The
   * button being down is exactly as long as that state lasts, and this module
   * is the one that knows it, so the cue is read from here rather than kept as
   * a second copy inside the renderer.
   */
  refusedHold(): boolean;
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
    pickInColumn,
    worldSize,
    riserBand,
    bandAtCell,
    graspSpanBand,
    carveBand,
    carveReach,
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
   * THE TOOL THIS STROKE IS SCULPTING WITH, decided at the press and fixed for
   * the stroke — exactly like `strokeAction` and `strokeGrab` beside it.
   *
   * FROZEN BECAUSE THE GRASP IS. Which tool is held decides whether the press
   * takes hold of a lip at all (`takeHold`), and that answer is frozen in
   * `strokeGrab`; reading the live HUD signal afterwards let the two disagree.
   * Clicking Stamp in the HUD mid-drag kept the frozen grasp and went on
   * dragging the terrace out while the HUD said Stamp, and switching the other
   * way — Stamp to Drag, with nothing grasped — made every remaining intent
   * fall out of `emitIntent`'s "a Drag with nothing in its grasp emits
   * nothing" guard, so the brush went dead until the button was released.
   *
   * Only the TOOL is frozen. Radius and edge stay live reads, because neither
   * one is half of a decision the press already made: they reshape the next
   * intent and nothing about the stroke contradicts them.
   *
   * Meaningful only while a stroke is live; every press sets it before
   * anything reads it, and the initial value is simply the HUD's own default.
   */
  let strokeTool: SculptTool = DEFAULT_BRUSH_TOOL;

  /**
   * THE GRABBED BAND, decided once at pointerdown and fixed for the stroke —
   * null for an ordinary brush stroke.
   *
   * FROZEN, NOT RE-QUERIED, and this is what stops the wander (issue #119). A
   * drag MOVES the lip, so re-asking "what lip is under the cursor now"
   * mid-stroke lets the stroke re-grab the edge it just built — the edit
   * chasing its own result — or hand off to a different band's lip the drag
   * happened to sweep past, with the player unable to predict which terrace
   * they were moving.
   */
  let strokeGrab: number | null = null;

  /**
   * THE BAND A CARVE STROKE IS CUTTING, taken from the FIRST cut of the press
   * and held until release — null until then, and for every other tool.
   *
   * THE BAND IS THE CARVE'S GRASP, exactly as `strokeGrab` is the drag's, and
   * it is frozen for the same reason: it is half of a decision the press
   * already made. Owner, 2026-09-05: "Why would I get a different band when
   * I'm still explicitly pointing at band three?"
   *
   * WHY RE-DERIVING IT WAS WRONG, precisely. The hover pin keeps faith with
   * the CELL and the RAY and deliberately with nothing derived from the map
   * (see `hoverCell`), so every repeat asked `carveBand` afresh — and the cut
   * had just changed the very column it asks about. The ray then met the
   * ceiling the cut exposed, an underside hit names the roof's lowest drawn
   * band, and the repeat opened the band ABOVE the one the player was pointing
   * at. That is the "band three and four missing" report of the same day.
   *
   * NOT KEPT ACROSS PRESSES (owner's choice, 2026-09-05): released in
   * `stopRepeat` with the rest of the stroke, so the next press re-derives the
   * band from wherever the pointer is then.
   */
  let strokeCarveBand: number | null = null;

  /**
   * Whether the stroke has actually started sculpting. A touch stroke waits out
   * TOUCH_STROKE_GRACE_MS first, and a drag must not emit on pointer motion
   * during that window or the second finger of a camera gesture would carve a
   * furrow before it could cancel the stroke.
   */
  let strokeArmed = false;

  /**
   * WHAT THE LAST DRAG INTENT SAID — the cursor cell it named and the two
   * live HUD readings that shape it — so an intent that would repeat it sends
   * nothing.
   *
   * A RATE LIMIT, NOT A CHAIN — the distinction the per-cell build got wrong.
   * Every drag intent describes the whole region absolutely, so skipping a
   * duplicate loses no information whatsoever: the next one that does go out
   * carries everything the skipped one would have. It exists purely so a
   * hundred pointermove events inside one cell do not become a hundred
   * messages.
   *
   * THE WHOLE INTENT, NOT JUST THE CELL. Keyed on the cursor cell alone this
   * dropped intents that were not duplicates at all: pressing Shift to drag a
   * lip back IN without moving the mouse changes `dir` and nothing else, and
   * was silently swallowed until the player jiggled the cursor into another
   * cell. Everything else a drag's intent carries is fixed for the stroke —
   * the tool, the grasped band — or absent, so cell, direction and radius are
   * the whole of what can differ between two of them.
   */
  let lastDragToX = 0;
  let lastDragToY = 0;
  let lastDragDir: 1 | -1 = 1;
  let lastDragRadius = 0;
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

  /** A world-space ray, owned by this module rather than by Three's scratch. */
  interface PointerRay {
    readonly origin: Vec3;
    readonly direction: Vec3;
  }

  /**
   * The world-space ray through the current pointer position, or null when
   * there is nothing to aim (no world yet, pointer away, canvas not laid out).
   *
   * COPIED OUT OF THE RAYCASTER, not returned by reference: `raycaster.ray` is
   * reused by the next call, and `hoverTarget` keeps this ray across frames —
   * a reference would silently become the newest ray instead of the pinned one.
   *
   * Three is used for the ONE step that needs the camera: unprojecting the
   * pointer. The ray then goes to the height-field march, which never touches
   * the scene graph.
   */
  const pointerRay = (): PointerRay | null => {
    const size = worldSize();
    if (size <= 0 || !havePointer) return null;

    const rect = canvas.getBoundingClientRect();
    const device = pointerToNdc(pointerClientX, pointerClientY, rect);
    if (device === null) return null;

    ndc.set(device.x, device.y);
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    return {
      origin: { x: o.x, y: o.y, z: o.z },
      direction: { x: d.x, y: d.y, z: d.z },
    };
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
  /**
   * THE TWO THINGS THE CACHE HOLDS, and it holds nothing else (issue #324,
   * 2026-09-04): the CELL the player aimed at, and the RAY that aimed at it.
   *
   * Both are facts about the pointer, so an edit made with them cannot make
   * either of them wrong. Everything the pick says about the MAP — the span
   * index, the surface height, the struck height — is re-derived from the live
   * terrain on every read, so there is no representation for a stale one.
   */
  let hoverCell: { x: number; y: number } | null = null;
  let hoverRay: PointerRay | null = null;
  /**
   * How steeply the pointer ray must descend for its meeting with the drag
   * plane to mean anything, as the downward component of a unit direction.
   *
   * A ray nearly parallel to the plane meets it a very long way off, and moves
   * that meeting point by an enormous distance for one pixel of mouse travel —
   * the caveat raised against plane projection when it was proposed (issue
   * #99). Below this the sample is not merely imprecise, it is unusable, so it
   * is discarded and the drag keeps the depth it last had.
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
   * reading ground the drag itself is raising: the drag builds land, the new
   * land intercepts the ray earlier, the picked cell moves back toward the
   * grab, and the depth stops growing — the lip moves a cell or two and then
   * stalls no matter how far the player keeps dragging. A plane frozen at the
   * height the lip was grabbed at cannot be disturbed by the edit, so the
   * cursor means the same thing at the end of the stroke as at the start.
   *
   * Null when the world is not up, the pointer is off the canvas, or the ray
   * is too shallow to trust (MIN_DRAG_PLANE_DESCENT); the caller keeps its
   * last depth rather than lurching.
   */
  const dragPlaneCell = (band: number): { x: number; y: number } | null => {
    const size = worldSize();
    // The SAME ray the pick uses, from the one place that unprojects the
    // pointer — a second copy of that setup is a second chance to aim
    // differently from what the player sees.
    const ray = pointerRay();
    if (size <= 0 || ray === null) return null;
    const { origin, direction } = ray;
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
    // THE ONE PLAN-POINT → CELL RULE (terrain/picking.ts). This used to floor
    // where every other pick rounds, which is half a cell of bias in one
    // direction for the whole length of every drag. `worldPointToCell` also
    // owns the off-the-world rule — the plane is infinite, the world is not,
    // and a point past the border is the EDGE cell (issue #281 A), so a drag
    // flicked off the world lands on the border rather than holding short.
    return worldPointToCell(worldX, worldZ, size);
  };

  /**
   * MARCHES AGAIN, and re-pins both halves of the cache from the result: the
   * ray that was fired and the cell it named. The ONE way `hoverCell` and
   * `hoverRay` are set together, so a re-pick can never leave the cell
   * belonging to one ray and the ray to another.
   */
  const repick = (): TerrainRayPick | null => {
    const ray = pointerRay();
    hoverRay = ray;
    if (ray === null) {
      hoverCell = null;
      return null;
    }
    const pick = pickCellByRay(ray.origin, ray.direction);
    hoverCell = pick === null ? null : { x: pick.x, y: pick.y };
    return pick;
  };

  /**
   * THE CELL AND THE RAY ARE PINNED; NOTHING DERIVED FROM THE MAP IS
   * (issue #324, 2026-09-04).
   *
   * The cache key is the pointer, the camera and the world size, and
   * DELIBERATELY carries nothing about the terrain (owner, 2026-08-14: the
   * outline "needs to follow the mouse even during a pan"; a pointer-only key
   * froze it mid-pan). While that key is unchanged, this re-evaluates the
   * PINNED ray against the PINNED column of the LIVE map, using the march's own
   * per-cell function — so the pick handed back is always a fresh statement
   * about the terrain as it is now, and a span index that an edit renumbered
   * has no way to survive into the next frame.
   *
   * IT USED TO PATCH A CACHED PICK field by field after each edit, and every
   * consumer then depended on ad-hoc validity checks — span count unchanged,
   * struck height still inside the slab — that each new kind of edit could
   * defeat. The 2026-09-04 report (a second carve press with the mouse still
   * dug the band BELOW the one just cut) was one such escape; the contract here
   * is that there is nothing left to escape from.
   *
   * THE TWO SETTLED PROMISES BOTH HOLD.
   *  - A HELD STROKE TARGETS THE CELL THE PLAYER AIMED AT (owner 2026-08-22,
   *    issue #25). The cell is pinned, so a raise cannot march the stroke
   *    uphill into the ground it just built, and a lower cannot walk it away
   *    toward the camera — `pickInColumn`'s ground-under-the-ray fallback
   *    answers with the ground still under the pinned column when the edit has
   *    dropped it below the ray entirely.
   *  - THE OUTLINE LIES ON THE GROUND. `surfaceY` comes from the live map on
   *    every read, so the ring follows ground the player is actively sculpting
   *    instead of hanging at the pre-stroke height.
   *
   * CONSEQUENCE, AND IT IS HONEST: after an edit made with the mouse still, a
   * tread hit may become a RISER hit (the ground the player raised now meets
   * the ray on its face) or the other way round. The CELL is what is promised,
   * not the kind of face — and the face the pick reports is the face that ray
   * genuinely meets in the world as it now is.
   *
   * COST: one column's span loop per read while the key is unchanged, against
   * a full march of 0.0063 ms (docs/decisions/picking.md). There is no
   * revision check on purpose — the contract must not rest on every heightmap
   * mutation remembering to bump one.
   */
  const hoverTarget = (): TerrainRayPick | null => {
    const p = camera.position;
    const q = camera.quaternion;
    const key = havePointer
      ? `${pointerClientX},${pointerClientY},${worldSize()},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}`
      : 'away';
    if (key !== hoverKey) {
      hoverKey = key;
      return repick();
    }
    if (hoverCell === null || hoverRay === null) return repick();
    const pick = pickInColumn(hoverCell.x, hoverCell.y, hoverRay.origin, hoverRay.direction);
    // NOTHING LEFT IN THAT COLUMN — the chunk went on a rejoin, or the ground
    // under the ray was removed outright. A march is the honest answer: there
    // is no aimed-at cell left to keep faith with, and it re-pins both halves.
    if (pick === null) return repick();
    return pick;
  };

  /**
   * The action for the stroke RIGHT NOW. Modifiers may change mid-stroke
   * (press or release shift while holding the button): if the stroke's button
   * currently resolves to a sculpt action, follow it — that preserves the
   * long-standing "release shift mid-drag to switch back to raise" behaviour.
   * If it resolves to a camera action or nothing (the user mashed a modifier
   * that unbinds the button), keep the last sculpt action rather than
   * stopping: a stroke never changes owner mid-flight.
   *
   * A TOOL WITH NO DIRECTION IS NEVER RE-RESOLVED (owner report, 2026-09-02).
   * `startStroke` fixed such a stroke at `lower` because that is the only
   * thing the tool does; re-reading the modifier here would let releasing
   * shift mid-carve flip the stroke to `raise`, which `emitIntent` then drops
   * — the carve silently dying halfway through a drag.
   */
  const currentStrokeAction = (): SculptAction => {
    if (strokeButton !== null && !strokeIsTouch && !TOOLS_WITHOUT_DIRECTION.includes(strokeTool)) {
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
    // is raising, and reading it here is what made the drag stall a cell or
    // two in (see dragPlaneCell). setSculptMode still runs first for both, so
    // the HUD's raise/lower indicator is honest either way.
    //
    // EXCEPT FOR A TOOL WITH NO DIRECTION, which must not touch the sticky
    // mode at all (owner report, 2026-09-02). `sculptMode` is PERSISTED and
    // shared by every tool: a carve writing 'lower' into it would leave the
    // next Stamp press digging, and on touch — where the sticky mode IS the
    // direction — it would silently rewrite the player's choice. The carve's
    // direction is the tool's, so it is nobody else's business.
    if (!TOOLS_WITHOUT_DIRECTION.includes(strokeTool)) setSculptMode(action);
    // A Drag with nothing in its grasp emits nothing at all. Without this the
    // generic send below would put a `drag` intent with no band on the wire,
    // which the shared math treats as a no-op — a message, and a mana charge,
    // for an edit that was never going to happen.
    if (strokeTool === 'drag' && strokeGrab === null) return;
    // A CARVE ONLY EVER LOWERS (plan D6). The raise chord is not "carve
    // upward", it is nothing at all: the shared validator rejects a carve
    // intent carrying `dir: 1` with the whole intent, so emitting one would
    // spend a seq and a mana gate on a message the server drops on the floor.
    //
    // NOW UNREACHABLE, AND KEPT (owner report, 2026-09-02). Since a stroke
    // with a direction-less tool is pinned to `lower` at the press and never
    // re-resolved, `action` cannot be `raise` here. It stays as the last line
    // of defence on the ONE function that puts a sculpt on the wire: the
    // pinning lives in two places (`startStroke` and `currentStrokeAction`)
    // and a third caller could yet be added, whereas nothing reaches the wire
    // without passing this. Belt and suspenders, at the cost of one compare.
    if (TOOLS_WITHOUT_DIRECTION.includes(strokeTool) && sculptDirection(action) > 0) return;
    if (strokeGrab !== null) {
      const to = dragPlaneCell(strokeGrab);
      // Too shallow a ray, or off the world: hold the drag where it was rather
      // than lurch. The intent is absolute, so skipping one sample loses
      // nothing — the next usable one carries the whole drag.
      if (to === null) return;
      emitDrag(to.x, to.y, action, strokeGrab);
      return;
    }
    // ── A CARVE PAST ITS FIRST CUT TUNNELS ALONG ITS AIM (GH #349, owner
    // 2026-09-05: "cut through this band until there's no more cutting and
    // then you stop"). It is the one tool whose repeat does not act on the
    // surface under the pointer, and it cannot: the cut it just made put a
    // hole there, so the surface under the pointer IS that hole's floor. The
    // band is the press's (`strokeCarveBand`) and the only open question is
    // where along the aim there is still rock, which `carveReach` answers.
    //
    // THE PRESS'S RAY, not a fresh one — the same promise `hoverTarget` makes
    // a held stroke (issue #25), asked of the tunnel instead of the column.
    // `hoverRay` is the ray the first intent of this stroke pinned; a pointer
    // move during the hold does not re-aim the tunnel, exactly as it does not
    // re-aim a held stamp.
    //
    // NO FOOT ANCHOR AND NO UNDERSIDE TEST, because both are questions about a
    // FACE and there is no pick here to have met one. The foot step-back
    // (issue #347) turns a riser press into the tread at its foot for a brush;
    // a carve names a band and a cell outright.
    // WHERE THIS INTENT ACTS AND WHICH BAND IT NAMES — the two things the
    // branches below disagree about, and the only two. One `send` after them,
    // so a tunnelling repeat and a first press cannot describe themselves
    // differently on the wire.
    let anchor: { x: number; y: number };
    let spanBand: number | null;

    if (strokeTool === 'carve' && strokeCarveBand !== null) {
      if (hoverRay === null) return;
      const reach = carveReach(hoverRay.origin, hoverRay.direction, strokeCarveBand);
      // THE TUNNEL HAS BROKEN THROUGH — nothing left at this band along this
      // aim. Emitting anyway would spend a seq and a mana charge on a cut the
      // shared math has nothing to apply, which is the same waste the Drag's
      // "nothing in its grasp" guard above exists to stop.
      if (reach === null) return;
      anchor = reach;
      spanBand = strokeCarveBand;
    } else {
      const cell = hoverTarget();
      if (cell === null) return;
      // AN UNDERSIDE HIT REFUSES A RAISE (plan D4). A horizontal face BELOW the
      // span's own cap is the roof of a cave seen from underneath, and there is
      // no gesture in this game that means "add material to the bottom of a
      // roof" — so the stroke is not emitted at all rather than being sent and
      // silently reinterpreted as thickening the roof upward.
      //
      // REFUSED HERE, IN THE CLIENT, because this is where the fact lives: which
      // FACE a ray met is a property of that ray and of the camera, not of the
      // world, so the server cannot re-derive it and the intent deliberately does
      // not carry it (it would be an unverifiable claim on the wire). Lowering an
      // underside is a carve, and belongs to the carve tool (D6).
      const underside = !cell.hitRiser && cell.hitY < cell.surfaceY;
      if (underside && sculptDirection(action) > 0) return;
      // WHICH SPAN THIS STROKE HAS HOLD OF, omitted entirely on an ordinary
      // column so an unlayered world's intents are byte-identical to before the
      // field existed (World.graspSpanBand returns null there).
      //
      // THE CARVE IS THE ONE TOOL THAT ALWAYS NAMES A BAND, ordinary column or
      // not: the band is not a refinement of where it acts, it IS where it acts,
      // and a carve that named none would be a no-op in the shared math. So it
      // asks `carveBand`, the same derivation without the one-span shortcut —
      // and it is only ever this tool that does, which is what leaves every
      // other stroke over unlayered ground byte-identical.
      spanBand = strokeTool === 'carve' ? carveBand(cell) : graspSpanBand(cell);
      // A CARVE WITH NO BAND CUTS NOTHING, so it emits nothing — the same rule,
      // and the same reason, as the Drag's "nothing in its grasp" guard above
      // (GH #349). A tread far from any lip resolves to no band (D1, owner
      // 2026-09-04), and this used to put a band-less carve on the wire anyway:
      // the shared math no-ops it, but `sculptDisplacementUnits` prices a carve
      // from its RADIUS ALONE and deliberately never reads the terrain
      // (shared/src/heightmap.ts), so the mana came off for a cut that could not
      // happen. The press is dead either way; now it is also free.
      //
      // AND IT IS WHAT FREEZES THE BAND FOR THE REST OF THE PRESS. Reached only
      // by the first cut of a carve stroke, because every repeat after it takes
      // the tunnelling branch above.
      if (strokeTool === 'carve') {
        if (spanBand === null) return;
        strokeCarveBand = spanBand;
      }
      // A BRUSH PRESS ON A RISER MEANS THE TREAD AT ITS FOOT (issue #347). The
      // ray is the pinned one `hoverTarget` just re-derived this pick from, so
      // the step-back is taken along the aim the player actually has.
      const foot =
        hoverRay !== null && TOOLS_WITH_FOOT_ANCHOR.includes(strokeTool)
          ? footOfFaceCell(cell, hoverRay.direction, worldSize())
          : null;
      // Nothing the world→cell rule can answer: keep the cell the pick named,
      // which is what every tool sent before this existed.
      anchor = foot ?? { x: cell.x, y: cell.y };
    }
    // The EDGE is read (not captured) per intent, so switching that toggle
    // mid-stroke takes effect on the very next repeat. The TOOL is not: it is
    // the press's own decision, frozen with the grasp it implies — see
    // `strokeTool` for the two ways reading it live broke a stroke in flight.
    send({
      type: 'sculpt',
      x: anchor.x,
      y: anchor.y,
      radius: brushRadius(),
      dir: sculptDirection(action),
      tool: strokeTool,
      // NO EDGE FOR A TOOL THAT HAS NONE — the carve, here, for exactly the
      // reason the drag names none in `emitDrag`: `sculptOptionsOf` resolves
      // every TOOLS_WITHOUT_EDGE_PROFILE tool to EDGELESS_SCULPT_PROFILE, so a
      // profile sent with one describes nothing that will happen. The stamp
      // and the smooth do have an edge and send the live toggle.
      ...(TOOLS_WITHOUT_EDGE_PROFILE.includes(strokeTool)
        ? {}
        : { profile: brushProfile() }),
      ...(spanBand !== null ? { spanBand } : {}),
      seq: nextSeq++,
    });
  };

  /**
   * THE DRAG EMISSION — one self-contained intent describing the disc under
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
   *
   * THE INTENT NAMES A SEGMENT, NOT A POINT (owner report, 2026-09-05: "quick
   * flicks on a small brush size are not recorded and leave gaps"). Pointer
   * events sample the cursor once per frame; a flick crosses several cells
   * between two samples, and a small disc at each sample left ground between
   * them untouched — or, landing clear of the band, filled nothing. So the
   * intent carries the cell the previous one named (`fromX/fromY`) and the
   * shared math sweeps the footprint along the line between the two. Still one
   * message per pointermove, so the rate the prediction store and the server's
   * limiter are sized for is unchanged — EXCEPT that a segment longer than
   * MAX_DRAG_SWEEP_CELLS is split into legs of at most that length, one intent
   * each, because the server bounds the ground one message may walk.
   */
  const emitDrag = (toX: number, toY: number, action: SculptAction, band: number): void => {
    const dir = sculptDirection(action);
    const radius = brushRadius();
    if (
      haveDragTo &&
      toX === lastDragToX &&
      toY === lastDragToY &&
      dir === lastDragDir &&
      radius === lastDragRadius
    ) {
      return;
    }
    if (!haveDragTo || (lastDragToX === toX && lastDragToY === toY)) {
      emitDragLeg(toX, toY, dir, radius, band, null);
      return;
    }
    // Leg ends are the straight line sampled at equal fractions, rounded to
    // cells; consecutive legs share an end, so the sweep has no seam. Each leg
    // is sent from the last one that reached the wire (lastDragTo), so a
    // dropped leg is retried by the next pointermove rather than skipped.
    const fromX = lastDragToX;
    const fromY = lastDragToY;
    const legs = Math.ceil(chebyshevDistance(fromX, fromY, toX, toY) / MAX_DRAG_SWEEP_CELLS);
    for (let leg = 1; leg <= legs; leg++) {
      const legX = fromX + Math.round(((toX - fromX) * leg) / legs);
      const legY = fromY + Math.round(((toY - fromY) * leg) / legs);
      if (!emitDragLeg(legX, legY, dir, radius, band, { x: lastDragToX, y: lastDragToY })) return;
    }
  };

  /** One drag intent on the wire; true if it reached it. See emitDrag. */
  const emitDragLeg = (
    toX: number,
    toY: number,
    dir: 1 | -1,
    radius: number,
    band: number,
    from: { x: number; y: number } | null,
  ): boolean => {
    const sent = send({
      type: 'sculpt',
      // THE CURSOR CELL, which for this tool is where the edit happens — the
      // same meaning x/y carry for every brush. The cell the lip was first
      // grabbed at does not appear in the intent at all: a drag is wherever
      // the hand is now, not a measurement from where it started, which is
      // what lets the lip turn and curve instead of advancing as one straight
      // front (owner report, 2026-08-24).
      x: toX,
      y: toY,
      radius,
      dir,
      tool: 'drag',
      // NO `profile`, because a drag has no edge to choose (issue #225). It
      // used to send the Edge toggle live, on the reading that soft advanced
      // the lip as a smooth face and hard filled every legal cell of the disc;
      // `sculptOptionsOf` resolves every tool in TOOLS_WITHOUT_EDGE_PROFILE to
      // EDGELESS_SCULPT_PROFILE, so what went out was overwritten on both
      // sides of the prediction contract before it reached any arithmetic. A
      // field whose value cannot change the stroke does not belong on the
      // wire: leaving it out is what stops the next reader believing the
      // toggle reshapes a drag. The HUD hides the Edge row for these tools for
      // the same reason.
      targetBand: band,
      // NO `spanBand` HERE YET, and that is a decision rather than an
      // oversight. A drag's x/y is the CURSOR cell, not the cell whose lip is
      // in the player's grasp, so a grasp derived here would name a span of the
      // wrong column — and the shared math's whole-stroke guard would then
      // no-op legitimate drags over layered ground. The drag's grasp travels as
      // `targetBand` plus the per-cell neighbour rule inside applyDragRegion,
      // which is where the span-aware form belongs (plan step 4.5, D5).
      //
      // SETTLED 2026-08-27 (issue #224), and the answer is that there is
      // nothing to add here. The span-aware drag now lives entirely in the
      // shared math's per-cell rule (`bandFillAt`, columns.ts): a drag over a
      // gap under a roof extends the roof as an OVERHANG instead of raising
      // the floor into it. One column covers a band with at most one span, so
      // `targetBand` plus the receiver's own map names the grasped span
      // exactly — a `spanBand` here would be the same number twice, derived
      // from the wrong cell.
      ...(from !== null ? { fromX: from.x, fromY: from.y } : {}),
      seq: nextSeq++,
    });
    // A dropped intent leaves lastDragTo alone, so the very next pointermove
    // — even one inside the same cell — retries the identical sweep.
    if (!sent) return false;
    lastDragToX = toX;
    lastDragToY = toY;
    lastDragDir = dir;
    lastDragRadius = radius;
    haveDragTo = true;
    return true;
  };

  /**
   * ENDS THE STROKE — and RELEASES THE AIMED-CELL PIN with it (GH #349).
   *
   * THE PIN IS A PROMISE ABOUT A STROKE IN FLIGHT, and it used to outlive one.
   * `hoverTarget` keys its cache on the pointer and the camera alone, so with
   * the mouse still after a cut the key was unchanged and the next hover — and
   * the next CLICK — went on being answered for the cell the last press aimed
   * at. Issue #25 asks that a HELD stamp not march into the mound it is
   * raising, and #324 that no map-derived field survive an edit; neither says
   * anything about the press being over. Between presses the honest answer is
   * a fresh march, and this is what makes the next read take one.
   *
   * The owner's report, 2026-09-05: after a carve the crosshair sat about 30 px
   * BELOW the mouse and a second click did nothing. Both were this — the
   * pinned ray now passed through the opening, and `pickTerrainInColumn`'s
   * ground-under-the-ray answer reports the floor at the MIDPOINT of the ray's
   * chord across the cell, a point that is not on the ray at all. Measured
   * over camera pitches 20° to 70°, every hit an honest march returns lies
   * exactly on the ray (`.agent-stack/carve-verify/probe/clickChain.txt`, offRay=0.00000c).
   *
   * CLEARING THE KEY IS THE RELEASE. The pointer has not moved, so the key the
   * next read computes is the same string it was; only an unmatchable key
   * forces the re-march. The cell and ray go with it rather than being left to
   * be re-pinned by the next read, so there is no window in which they belong
   * to a stroke that has ended.
   */
  const stopRepeat = (): void => {
    strokeButton = null;
    strokePointerId = null;
    strokeIsTouch = false;
    strokeGrab = null;
    strokeCarveBand = null;
    strokeArmed = false;
    haveDragTo = false;
    hoverKey = '';
    hoverCell = null;
    hoverRay = null;
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
   * IS A STROKE STILL IN FLIGHT? Every field `stopRepeat` clears would answer,
   * and the pointer id is the one that is set for a stroke of either input
   * kind and at every stage of it — before arming (a touch stroke waiting out
   * its grace delay) as well as after.
   *
   * Asked after each `emitIntent`, because `send` can end the stroke UNDER the
   * caller: a client-plugin veto releases it (see `releaseStroke`), and the
   * callers below would otherwise go on to arm, or to schedule the next
   * repeat of, a stroke that is over.
   */
  const strokeIsLive = (): boolean => strokePointerId !== null;

  /**
   * The pointer whose stroke a client plugin refused, while its button is
   * STILL DOWN — null the rest of the time. See `refusedHold`.
   *
   * The id and not a boolean: the release that clears it has to be THIS
   * pointer's, or a second finger lifting, or the tail of an unrelated pointer
   * still being tracked on the window, would put the brush back to white while
   * the refused button was still held.
   */
  let refusedPointerId: number | null = null;

  /**
   * Ends the stroke on a client-plugin veto and REMEMBERS that its button is
   * still down. Everything `stopRepeat` does, plus the one fact stopping does
   * not carry: the player has not let go, so the refusal is still on screen.
   */
  const releaseRefusedStroke = (): void => {
    // Read before stopRepeat clears it. Null when nothing was live (a veto can
    // only come from an intent, and every intent belongs to a stroke, so this
    // is defence rather than an expected case).
    const refused = strokePointerId;
    stopRepeat();
    refusedPointerId = refused;
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
      if (!strokeIsLive()) return;
      scheduleRepeat(repeatIndex + 1);
    }, repeatDelayMs(repeatIndex));
  };

  /** First intent now, then the accelerating hold-repeat. Each repeat reads the
   * shared hover pick rather than reusing the pressed cell, so a DRAG still
   * re-targets wherever the cursor is now — but a stationary hold keeps its
   * cell even as the terrain rises (see emitIntent's issue-#25 comment). */
  const armStroke = (): void => {
    // A TOUCH STROKE TAKES HOLD HERE, NOT AT POINTERDOWN. The grab is a
    // function of the ray, and with no hover to fall back on and no search
    // radius to forgive a miss, the only ray worth firing is the one from where
    // the finger has SETTLED: first contact is measured before the finger has
    // stopped moving, and the stroke does not arm until TOUCH_STROKE_GRACE_MS
    // has passed anyway. A mouse press has already taken hold in startStroke,
    // where the pointer is exactly where the player put it.
    if (strokeIsTouch) takeHold(currentStrokeAction());
    // The seed a Drag press makes is itself an intent (takeHold → seedLayer),
    // so it can be the one that is refused — here for a touch stroke, back in
    // `startStroke` for a mouse one. Either way the stroke is already over and
    // arming it would emit the very intent that was just refused.
    if (!strokeIsLive()) return;
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
    // THE DRAG NEVER REPEATS, whether it grabbed a lip or seeded a new layer.
    // A held stamp stacking bands in one place is the whole thing a stamp
    // does; standing still with the Drag tool means the lip is already where
    // the player put it, and a seeded layer is "a single layer" by the owner's
    // instruction — a repeat would turn either into a tower.
    if (strokeTool === 'drag') return;
    // The first intent was refused, so there is no stroke left to repeat.
    if (!strokeIsLive()) return;
    scheduleRepeat(0);
  };

  /**
   * MOVES ONE LAYER IN THE STROKE'S DIRECTION where there is no lip to take
   * hold of (owner, 2026-08-24: "if there is no edge to drag, pop up a new
   * layer that we can start dragging — just a single layer"; and 2026-09-05:
   * shift-drag must work on a plateau, so the lower chord digs a one-band pit
   * to drag wider instead of emitting nothing).
   *
   * A `hard` stamp, which level-fills its footprint to the next band, so what
   * appears is a flat one-band plateau (or pit) with a clean lip all the way
   * round — the thing the drag needs in order to have anything to grab. `hard`
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
  const seedLayer = (cell: { x: number; y: number }, action: SculptAction): boolean =>
    send({
      type: 'sculpt',
      x: cell.x,
      y: cell.y,
      radius: brushRadius(),
      dir: sculptDirection(action),
      tool: 'stamp',
      profile: 'hard',
      seq: nextSeq++,
    });

  /**
   * DECIDES WHAT THIS STROKE HAS HOLD OF, once, and freezes it in `strokeGrab`.
   *
   * THE DRAG IS A TOOL YOU SELECT, not a mode a press falls into (owner
   * decision 2026-08-24): Stamp and Smooth always brush, so they hold nothing.
   *
   * With the Drag tool the answer is the face under the pointer and nothing
   * else — a riser is grabbed at the band whose slab the ray struck, a tread
   * seeds (below), and anything else holds nothing. BOTH DIRECTIONS grab the
   * same lip (issue #99 step 3): the lower chord drags it INWARD, and the stop
   * rule that needs lives in the shared math (applyDragRegion/retreatHeightAt).
   */
  const takeHold = (action: SculptAction): void => {
    strokeGrab = null;
    if (strokeTool !== 'drag') return;
    const hover = hoverTarget();
    strokeGrab = riserBand(hover);
    if (strokeGrab !== null) return;
    // SEEDING RESCUES BOTH DIRECTIONS (owner report, 2026-09-05: "shift drag
    // does not work on plateaus"). Raise-only, a lower press on a plateau's
    // interior emitted nothing, while a plain press seeded a layer — so the
    // lower chord now digs the mirror: a one-band pit whose rim is a lip.
    // ON THE TREAD, and only there. `riserBand` is null on a cave roof's
    // UNDERSIDE too, and seeding one would add material to the bottom of a
    // roof — the very thing emitIntent refuses (plan D4). A horizontal face at
    // the span's own cap is the tread; below it, the underside.
    if (hover === null || hover.hitRiser || hover.hitY !== hover.surfaceY) return;
    // NOTHING TO DRAG, SO MAKE SOMETHING (owner, 2026-08-24). The seed is
    // applied locally by the prediction the moment it is sent (main.tsx's
    // send), so the band under the pointer moves within this call.
    //
    // THE NEW LIP IS READ FROM THE MAP AS A CHANGE, not re-picked — and it
    // stays that way now that `hoverTarget` DOES re-evaluate (2026-09-04). A
    // second `riserBand(hoverTarget())` after the seed would be a fresh and
    // honest pick, but it is not the question being asked: the ray is pinned,
    // so whether the raised ground now meets it on a face is geometry, not
    // proof that this press raised anything. An absolute read is not safe
    // either — `send` returns true for intents that predict nothing, so the
    // band under the pointer could be one this press did not raise. A delta
    // is.
    //
    // THE RISE IS THE PROOF (main, 2026-08-27). `seedLayer` reports that the
    // intent reached the wire, not that it was predicted: a stroke at the
    // frontier is sent but deliberately not predicted (terrain/prediction.ts's
    // halo guard), and the ground under the cursor is then unchanged. Grabbing
    // the band that was already there would take hold of a lip the player did
    // not make, so a seed that did not visibly raise anything grabs nothing.
    // Read from the mirror, not the overlay: the overlay is a reader of what
    // the terrain PUBLISHES, a frame or two later under the build budget.
    //
    // THE GRAB IS THE LIP'S CAP BAND, whichever way the seed went. A raised
    // layer's lip is capped at the NEW band, so a raise drag extends it. A pit's
    // lip is the surrounding plateau, capped at the OLD band, so a lower drag
    // grabbing it retreats that band into the pit (retreatHeightAt finds the
    // pit floor beside each rim cell) — the pit widens as the cursor sweeps.
    const before = bandAtCell(hover.x, hover.y);
    if (!seedLayer(hover, action)) return;
    const after = bandAtCell(hover.x, hover.y);
    if (before === null || after === null) return;
    if (action === 'raise') {
      if (after <= before) return;
      strokeGrab = after;
    } else {
      if (after >= before) return;
      strokeGrab = before;
    }
  };

  const startStroke = (event: PointerEvent, action: SculptAction): void => {
    // Abandon any stroke still in flight (e.g. a missed pointerup) before
    // starting this one, so at most one repeat timer can ever exist.
    stopRepeat();
    // A NEW PRESS IS THE INTENTIONAL RE-CLICK the refusal was waiting for
    // (owner, 2026-09-06), so the red goes with it — even if the pointerup for
    // the refused button was never delivered here.
    refusedPointerId = null;

    strokeButton = event.button;
    strokePointerId = event.pointerId;
    strokeIsTouch = event.pointerType === 'touch';
    // Before takeHold below, which asks the HUD's tool what a press even means
    // here, and before any intent this stroke emits — and now before the
    // action too, because the tool can decide it.
    strokeTool = brushTool();
    // A DIRECTION-LESS TOOL'S STROKE IS ITS OWN DIRECTION, not the modifier's
    // and not the sticky mode's (owner report, 2026-09-02: "because there is
    // no raise mode, only a lower... that should be the default mode, and
    // holding shift should not be required"). The carve removes; an unmodified
    // click carves, a shift-click carves the same, and touch carves without
    // first tapping Mode. The modifier is not overridden so much as IRRELEVANT
    // — the tool has one direction, so there is nothing for a chord to select.
    //
    // AND THE STICKY MODE IS LEFT ALONE for the reason emitIntent gives: it is
    // persisted and shared with the tools that do have a direction.
    if (TOOLS_WITHOUT_DIRECTION.includes(strokeTool)) {
      strokeAction = 'lower';
    } else {
      strokeAction = action;
      setSculptMode(action);
    }
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    havePointer = true;
    // GRAB, OR BRUSH — decided here, once, after the pointer position is
    // recorded, because the face query has to run against the ray THIS press
    // fires. A touch press defers it to armStroke instead: see there.
    //
    // `strokeAction`, NOT the resolved `action`: the tool may just have
    // decided the direction itself, and takeHold's seeding rescue must see
    // the direction this stroke will actually sculpt in.
    if (!strokeIsTouch) takeHold(strokeAction);

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
    // NOT WHILE A DIRECTION-LESS TOOL IS SELECTED. The Mode row is not on
    // screen then (Hud.tsx), so this would be a hidden control writing a
    // PERSISTED setting: tap shift with Carve up, switch to Stamp, and the
    // stamp digs. The indicator can only stay honest for a tool that has a
    // direction to indicate.
    if (TOOLS_WITHOUT_DIRECTION.includes(brushTool())) return;
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
    // THE RELEASE THE REFUSAL WAS WAITING FOR — cleared before the stroke test
    // below, which a refused pointer no longer passes: `releaseRefusedStroke`
    // has already dropped `strokePointerId`.
    if (event.pointerId === refusedPointerId) refusedPointerId = null;
    if (event.pointerId !== strokePointerId) return;
    // A tap quicker than the grace delay ended before the stroke armed. It is
    // unambiguous now — no second finger arrived in its whole lifetime — so
    // it earns its single intent here; otherwise fast taps would do nothing.
    //
    // IT TAKES HOLD FIRST, exactly as `armStroke` would have. A touch press
    // defers the grasp to arming (the ray is only worth firing once the finger
    // has settled), so a tap that never armed had never grasped anything —
    // and with the Drag tool `emitIntent` then refused it as "a Drag with
    // nothing in its grasp", which is the one tool for which fast taps still
    // did nothing. The grace timer is a touch-stroke timer and nothing else,
    // so this branch is exactly the arming that did not happen.
    if (graceTimer !== null) {
      takeHold(currentStrokeAction());
      emitIntent();
    }
    stopRepeat();
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') activeTouchIds.delete(event.pointerId);
    if (event.pointerId === refusedPointerId) refusedPointerId = null;
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
    // No pointerup will arrive for a button released while another window had
    // focus, so a refusal held across the blur would leave the brush red for
    // the rest of the session.
    refusedPointerId = null;
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
    heldBand: (): number | null => strokeGrab,
    releaseStroke: releaseRefusedStroke,
    refusedHold: (): boolean => refusedPointerId !== null,
    dispose(): void {
      refusedPointerId = null;
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
