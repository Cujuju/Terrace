import { Raycaster, Vector2 } from 'three';
import { DEFAULT_BRUSH_TOOL } from '../../state/hudState.ts';
import {
  modifierOf,
  resolvePress,
  type BindingModifier,
  type ModifierState,
  type SculptAction,
} from '../../state/controlPrefs.ts';
import { TOOLS_WITHOUT_DIRECTION } from '@terrace/shared';
import type { SculptTool } from '@terrace/shared';
import type { Vec3 } from '../../terrain/picking.ts';
import type { SculptInputOptions } from './contract.ts';

export interface PointerRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

export type EmitOrigin = 'press' | 'repeat' | 'move';
export type EmitOutcome = 'sent' | 'flat-silent' | 'absent-silent' | 'unsent';

/** Every mutable field one stroke owns, shared by the phase modules. */
export interface StrokeState {
  readonly options: SculptInputOptions;
  readonly raycaster: Raycaster;
  readonly ndc: Vector2;
  readonly activeTouchIds: Set<number>;

  pointerClientX: number;
  pointerClientY: number;
  havePointer: boolean;

  mods: ModifierState;

  // The chord syncMode last ACTED ON. Seeded with the no-modifier resting state
  // so the first unmodified move is not an edge.
  lastModifier: BindingModifier | null;

  strokeButton: number | null;
  strokePointerId: number | null;
  strokeIsTouch: boolean;
  strokeAction: SculptAction;

  strokeTool: SculptTool;

  strokeGrab: number | null;

  strokeCarveBand: number | null;

  strokeArmed: boolean;

  lastDragToX: number;
  lastDragToY: number;
  lastDragDir: 1 | -1;
  lastDragRadius: number;
  haveDragTo: boolean;

  repeatTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;

  hoverKey: string;
  hoverCell: { x: number; y: number } | null;
  hoverRay: PointerRay | null;

  // Bumped whenever the aim re-marches, so a held stroke can tell "same pinned
  // column, new surface" from "the pin moved".
  hoverPin: number;

  nextSeq: number;

  // Cue bookkeeping for the four SculptCue states. Blinks are counters, not
  // timers: lane E renders the flash, and tests assert the budget exactly.
  offlineLatched: boolean;
  offlineBlinkCount: number;
  flatBlinkCount: number;
  silentRepeatTicks: number;
  repeatStreakBlinked: boolean;
  descentFrozen: boolean;
  deadDirectionlessRaiseHits: number;

  // The anchor a held stroke keeps editing, latched to the aim pin that produced
  // it. Re-deriving it every tick walked the stroke toward the camera.
  strokeAnchorPin: number;
  strokeAnchorCell: { x: number; y: number } | null;

  refusedPointerId: number | null;
  refusedUntilMs: number;
}

export function createStrokeState(options: SculptInputOptions): StrokeState {
  const mods: ModifierState = { shiftKey: false, ctrlKey: false, altKey: false };
  return {
    options,
    raycaster: new Raycaster(),
    ndc: new Vector2(),
    activeTouchIds: new Set<number>(),

    pointerClientX: 0,
    pointerClientY: 0,
    havePointer: false,

    mods,
    lastModifier: modifierOf(mods),

    strokeButton: null,
    strokePointerId: null,
    strokeIsTouch: false,
    strokeAction: 'raise',

    strokeTool: DEFAULT_BRUSH_TOOL,

    strokeGrab: null,

    strokeCarveBand: null,

    strokeArmed: false,

    lastDragToX: 0,
    lastDragToY: 0,
    lastDragDir: 1,
    lastDragRadius: 0,
    haveDragTo: false,

    repeatTimer: null,
    graceTimer: null,

    hoverKey: '',
    hoverCell: null,
    hoverRay: null,
    hoverPin: 0,

    nextSeq: 1,

    offlineLatched: false,
    offlineBlinkCount: 0,
    flatBlinkCount: 0,
    silentRepeatTicks: 0,
    repeatStreakBlinked: false,
    descentFrozen: false,
    deadDirectionlessRaiseHits: 0,

    strokeAnchorPin: -1,
    strokeAnchorCell: null,

    refusedPointerId: null,
    refusedUntilMs: Number.NEGATIVE_INFINITY,
  };
}

export const currentStrokeAction = (s: StrokeState): SculptAction => {
  if (s.strokeButton !== null && !s.strokeIsTouch && !TOOLS_WITHOUT_DIRECTION.includes(s.strokeTool)) {
    const resolved = resolvePress(s.strokeButton, s.mods);
    if (resolved === 'raise' || resolved === 'lower') {
      s.strokeAction = resolved;
    }
  }
  return s.strokeAction;
};

export const strokeIsLive = (s: StrokeState): boolean => s.strokePointerId !== null;
