import { TOOLS_WITHOUT_DIRECTION } from '@terrace/shared';
import { sculptDirection } from '../../state/hudState.ts';
import type { SculptAction } from '../../state/controlPrefs.ts';
import type { TerrainRayPick } from '../../terrain/picking.ts';
import { SILENT_REPEAT_BLINK_AFTER } from './contract.ts';
import type { EmitOrigin, EmitOutcome, StrokeState } from './strokeState.ts';

/** A send() returned false: latch the offline (grey/hollow, never red) cue, blinking once per latch. */
export const markUnsent = (s: StrokeState): void => {
  if (s.offlineLatched) return;
  s.offlineLatched = true;
  s.offlineBlinkCount++;
};

export const noteSent = (s: StrokeState): void => {
  s.silentRepeatTicks = 0;
  s.repeatStreakBlinked = false;
};

/** One flat blink. A press that sends nothing must always cue. */
export const blinkFlat = (s: StrokeState): void => {
  s.flatBlinkCount++;
};

/**
 * A posture refusal that sent nothing. Press-time failures blink once; repeat
 * ticks count toward one blink per SILENT_REPEAT_BLINK_AFTER streak; pointer
 * moves stay silent (the descent-frozen flag is their cue).
 */
export const noteFlatSilent = (s: StrokeState, origin: EmitOrigin): EmitOutcome => {
  if (origin === 'press') s.flatBlinkCount++;
  else if (origin === 'repeat') {
    s.silentRepeatTicks++;
    if (s.silentRepeatTicks >= SILENT_REPEAT_BLINK_AFTER && !s.repeatStreakBlinked) {
      s.repeatStreakBlinked = true;
      s.silentRepeatTicks = 0;
      s.flatBlinkCount++;
    }
  }
  return 'flat-silent';
};

/** Raising with a directionless tool (carve): dead by construction, counted, never cued. */
export const isDirectionlessRaise = (s: StrokeState, action: SculptAction): boolean =>
  TOOLS_WITHOUT_DIRECTION.includes(s.strokeTool) && sculptDirection(action) > 0;

/** Raising into an underside face: a posture refusal, cues flat. */
export const isUndersideRaise = (cell: TerrainRayPick, action: SculptAction): boolean =>
  cell.face === 'underside' && sculptDirection(action) > 0;

/** Carving with no span under the aim: a posture refusal, cues flat. */
export const isCarveWithoutSpan = (s: StrokeState, spanBand: number | null): boolean =>
  s.strokeTool === 'carve' && spanBand === null;

export const refusedIsShowing = (s: StrokeState): boolean =>
  s.refusedPointerId !== null || performance.now() < s.refusedUntilMs;

export const clearRefused = (s: StrokeState): void => {
  s.refusedPointerId = null;
  s.refusedUntilMs = Number.NEGATIVE_INFINITY;
};
