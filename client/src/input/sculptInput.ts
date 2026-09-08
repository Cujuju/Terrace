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
  bandAtCell: (x: number, y: number) => number | null;
  graspSpanBand: (pick: TerrainRayPick | null) => number | null;
  carveBand: (pick: TerrainRayPick | null) => number | null;
  carveReach: (
    origin: Vec3,
    direction: Vec3,
    band: number,
  ) => { x: number; y: number } | null;
  send: (intent: SculptIntent) => boolean;
}

export interface SculptInput {
  hoverTarget(): TerrainRayPick | null;
  heldBand(): number | null;
  releaseStroke(): void;
  refusedHold(): boolean;
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

  const emitIntent = (): void => {
    const action = currentStrokeAction();
    if (!TOOLS_WITHOUT_DIRECTION.includes(strokeTool)) setSculptMode(action);
    if (strokeTool === 'drag' && strokeGrab === null) return;
    if (TOOLS_WITHOUT_DIRECTION.includes(strokeTool) && sculptDirection(action) > 0) return;
    if (strokeGrab !== null) {
      const to = dragPlaneCell(strokeGrab);
      if (to === null) return;
      emitDrag(to.x, to.y, action, strokeGrab);
      return;
    }
    let anchor: { x: number; y: number };
    let spanBand: number | null;

    if (strokeTool === 'carve' && strokeCarveBand !== null) {
      if (hoverRay === null) return;
      const reach = carveReach(hoverRay.origin, hoverRay.direction, strokeCarveBand);
      if (reach === null) return;
      anchor = reach;
      spanBand = strokeCarveBand;
    } else {
      const cell = hoverTarget();
      if (cell === null) return;
      const underside = !cell.hitRiser && cell.hitY < cell.surfaceY;
      if (underside && sculptDirection(action) > 0) return;
      spanBand = strokeTool === 'carve' ? carveBand(cell) : graspSpanBand(cell);
      if (strokeTool === 'carve') {
        if (spanBand === null) return;
        strokeCarveBand = spanBand;
      }
      const foot =
        hoverRay !== null && TOOLS_WITH_FOOT_ANCHOR.includes(strokeTool)
          ? footOfFaceCell(cell, hoverRay.direction, worldSize())
          : null;
      anchor = foot ?? { x: cell.x, y: cell.y };
    }
    send({
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
  };

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
    const fromX = lastDragToX;
    const fromY = lastDragToY;
    const legs = Math.ceil(chebyshevDistance(fromX, fromY, toX, toY) / MAX_DRAG_SWEEP_CELLS);
    for (let leg = 1; leg <= legs; leg++) {
      const legX = fromX + Math.round(((toX - fromX) * leg) / legs);
      const legY = fromY + Math.round(((toY - fromY) * leg) / legs);
      if (!emitDragLeg(legX, legY, dir, radius, band, { x: lastDragToX, y: lastDragToY })) return;
    }
  };

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
      x: toX,
      y: toY,
      radius,
      dir,
      tool: 'drag',
      targetBand: band,
      ...(from !== null ? { fromX: from.x, fromY: from.y } : {}),
      seq: nextSeq++,
    });
    if (!sent) return false;
    lastDragToX = toX;
    lastDragToY = toY;
    lastDragDir = dir;
    lastDragRadius = radius;
    haveDragTo = true;
    return true;
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

  const releaseRefusedStroke = (): void => {
    const refused = strokePointerId;
    stopRepeat();
    refusedPointerId = refused;
  };

  const scheduleRepeat = (repeatIndex: number): void => {
    repeatTimer = setTimeout(() => {
      repeatTimer = null;
      emitIntent();
      if (!strokeIsLive()) return;
      scheduleRepeat(repeatIndex + 1);
    }, repeatDelayMs(repeatIndex));
  };

  const armStroke = (): void => {
    if (strokeIsTouch) takeHold(currentStrokeAction());
    if (!strokeIsLive()) return;
    strokeArmed = true;
    emitIntent();
    if (strokeTool === 'drag') return;
    if (!strokeIsLive()) return;
    scheduleRepeat(0);
  };

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

  const takeHold = (action: SculptAction): void => {
    strokeGrab = null;
    if (strokeTool !== 'drag') return;
    const hover = hoverTarget();
    strokeGrab = riserBand(hover);
    if (strokeGrab !== null) return;
    if (hover === null || hover.hitRiser || hover.hitY !== hover.surfaceY) return;
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
    stopRepeat();
    refusedPointerId = null;

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
      if (strokeArmed && strokeGrab !== null) emitIntent();
    }
    if (event.pointerType !== 'touch') syncMode(event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') activeTouchIds.delete(event.pointerId);
    if (event.pointerId === refusedPointerId) refusedPointerId = null;
    if (event.pointerId !== strokePointerId) return;
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

  const onContextMenu = (event: MouseEvent): void => event.preventDefault();

  const onKeyChange = (event: KeyboardEvent): void => syncMode(event);

  const onWindowBlur = (): void => {
    activeTouchIds.clear();
    refusedPointerId = null;
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
