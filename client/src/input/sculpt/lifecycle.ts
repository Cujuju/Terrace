import { TOOLS_WITHOUT_DIRECTION } from '@terrace/shared';
import {
  SCULPT_REPEAT_DELAY_MS,
  SCULPT_REPEAT_INTERVAL_MS,
  SCULPT_REPEAT_RAMP_FACTOR,
  TOUCH_STROKE_GRACE_MS,
} from '../../config.ts';
import { brushTool, setSculptChord } from '../../state/hudState.ts';
import {
  sculptChordHeld,
  type ModifierState,
  type SculptAction,
} from '../../state/controlPrefs.ts';
import { REFUSED_PULSE_MS } from './contract.ts';
import { clearRefused } from './cues.ts';
import { takeHold } from './drag.ts';
import { emitIntent } from './emit.ts';
import { currentStrokeAction, strokeIsLive, type StrokeState } from './strokeState.ts';

export function repeatDelayMs(repeatIndex: number): number {
  const ramped = SCULPT_REPEAT_DELAY_MS * SCULPT_REPEAT_RAMP_FACTOR ** repeatIndex;
  return Math.max(SCULPT_REPEAT_INTERVAL_MS, ramped);
}

export const stopRepeat = (s: StrokeState): void => {
  s.strokeButton = null;
  s.strokePointerId = null;
  s.strokeIsTouch = false;
  s.strokeGrab = null;
  s.strokeGrabFloor = null;
  s.strokeCarveBand = null;
  s.strokeArmed = false;
  s.haveDragTo = false;
  s.hoverKey = '';
  s.hoverCell = null;
  s.hoverRay = null;
  s.strokeAnchorPin = -1;
  s.strokeAnchorCell = null;
  s.offlineLatched = false;
  s.silentRepeatTicks = 0;
  s.repeatStreakBlinked = false;
  s.descentFrozen = false;
  if (s.repeatTimer !== null) {
    clearTimeout(s.repeatTimer);
    s.repeatTimer = null;
  }
  if (s.graceTimer !== null) {
    clearTimeout(s.graceTimer);
    s.graceTimer = null;
  }
};

export const releaseRefusedStroke = (s: StrokeState): void => {
  const refused = s.strokePointerId;
  stopRepeat(s);
  s.refusedPointerId = refused;
  // A nack that outlived its click has no button to hold the cue: pulse instead.
  if (refused === null) s.refusedUntilMs = performance.now() + REFUSED_PULSE_MS;
};

const scheduleRepeat = (s: StrokeState, repeatIndex: number): void => {
  s.repeatTimer = setTimeout(() => {
    s.repeatTimer = null;
    const outcome = emitIntent(s, 'repeat');
    if (!strokeIsLive(s)) return;
    // Gate the repeat on the connection: while offline the held button holds its
    // cue instead of spamming intents the room will never see.
    if (outcome === 'unsent') return;
    scheduleRepeat(s, repeatIndex + 1);
  }, repeatDelayMs(repeatIndex));
};

export const armStroke = (s: StrokeState): void => {
  if (s.strokeIsTouch) takeHold(s);
  if (!strokeIsLive(s)) return;
  s.strokeArmed = true;
  // A press-time send failure latches the offline cue and skips the repeat.
  if (emitIntent(s, 'press') === 'unsent') return;
  if (s.strokeTool === 'drag') return;
  if (!strokeIsLive(s)) return;
  scheduleRepeat(s, 0);
};

export const startStroke = (
  s: StrokeState,
  event: PointerEvent,
  action: SculptAction,
): void => {
  stopRepeat(s);
  clearRefused(s);

  s.strokeButton = event.button;
  s.strokePointerId = event.pointerId;
  s.strokeIsTouch = event.pointerType === 'touch';
  s.strokeTool = brushTool();
  if (TOOLS_WITHOUT_DIRECTION.includes(s.strokeTool)) {
    s.strokeAction = 'lower';
  } else {
    s.strokeAction = action;
  }
  s.pointerClientX = event.clientX;
  s.pointerClientY = event.clientY;
  s.havePointer = true;
  if (!s.strokeIsTouch) takeHold(s);

  if (s.strokeIsTouch) {
    s.graceTimer = setTimeout(() => {
      s.graceTimer = null;
      armStroke(s);
    }, TOUCH_STROKE_GRACE_MS);
    return;
  }

  armStroke(s);
};

export const syncMode = (s: StrokeState, state: ModifierState): void => {
  s.mods = {
    shiftKey: state.shiftKey,
    ctrlKey: state.ctrlKey,
    altKey: state.altKey,
  };
  // The chord inverts the toggle rather than overwriting it, so re-asserting it
  // every move is idempotent. A directionless tool holds no chord.
  setSculptChord(
    !TOOLS_WITHOUT_DIRECTION.includes(brushTool()) && sculptChordHeld(s.mods),
  );
};
