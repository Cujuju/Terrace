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

const TOOLS_WITH_FOOT_ANCHOR: readonly SculptTool[] = ['stamp', 'smooth'];

/**
 * The four sculpt-brush cue states the input path reports for lane E to render.
 * Lane C owns the transitions; lane E owns the pixels.
 *
 * - `refused` — the server (or a local plugin) refused the stroke. Red brush.
 *   Pulsed by releaseStroke(); read via refusedHold().
 * - `offline` — send() returned 'offline': the room is gone, so the intent never
 *   left. Grey/hollow brush, never red. Latched for the stroke; read via
 *   offlineHold().
 * - `ghost` — the stroke grabbed a band but the prediction was a no-op (held
 *   drag into unknown or already-settled ground). Tracked by the prediction
 *   store (ghostSeqs), not here: the intent WAS sent, so the brush must not
 *   read as unsent-held.
 * - `flat` — a posture refusal: the aim geometry cannot take this tool
 *   (underside raise, carve with no span, seed that moves nothing, the drag
 *   plane leaving the held band). Flat-mark; read via flatBlinks() and
 *   dragDescentFrozen().
 */
export type SculptCue = 'refused' | 'offline' | 'ghost' | 'flat';

/**
 * What the host did with an intent. 'sent' reached the room (predict it);
 * 'refused' died to a local plugin veto whose red pulse the host already latched
 * via releaseStroke(), so the input must not blink grey for it; 'offline' never
 * left (grey/hollow cue here, never red).
 */
export type SendOutcome = 'sent' | 'refused' | 'offline';

/**
 * Consecutive silent repeat ticks before the held button blinks the flat cue
 * once. Press-time failures blink immediately instead of counting here.
 */
export const SILENT_REPEAT_BLINK_AFTER = 3;

/** Red for this long when no button is left to hold it: a server nack lands after the click. */
export const REFUSED_PULSE_MS = 400;

export interface SculptInputOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  pickCell: (origin: Vec3, direction: Vec3) => TerrainRayPick | null;
  pickInColumn: (
    x: number,
    y: number,
    origin: Vec3,
    direction: Vec3,
  ) => TerrainRayPick | null;
  worldSize: () => number;
  riserBand: (pick: TerrainRayPick | null) => number | null;
  bandAtCell: (x: number, y: number, spanBand: number | null) => number | null;
  graspSpanBand: (pick: TerrainRayPick | null) => number | null;
  carveBand: (pick: TerrainRayPick | null) => number | null;
  carveReach: (
    origin: Vec3,
    direction: Vec3,
    band: number,
  ) => { x: number; y: number } | null;
  send: (intent: SculptIntent) => SendOutcome;
}

export interface SculptInput {
  hoverTarget(): TerrainRayPick | null;
  heldBand(): number | null;
  carveHeldBand(): number | null;
  releaseStroke(): void;
  refusedHold(): boolean;
  /** Grey/hollow brush: send() returned 'offline' during this stroke. Never red. */
  offlineHold(): boolean;
  /** The drag plane left the held band: freeze the stroke, grey the highlight. */
  dragDescentFrozen(): boolean;
  /** Press-time offline failures plus one blink per dropped sweep, transition-only. */
  offlineBlinks(): number;
  /** Press-time posture failures plus one blink per silent repeat streak. */
  flatBlinks(): number;
  /** Hits on the dead directionless-raise guard: logged, never cued. */
  deadGuardHits(): number;
  dispose(): void;
}

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

  let pointerClientX = 0;
  let pointerClientY = 0;
  let havePointer = false;

  let mods: ModifierState = { shiftKey: false, ctrlKey: false, altKey: false };

  let strokeButton: number | null = null;
  let strokePointerId: number | null = null;
  let strokeIsTouch = false;
  let strokeAction: SculptAction = 'raise';

  let strokeTool: SculptTool = DEFAULT_BRUSH_TOOL;

  let strokeGrab: number | null = null;

  let strokeCarveBand: number | null = null;

  let strokeArmed = false;

  let lastDragToX = 0;
  let lastDragToY = 0;
  let lastDragDir: 1 | -1 = 1;
  let lastDragRadius = 0;
  let haveDragTo = false;

  const activeTouchIds = new Set<number>();

  let repeatTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  interface PointerRay {
    readonly origin: Vec3;
    readonly direction: Vec3;
  }

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

  let hoverKey = '';
  let hoverCell: { x: number; y: number } | null = null;
  let hoverRay: PointerRay | null = null;
  const MIN_DRAG_PLANE_DESCENT = 0.05;

  const dragPlaneCell = (band: number): { x: number; y: number } | null => {
    const size = worldSize();
    const ray = pointerRay();
    if (size <= 0 || ray === null) return null;
    const { origin, direction } = ray;
    const planeY = band * BAND_HEIGHT * HEIGHT_WORLD_SCALE;
    if (direction.y > -MIN_DRAG_PLANE_DESCENT) return null;
    const distance = (planeY - origin.y) / direction.y;
    if (!Number.isFinite(distance) || distance <= 0) return null;

    const worldX = origin.x + direction.x * distance;
    const worldZ = origin.z + direction.z * distance;
    return worldPointToCell(worldX, worldZ, size);
  };

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
    if (pick === null) return repick();
    return pick;
  };

  const currentStrokeAction = (): SculptAction => {
    if (strokeButton !== null && !strokeIsTouch && !TOOLS_WITHOUT_DIRECTION.includes(strokeTool)) {
      const resolved = resolvePress(strokeButton, mods);
      if (resolved === 'raise' || resolved === 'lower') {
        strokeAction = resolved;
      }
    }
    return strokeAction;
  };

  let nextSeq = 1;

  // Cue bookkeeping for the four SculptCue states. Blinks are counters, not
  // timers: lane E renders the flash, and tests assert the budget exactly.
  let offlineLatched = false;
  let offlineBlinkCount = 0;
  let flatBlinkCount = 0;
  let silentRepeatTicks = 0;
  let repeatStreakBlinked = false;
  let descentFrozen = false;
  let deadDirectionlessRaiseHits = 0;

  type EmitOrigin = 'press' | 'repeat' | 'move';
  type EmitOutcome = 'sent' | 'flat-silent' | 'absent-silent' | 'unsent';

  /** A send() returned false: latch the offline (grey/hollow, never red) cue, blinking once per latch. */
  const markUnsent = (): void => {
    if (offlineLatched) return;
    offlineLatched = true;
    offlineBlinkCount++;
  };

  const noteSent = (): void => {
    silentRepeatTicks = 0;
    repeatStreakBlinked = false;
  };

  /**
   * A posture refusal that sent nothing. Press-time failures blink once; repeat
   * ticks count toward one blink per SILENT_REPEAT_BLINK_AFTER streak; pointer
   * moves stay silent (the descent-frozen flag is their cue).
   */
  const noteFlatSilent = (origin: EmitOrigin): EmitOutcome => {
    if (origin === 'press') flatBlinkCount++;
    else if (origin === 'repeat') {
      silentRepeatTicks++;
      if (silentRepeatTicks >= SILENT_REPEAT_BLINK_AFTER && !repeatStreakBlinked) {
        repeatStreakBlinked = true;
        silentRepeatTicks = 0;
        flatBlinkCount++;
      }
    }
    return 'flat-silent';
  };

  /** Raising with a directionless tool (carve): dead by construction, counted, never cued. */
  const isDirectionlessRaise = (action: SculptAction): boolean =>
    TOOLS_WITHOUT_DIRECTION.includes(strokeTool) && sculptDirection(action) > 0;

  /** Raising into an underside face: a posture refusal, cues flat. */
  const isUndersideRaise = (cell: TerrainRayPick, action: SculptAction): boolean =>
    cell.face === 'underside' && sculptDirection(action) > 0;

  /** Carving with no span under the aim: a posture refusal, cues flat. */
  const isCarveWithoutSpan = (spanBand: number | null): boolean =>
    strokeTool === 'carve' && spanBand === null;

  const emitIntent = (origin: EmitOrigin): EmitOutcome => {
    const action = currentStrokeAction();
    if (!TOOLS_WITHOUT_DIRECTION.includes(strokeTool)) setSculptMode(action);
    // No grab, no stroke: the takeHold seed already cued any failure, so this stays silent.
    if (strokeTool === 'drag' && strokeGrab === null) return 'absent-silent';
    // Dead by construction — startStroke/currentStrokeAction never arm a
    // directionless tool with raise. Counted for the log, never cued, no behavior change.
    if (isDirectionlessRaise(action)) {
      deadDirectionlessRaiseHits++;
      console.debug('[terrace] sculpt: directionless-raise guard hit (dead by construction)');
      return 'absent-silent';
    }
    if (strokeGrab !== null) {
      const to = dragPlaneCell(strokeGrab);
      if (to === null) {
        // Descent gate: the held band's plane left the ray (aimed too shallow), so
        // freeze the stroke and mark it for the flat-mark crosshair. Cue-only: the
        // MIN_DRAG_PLANE_DESCENT pitch threshold keeps the settled 08-21 low-pitch
        // accuracy exactly as it was.
        descentFrozen = true;
        return noteFlatSilent(origin);
      }
      descentFrozen = false;
      return emitDragOutcome(to.x, to.y, action, strokeGrab);
    }
    descentFrozen = false;
    let anchor: { x: number; y: number };
    let spanBand: number | null;

    if (strokeTool === 'carve' && strokeCarveBand !== null) {
      // No aim yet, or the tunnel broke through: no-target frames stay silent.
      if (hoverRay === null) return 'absent-silent';
      const reach = carveReach(hoverRay.origin, hoverRay.direction, strokeCarveBand);
      if (reach === null) return 'absent-silent';
      anchor = reach;
      spanBand = strokeCarveBand;
    } else {
      const cell = hoverTarget();
      // No-target frame stays silent.
      if (cell === null) return 'absent-silent';
      if (isUndersideRaise(cell, action)) return noteFlatSilent(origin);
      spanBand = strokeTool === 'carve' ? carveBand(cell) : graspSpanBand(cell);
      if (strokeTool === 'carve') {
        if (isCarveWithoutSpan(spanBand)) return noteFlatSilent(origin);
        strokeCarveBand = spanBand;
      }
      const foot =
        hoverRay !== null && TOOLS_WITH_FOOT_ANCHOR.includes(strokeTool)
          ? footOfFaceCell(cell, hoverRay.direction, worldSize())
          : null;
      anchor = foot ?? { x: cell.x, y: cell.y };
    }
    // Every emit path honors the send() outcome like emitDragLeg does: 'offline'
    // is the connection-down cue (grey/hollow, never red), 'refused' is a local
    // plugin veto whose red pulse is already latched, and the intent must not
    // be predicted in either case.
    const outcome = send({
        type: 'sculpt',
        x: anchor.x,
        y: anchor.y,
        radius: brushRadius(),
        dir: sculptDirection(action),
        tool: strokeTool,
        ...(TOOLS_WITHOUT_EDGE_PROFILE.includes(strokeTool)
          ? {}
          : { profile: brushProfile() }),
        ...(spanBand !== null ? { spanBand } : {}),
        seq: nextSeq++,
      });
      if (outcome === 'offline') {
        markUnsent();
        return 'unsent';
      }
      // A local veto ends the emit without touching the grey latch.
      if (outcome === 'refused') return 'unsent';
      noteSent();
      return 'sent';
  };

  const emitDragOutcome = (
    toX: number,
    toY: number,
    action: SculptAction,
    band: number,
  ): EmitOutcome => {
    const dir = sculptDirection(action);
    const radius = brushRadius();
    if (
      haveDragTo &&
      toX === lastDragToX &&
      toY === lastDragToY &&
      dir === lastDragDir &&
      radius === lastDragRadius
    ) {
      return 'absent-silent';
    }
    if (!haveDragTo || (lastDragToX === toX && lastDragToY === toY)) {
      const firstLeg = emitDragLeg(toX, toY, dir, radius, band, null);
      if (firstLeg !== 'sent') {
        // A dropped first leg is one offline blink for the whole sweep; a local
        // veto is already red and never blinks grey.
        if (firstLeg === 'offline') markUnsent();
        return 'unsent';
      }
      noteSent();
      return 'sent';
    }
    const fromX = lastDragToX;
    const fromY = lastDragToY;
    const legs = Math.ceil(chebyshevDistance(fromX, fromY, toX, toY) / MAX_DRAG_SWEEP_CELLS);
    let sentAny = false;
    for (let leg = 1; leg <= legs; leg++) {
      const legX = fromX + Math.round(((toX - fromX) * leg) / legs);
      const legY = fromY + Math.round(((toY - fromY) * leg) / legs);
      const legOutcome = emitDragLeg(legX, legY, dir, radius, band, { x: lastDragToX, y: lastDragToY });
      if (legOutcome !== 'sent') {
        // Sweep truncation: the tail legs are dropped (emitDragLeg leaves the last
        // sent leg current), with one offline blink for the whole sweep. A local
        // veto is already red and never blinks grey.
        if (legOutcome === 'offline') markUnsent();
        return sentAny ? 'sent' : 'unsent';
      }
      sentAny = true;
    }
    // The sweep can legally round to zero legs; that frame stays silent.
    if (!sentAny) return 'absent-silent';
    noteSent();
    return 'sent';
  };

  const emitDragLeg = (
    toX: number,
    toY: number,
    dir: 1 | -1,
    radius: number,
    band: number,
    from: { x: number; y: number } | null,
  ): SendOutcome => {
    const outcome = send({
      type: 'sculpt',
      x: toX,
      y: toY,
      radius,
      dir,
      tool: 'drag',
      targetBand: band,
      ...(from !== null ? { fromX: from.x, fromY: from.y } : {}),
      seq: nextSeq++,
    });
    if (outcome !== 'sent') return outcome;
    lastDragToX = toX;
    lastDragToY = toY;
    lastDragDir = dir;
    lastDragRadius = radius;
    haveDragTo = true;
    return 'sent';
  };

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
    offlineLatched = false;
    silentRepeatTicks = 0;
    repeatStreakBlinked = false;
    descentFrozen = false;
    if (repeatTimer !== null) {
      clearTimeout(repeatTimer);
      repeatTimer = null;
    }
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const strokeIsLive = (): boolean => strokePointerId !== null;

  let refusedPointerId: number | null = null;
  let refusedUntilMs = Number.NEGATIVE_INFINITY;

  const refusedIsShowing = (): boolean =>
    refusedPointerId !== null || performance.now() < refusedUntilMs;

  const clearRefused = (): void => {
    refusedPointerId = null;
    refusedUntilMs = Number.NEGATIVE_INFINITY;
  };

  const releaseRefusedStroke = (): void => {
    const refused = strokePointerId;
    stopRepeat();
    refusedPointerId = refused;
    // A nack that outlived its click has no button to hold the cue: pulse instead.
    if (refused === null) refusedUntilMs = performance.now() + REFUSED_PULSE_MS;
  };

  const scheduleRepeat = (repeatIndex: number): void => {
    repeatTimer = setTimeout(() => {
      repeatTimer = null;
      const outcome = emitIntent('repeat');
      if (!strokeIsLive()) return;
      // Gate the repeat on the connection: while offline the held button holds its
      // cue instead of spamming intents the room will never see.
      if (outcome === 'unsent') return;
      scheduleRepeat(repeatIndex + 1);
    }, repeatDelayMs(repeatIndex));
  };

  const armStroke = (): void => {
    if (strokeIsTouch) takeHold(currentStrokeAction());
    if (!strokeIsLive()) return;
    strokeArmed = true;
    // A press-time send failure latches the offline cue and skips the repeat.
    if (emitIntent('press') === 'unsent') return;
    if (strokeTool === 'drag') return;
    if (!strokeIsLive()) return;
    scheduleRepeat(0);
  };

  const seedLayer = (
    cell: { x: number; y: number },
    action: SculptAction,
    spanBand: number | null,
  ): SendOutcome =>
    send({
      type: 'sculpt',
      x: cell.x,
      y: cell.y,
      radius: brushRadius(),
      dir: sculptDirection(action),
      tool: 'stamp',
      profile: 'hard',
      ...(spanBand !== null ? { spanBand } : {}),
      seq: nextSeq++,
    });

  /**
   * The seed-band reading takeHold compares before/after the seed intent. A null
   * spanBand reads the column top; a banded one reads that layer; null is the
   * unknown column (open air or a chunk never received) and aborts the grab.
   */
  type SeedBandReading =
    | { readonly kind: 'top'; readonly band: number }
    | { readonly kind: 'layer'; readonly band: number };

  const readSeedBand = (
    x: number,
    y: number,
    spanBand: number | null,
  ): SeedBandReading | null => {
    const band = bandAtCell(x, y, spanBand);
    if (band === null) return null;
    return spanBand === null ? { kind: 'top', band } : { kind: 'layer', band };
  };

  const takeHold = (action: SculptAction): void => {
    strokeGrab = null;
    if (strokeTool !== 'drag') return;
    const hover = hoverTarget();
    strokeGrab = riserBand(hover);
    if (strokeGrab !== null) return;
    if (hover === null || hover.face !== 'tread') return;
    const spanBand = graspSpanBand(hover);
    const before = readSeedBand(hover.x, hover.y, spanBand);
    // A press-time seed failure latches offline and blinks once; a local veto
    // is already red and never blinks grey.
    const seeded = seedLayer(hover, action, spanBand);
    if (seeded === 'offline') {
      markUnsent();
      return;
    }
    if (seeded === 'refused') return;
    const after = readSeedBand(hover.x, hover.y, spanBand);
    if (before === null || after === null) return;
    if (action === 'raise') {
      // The seed raised nothing: blink the flat cue once.
      if (after.band <= before.band) {
        flatBlinkCount++;
        return;
      }
      strokeGrab = after.band;
    } else {
      // Lowers grab the pre-seed band: the seed lowers it away, so the drag plane rides the starting band.
      if (after.band >= before.band) {
        flatBlinkCount++;
        return;
      }
      strokeGrab = before.band;
    }
  };

  const startStroke = (event: PointerEvent, action: SculptAction): void => {
    stopRepeat();
    clearRefused();

    strokeButton = event.button;
    strokePointerId = event.pointerId;
    strokeIsTouch = event.pointerType === 'touch';
    strokeTool = brushTool();
    if (TOOLS_WITHOUT_DIRECTION.includes(strokeTool)) {
      strokeAction = 'lower';
    } else {
      strokeAction = action;
      setSculptMode(action);
    }
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    havePointer = true;
    if (!strokeIsTouch) takeHold(strokeAction);

    if (strokeIsTouch) {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        armStroke();
      }, TOUCH_STROKE_GRACE_MS);
      return;
    }

    armStroke();
  };

  const syncMode = (state: ModifierState): void => {
    mods = {
      shiftKey: state.shiftKey,
      ctrlKey: state.ctrlKey,
      altKey: state.altKey,
    };
    if (strokeButton !== null) return;
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
        stopRepeat();
        return;
      }
      startStroke(event, sculptMode());
      return;
    }

    syncMode(event);
    const action = resolvePress(event.button, event);
    if (action !== 'raise' && action !== 'lower') return;
    startStroke(event, action);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (strokePointerId === null || event.pointerId === strokePointerId) {
      pointerClientX = event.clientX;
      pointerClientY = event.clientY;
      havePointer = true;
      if (strokeArmed && strokeGrab !== null) emitIntent('move');
    }
    if (event.pointerType !== 'touch') syncMode(event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') activeTouchIds.delete(event.pointerId);
    if (event.pointerId === refusedPointerId) refusedPointerId = null;
    if (event.pointerId !== strokePointerId) return;
    if (graceTimer !== null) {
      takeHold(currentStrokeAction());
      emitIntent('press');
    }
    stopRepeat();
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') activeTouchIds.delete(event.pointerId);
    if (event.pointerId === refusedPointerId) refusedPointerId = null;
    if (event.pointerId === strokePointerId) stopRepeat();
  };

  const onContextMenu = (event: MouseEvent): void => event.preventDefault();

  const onKeyChange = (event: KeyboardEvent): void => syncMode(event);

  const onWindowBlur = (): void => {
    activeTouchIds.clear();
    clearRefused();
    stopRepeat();
  };

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
    carveHeldBand: (): number | null => strokeCarveBand,
    releaseStroke: releaseRefusedStroke,
    refusedHold: refusedIsShowing,
    offlineHold: (): boolean => offlineLatched,
    dragDescentFrozen: (): boolean => descentFrozen,
    offlineBlinks: (): number => offlineBlinkCount,
    flatBlinks: (): number => flatBlinkCount,
    deadGuardHits: (): number => deadDirectionlessRaiseHits,
    dispose(): void {
      clearRefused();
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
