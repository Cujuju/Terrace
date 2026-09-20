import { TOOLS_WITHOUT_DIRECTION, TOOLS_WITHOUT_EDGE_PROFILE } from '@terrace/shared';
import type { SculptTool } from '@terrace/shared';
import {
  brushProfile,
  brushRadius,
  carveDepthBands,
  sculptDirection,
  smoothFeather,
  smoothLambda,
} from '../../state/hudState.ts';
import { footOfFaceCell } from '../../terrain/faceFoot.ts';
import { isAltSculptPress } from '../../state/controlPrefs.ts';
import { dragPlaneCell, hoverTarget } from './aim.ts';
import {
  isCarveWithoutSpan,
  isDirectionlessRaise,
  isUndersideRaise,
  markUnsent,
  noteFlatSilent,
  noteSent,
} from './cues.ts';
import { emitDragOutcome } from './drag.ts';
import { currentStrokeAction, type EmitOrigin, type EmitOutcome, type StrokeState } from './strokeState.ts';

const TOOLS_WITH_FOOT_ANCHOR: readonly SculptTool[] = ['stamp', 'smooth'];

export const emitIntent = (s: StrokeState, origin: EmitOrigin): EmitOutcome => {
  const action = currentStrokeAction(s);
  // No grab, no stroke: the takeHold seed already cued any failure, so this stays silent.
  if (s.strokeTool === 'drag' && s.strokeGrab === null) return 'absent-silent';
  // Dead by construction — startStroke/currentStrokeAction never arm a
  // directionless tool with raise. Counted for the log, never cued, no behavior change.
  if (isDirectionlessRaise(s, action)) {
    s.deadDirectionlessRaiseHits++;
    console.debug('[terrace] sculpt: directionless-raise guard hit (dead by construction)');
    return 'absent-silent';
  }
  if (s.strokeGrab !== null) {
    const to = dragPlaneCell(s, s.strokeGrab);
    if (to === null) {
      // Descent gate: the held band's plane left the ray (aimed too shallow), so
      // freeze the stroke and mark it for the flat-mark crosshair. Cue-only: the
      // MIN_DRAG_PLANE_DESCENT threshold is unchanged.
      s.descentFrozen = true;
      return noteFlatSilent(s, origin);
    }
    s.descentFrozen = false;
    // Alt drags one band only. Live per leg, so the chord switches later
    // legs; the run floor is kept.
    const dragAlt =
      s.strokeButton !== null &&
      !s.strokeIsTouch &&
      isAltSculptPress(s.strokeButton, s.mods);
    return emitDragOutcome(
      s,
      to.x,
      to.y,
      action,
      s.strokeGrab,
      s.strokeGrabFloor ?? s.strokeGrab,
      dragAlt,
    );
  }
  s.descentFrozen = false;
  let anchor: { x: number; y: number };
  let spanBand: number | null;

  if (s.strokeTool === 'carve' && s.strokeCarveBand !== null) {
    // No aim yet, or the tunnel broke through: no-target frames stay silent.
    if (s.hoverRay === null) return 'absent-silent';
    const reach = s.options.carveReach(
      s.hoverRay.origin,
      s.hoverRay.direction,
      s.strokeCarveBand,
    );
    if (reach === null) return 'absent-silent';
    anchor = reach;
    spanBand = s.strokeCarveBand;
  } else {
    const cell = hoverTarget(s);
    // No-target frame stays silent.
    if (cell === null) return 'absent-silent';
    if (isUndersideRaise(cell, action)) return noteFlatSilent(s, origin);
    if (s.strokeArmed && s.strokeAnchorCell !== null && s.strokeAnchorPin === s.hoverPin) {
      anchor = s.strokeAnchorCell;
    } else {
      const foot =
        s.hoverRay !== null && TOOLS_WITH_FOOT_ANCHOR.includes(s.strokeTool)
          ? footOfFaceCell(cell, s.hoverRay.direction, s.options.worldSize())
          : null;
      anchor = foot ?? { x: cell.x, y: cell.y };
      s.strokeAnchorPin = s.hoverPin;
      s.strokeAnchorCell = anchor;
    }
    // The grasp is read at the anchor: a span the anchored column lacks names nothing there.
    spanBand =
      s.strokeTool === 'carve'
        ? s.options.carveBand(cell)
        : s.options.graspSpanBand(cell, anchor.x, anchor.y);
    if (s.strokeTool === 'carve') {
      if (isCarveWithoutSpan(s, spanBand)) return noteFlatSilent(s, origin);
      s.strokeCarveBand = spanBand;
    }
  }
  // Every emit path honors the send() outcome like emitDragLeg does: 'offline'
  // is the connection-down cue (grey/hollow, never red), 'refused' is a latched
  // plugin veto. Neither is predicted.
  const outcome = s.options.send({
    type: 'sculpt',
    x: anchor.x,
    y: anchor.y,
    radius: brushRadius(),
    dir: sculptDirection(action),
    tool: s.strokeTool,
    ...(TOOLS_WITHOUT_EDGE_PROFILE.includes(s.strokeTool)
      ? {}
      : { profile: brushProfile() }),
    ...(s.strokeTool === 'smooth' ? { smoothLambda: smoothLambda() } : {}),
    ...(s.strokeTool === 'smooth' ? { smoothFeather: smoothFeather() } : {}),
    ...(s.strokeTool === 'carve' ? { depthBands: carveDepthBands() } : {}),
    ...(spanBand !== null ? { spanBand } : {}),
    seq: s.nextSeq++,
  });
  if (outcome === 'offline') {
    markUnsent(s);
    return 'unsent';
  }
  // A local veto ends the emit without touching the grey latch.
  if (outcome === 'refused') return 'unsent';
  noteSent(s);
  return 'sent';
};
