import { resolveSculptPress } from '../state/controlPrefs.ts';
import { effectiveSculptMode } from '../state/hudState.ts';
import type { TerrainRayPick } from '../terrain/picking.ts';
import { hoverTarget } from './sculpt/aim.ts';
import { clearRefused, refusedIsShowing } from './sculpt/cues.ts';
import { takeHold } from './sculpt/drag.ts';
import { emitIntent } from './sculpt/emit.ts';
import {
  releaseRefusedStroke,
  startStroke,
  stopRepeat,
  syncMode,
} from './sculpt/lifecycle.ts';
import { createStrokeState, currentStrokeAction } from './sculpt/strokeState.ts';
import type { SculptInput, SculptInputOptions } from './sculpt/contract.ts';

export {
  REFUSED_PULSE_MS,
  SILENT_REPEAT_BLINK_AFTER,
  type SculptCue,
  type SculptInput,
  type SculptInputOptions,
  type SendOutcome,
} from './sculpt/contract.ts';
export { repeatDelayMs } from './sculpt/lifecycle.ts';

export function createSculptInput(options: SculptInputOptions): SculptInput {
  const s = createStrokeState(options);
  const { canvas } = options;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      s.activeTouchIds.add(event.pointerId);
      if (s.activeTouchIds.size > 1) {
        stopRepeat(s);
        return;
      }
      startStroke(s, event, effectiveSculptMode());
      return;
    }

    syncMode(s, event);
    const action = resolveSculptPress(event.button, event);
    if (action === null) return;
    startStroke(s, event, action);
  };

  const onPointerMove = (event: PointerEvent): void => {
    // Sync the chord BEFORE the leg: a modifier change must steer the leg it
    // arrived on, not the next one.
    if (event.pointerType !== 'touch') syncMode(s, event);
    if (s.strokePointerId === null || event.pointerId === s.strokePointerId) {
      s.pointerClientX = event.clientX;
      s.pointerClientY = event.clientY;
      s.havePointer = true;
      if (s.strokeArmed && s.strokeGrab !== null) emitIntent(s, 'move');
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') s.activeTouchIds.delete(event.pointerId);
    if (event.pointerId === s.refusedPointerId) s.refusedPointerId = null;
    if (event.pointerId !== s.strokePointerId) return;
    if (s.graceTimer !== null) {
      takeHold(s, currentStrokeAction(s));
      emitIntent(s, 'press');
    }
    stopRepeat(s);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') s.activeTouchIds.delete(event.pointerId);
    if (event.pointerId === s.refusedPointerId) s.refusedPointerId = null;
    if (event.pointerId === s.strokePointerId) stopRepeat(s);
  };

  const onContextMenu = (event: MouseEvent): void => event.preventDefault();

  const onKeyChange = (event: KeyboardEvent): void => syncMode(s, event);

  const onWindowBlur = (): void => {
    s.activeTouchIds.clear();
    clearRefused(s);
    stopRepeat(s);
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
    hoverTarget: (): TerrainRayPick | null => hoverTarget(s),
    heldBand: (): number | null => s.strokeGrab,
    carveHeldBand: (): number | null => s.strokeCarveBand,
    releaseStroke: (): void => releaseRefusedStroke(s),
    refusedHold: (): boolean => refusedIsShowing(s),
    offlineHold: (): boolean => s.offlineLatched,
    dragDescentFrozen: (): boolean => s.descentFrozen,
    offlineBlinks: (): number => s.offlineBlinkCount,
    flatBlinks: (): number => s.flatBlinkCount,
    deadGuardHits: (): number => s.deadDirectionlessRaiseHits,
    dispose(): void {
      clearRefused(s);
      stopRepeat(s);
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
