import { MAX_DRAG_SWEEP_CELLS, chebyshevDistance } from '@terrace/shared';
import { brushRadius, sculptDirection } from '../../state/hudState.ts';
import type { SculptAction } from '../../state/controlPrefs.ts';
import type { SendOutcome } from './contract.ts';
import { blinkFlat, markUnsent, noteSent } from './cues.ts';
import { hoverTarget } from './aim.ts';
import type { EmitOutcome, StrokeState } from './strokeState.ts';

/**
 * Chrome, default zoom, 60 Hz: a 1900px flick in 150ms peaks near 330px a
 * frame, about 102 cells — seven legs. One above that; the rest is dropped.
 */
export const MAX_DRAG_LEGS_PER_MOVE = 8;

export const emitDragOutcome = (
  s: StrokeState,
  toX: number,
  toY: number,
  action: SculptAction,
  band: number,
  floorBand: number,
): EmitOutcome => {
  const dir = sculptDirection(action);
  const radius = brushRadius();
  if (
    s.haveDragTo &&
    toX === s.lastDragToX &&
    toY === s.lastDragToY &&
    dir === s.lastDragDir &&
    radius === s.lastDragRadius
  ) {
    return 'absent-silent';
  }
  if (!s.haveDragTo || (s.lastDragToX === toX && s.lastDragToY === toY)) {
    const firstLeg = emitDragLeg(s, toX, toY, dir, radius, band, floorBand, null);
    if (firstLeg !== 'sent') {
      // A dropped first leg is one offline blink for the whole sweep; a local
      // veto is already red and never blinks grey.
      if (firstLeg === 'offline') markUnsent(s);
      return 'unsent';
    }
    noteSent(s);
    return 'sent';
  }
  const fromX = s.lastDragToX;
  const fromY = s.lastDragToY;
  const span = Math.ceil(chebyshevDistance(fromX, fromY, toX, toY) / MAX_DRAG_SWEEP_CELLS);
  // Past the cap the jump's tail is dropped, not compressed: each leg keeps its
  // own length, and the hold carries on from the last one sent.
  const legs = span > MAX_DRAG_LEGS_PER_MOVE ? MAX_DRAG_LEGS_PER_MOVE : span;
  let sentAny = false;
  for (let leg = 1; leg <= legs; leg++) {
    const legX = fromX + Math.round(((toX - fromX) * leg) / span);
    const legY = fromY + Math.round(((toY - fromY) * leg) / span);
    const legOutcome = emitDragLeg(s, legX, legY, dir, radius, band, floorBand, {
      x: s.lastDragToX,
      y: s.lastDragToY,
    });
    if (legOutcome !== 'sent') {
      // Sweep truncation: the tail legs are dropped (emitDragLeg leaves the last
      // sent leg current), with one offline blink for the sweep. A local veto
      // is already red, never grey.
      if (legOutcome === 'offline') markUnsent(s);
      return sentAny ? 'sent' : 'unsent';
    }
    sentAny = true;
  }
  // The sweep can legally round to zero legs; that frame stays silent.
  if (!sentAny) return 'absent-silent';
  noteSent(s);
  return 'sent';
};

const emitDragLeg = (
  s: StrokeState,
  toX: number,
  toY: number,
  dir: 1 | -1,
  radius: number,
  band: number,
  floorBand: number,
  from: { x: number; y: number } | null,
): SendOutcome => {
  const outcome = s.options.send({
    type: 'sculpt',
    x: toX,
    y: toY,
    radius,
    dir,
    tool: 'drag',
    targetBand: band,
    floorBand,
    ...(from !== null ? { fromX: from.x, fromY: from.y } : {}),
    seq: s.nextSeq++,
  });
  if (outcome !== 'sent') return outcome;
  s.lastDragToX = toX;
  s.lastDragToY = toY;
  s.lastDragDir = dir;
  s.lastDragRadius = radius;
  s.haveDragTo = true;
  return 'sent';
};

/** The run's floor, read once in the grabbed column and sent on every leg. */
const holdRunFloor = (s: StrokeState, x: number, y: number, band: number): void => {
  s.strokeGrabFloor = s.options.runFloorBandAt(x, y, band);
};

export const takeHold = (s: StrokeState): void => {
  s.strokeGrab = null;
  s.strokeGrabFloor = null;
  if (s.strokeTool !== 'drag') return;
  const hover = hoverTarget(s);
  // The clicked band IS the hold: a press never seeds a band to grab.
  s.strokeGrab = s.options.riserBand(hover);
  if (s.strokeGrab === null && hover !== null && hover.face === 'tread') {
    // A tread grabs the band under the aim, so a drag starts anywhere on a
    // surface and heals a hollow without hunting for the hollow's edge.
    s.strokeGrab = s.options.aimBand(hover);
  }
  if (s.strokeGrab === null) {
    blinkFlat(s);
    return;
  }
  if (hover !== null) holdRunFloor(s, hover.x, hover.y, s.strokeGrab);
};
