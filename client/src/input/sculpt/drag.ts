import { MAX_DRAG_SWEEP_CELLS, chebyshevDistance } from '@terrace/shared';
import { brushRadius, sculptDirection } from '../../state/hudState.ts';
import type { SculptAction } from '../../state/controlPrefs.ts';
import type { SendOutcome } from './contract.ts';
import { blinkFlat, markUnsent, noteSent } from './cues.ts';
import { hoverTarget } from './aim.ts';
import type { EmitOutcome, StrokeState } from './strokeState.ts';

export const emitDragOutcome = (
  s: StrokeState,
  toX: number,
  toY: number,
  action: SculptAction,
  band: number,
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
    const firstLeg = emitDragLeg(s, toX, toY, dir, radius, band, null);
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
  const legs = Math.ceil(chebyshevDistance(fromX, fromY, toX, toY) / MAX_DRAG_SWEEP_CELLS);
  let sentAny = false;
  for (let leg = 1; leg <= legs; leg++) {
    const legX = fromX + Math.round(((toX - fromX) * leg) / legs);
    const legY = fromY + Math.round(((toY - fromY) * leg) / legs);
    const legOutcome = emitDragLeg(s, legX, legY, dir, radius, band, {
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

const seedLayer = (
  s: StrokeState,
  cell: { x: number; y: number },
  action: SculptAction,
  spanBand: number | null,
): SendOutcome =>
  s.options.send({
    type: 'sculpt',
    x: cell.x,
    y: cell.y,
    radius: brushRadius(),
    dir: sculptDirection(action),
    tool: 'stamp',
    profile: 'hard',
    ...(spanBand !== null ? { spanBand } : {}),
    seq: s.nextSeq++,
  });

/**
 * The seed-band reading takeHold compares before/after the seed intent. A null
 * spanBand reads the column top; a banded one reads that layer; null aborts
 * the grab.
 */
type SeedBandReading =
  | { readonly kind: 'top'; readonly band: number }
  | { readonly kind: 'layer'; readonly band: number };

const readSeedBand = (
  s: StrokeState,
  x: number,
  y: number,
  spanBand: number | null,
): SeedBandReading | null => {
  const band = s.options.bandAtCell(x, y, spanBand);
  if (band === null) return null;
  return spanBand === null ? { kind: 'top', band } : { kind: 'layer', band };
};

export const takeHold = (s: StrokeState, action: SculptAction): void => {
  s.strokeGrab = null;
  if (s.strokeTool !== 'drag') return;
  const hover = hoverTarget(s);
  s.strokeGrab = s.options.riserBand(hover);
  if (s.strokeGrab !== null) return;
  // The seed cues its own send failures below; every other refusal to take
  // hold blinks here, so a press is never silent.
  if (hover === null || hover.face !== 'tread') {
    blinkFlat(s);
    return;
  }
  const spanBand = s.options.graspSpanBand(hover, hover.x, hover.y);
  const before = readSeedBand(s, hover.x, hover.y, spanBand);
  // A press-time seed failure latches offline and blinks once; a local veto
  // is already red and never blinks grey.
  const seeded = seedLayer(s, hover, action, spanBand);
  if (seeded === 'offline') {
    markUnsent(s);
    return;
  }
  if (seeded === 'refused') return;
  const after = readSeedBand(s, hover.x, hover.y, spanBand);
  if (before === null || after === null) {
    blinkFlat(s);
    return;
  }
  if (action === 'raise') {
    // The seed raised nothing: blink the flat cue once.
    if (after.band <= before.band) {
      blinkFlat(s);
      return;
    }
    s.strokeGrab = after.band;
  } else {
    // Lowers grab the pre-seed band: the seed lowers it away, so the drag plane rides the starting band.
    if (after.band >= before.band) {
      blinkFlat(s);
      return;
    }
    s.strokeGrab = before.band;
  }
};
