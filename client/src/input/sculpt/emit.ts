import { brushTool, sculptDirection } from '../../state/hudState.ts';
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
import { pointSculptIntent, sculptTargetOf, type SculptTarget } from './intent.ts';
import type { TerrainRayPick } from '../../terrain/picking.ts';

export function targetForPick(s: StrokeState, pick: TerrainRayPick): SculptTarget {
  const held = s.strokeArmed && s.strokeAnchorPin === s.hoverPin ? s.strokeAnchorCell : null;
  return sculptTargetOf(pick, s.hoverRay?.direction ?? null, s.options.worldSize(),
    s.strokeArmed ? s.strokeTool : brushTool(), s.options.graspSpanBand, held);
}

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

  // Alt picks the tool's alt variant: a one-band drag, a wall-true smooth. Live per emit, so the chord switches later dabs.
  const alt = s.strokeButton !== null && !s.strokeIsTouch && isAltSculptPress(s.strokeButton, s.mods);
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
    // The run floor is kept across legs.
    return emitDragOutcome(
      s,
      to.x,
      to.y,
      action,
      s.strokeGrab,
      s.strokeGrabFloor ?? s.strokeGrab,
      alt,
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
    const target = targetForPick(s, cell);
    anchor = target;
    s.strokeAnchorPin = s.hoverPin;
    s.strokeAnchorCell = anchor;
    // The grasp is read at the anchor: a span the anchored column lacks names nothing there.
    spanBand =
      s.strokeTool === 'carve'
        ? s.options.carveBand(cell)
        : target.spanBand;
    if (s.strokeTool === 'carve') {
      if (isCarveWithoutSpan(s, spanBand)) return noteFlatSilent(s, origin);
      s.strokeCarveBand = spanBand;
    }
  }
  // Every emit path honors the send() outcome like emitDragLeg does: 'offline'
  // is the connection-down cue (grey/hollow, never red), 'refused' is a latched
  // plugin veto. Neither is predicted.
  const outcome = s.options.send({
    ...pointSculptIntent({ ...anchor, spanBand }, s.strokeTool, sculptDirection(action), alt),
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
