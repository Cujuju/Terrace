import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DRAG_SWEEP_CELLS, chebyshevDistance, type SculptIntent } from '@terrace/shared';
import { MAX_DRAG_LEGS_PER_MOVE, emitDragOutcome } from '../src/input/sculpt/drag.ts';
import { createStrokeState, type StrokeState } from '../src/input/sculpt/strokeState.ts';
import type { SculptInputOptions } from '../src/input/sculpt/contract.ts';
import { brushRadius, setBrushRadius } from '../src/state/hudState.ts';

const HELD_BAND = 3;

const START = { x: 100, y: 100 } as const;

/** Far enough past the cap that the tail must be dropped, not compressed. */
const JUMPED_LEGS = 3 * MAX_DRAG_LEGS_PER_MOVE;

interface Rig {
  readonly state: StrokeState;
  readonly sent: SculptIntent[];
}

function rig(): Rig {
  const sent: SculptIntent[] = [];
  const options = {
    send: (intent: SculptIntent) => {
      sent.push(intent);
      return 'sent' as const;
    },
  } as unknown as SculptInputOptions;

  const state = createStrokeState(options);
  state.haveDragTo = true;
  state.lastDragToX = START.x;
  state.lastDragToY = START.y;
  state.lastDragDir = 1;
  state.lastDragRadius = brushRadius();
  return { state, sent };
}

describe('one pointer move emits at most the leg cap', () => {
  const radius = brushRadius();

  beforeEach(() => {
    setBrushRadius(radius);
  });

  afterEach(() => {
    setBrushRadius(radius);
  });

  it('drops the tail of a jump instead of emitting a leg per sweep', () => {
    const { state, sent } = rig();
    const target = START.x + JUMPED_LEGS * MAX_DRAG_SWEEP_CELLS;

    expect(emitDragOutcome(state, target, START.y, 'raise', HELD_BAND)).toBe('sent');

    expect(sent).toHaveLength(MAX_DRAG_LEGS_PER_MOVE);
    expect(sent.at(-1)!.x).toBeLessThan(target);
  });

  it('keeps every emitted leg within one sweep', () => {
    const { state, sent } = rig();
    const target = START.x + JUMPED_LEGS * MAX_DRAG_SWEEP_CELLS;
    emitDragOutcome(state, target, START.y, 'raise', HELD_BAND);

    for (const leg of sent) {
      expect(chebyshevDistance(leg.fromX!, leg.fromY!, leg.x, leg.y)).toBeLessThanOrEqual(
        MAX_DRAG_SWEEP_CELLS,
      );
    }
  });

  it('carries the hold on from the last leg it sent', () => {
    const { state, sent } = rig();
    const target = START.x + JUMPED_LEGS * MAX_DRAG_SWEEP_CELLS;
    emitDragOutcome(state, target, START.y, 'raise', HELD_BAND);

    const lastSent = sent.at(-1)!;
    expect(state.lastDragToX).toBe(lastSent.x);
    expect(state.lastDragToY).toBe(lastSent.y);

    emitDragOutcome(state, lastSent.x + MAX_DRAG_SWEEP_CELLS, START.y, 'raise', HELD_BAND);
    expect(sent.at(-1)!.fromX).toBe(lastSent.x);
    expect(sent.at(-1)!.fromY).toBe(lastSent.y);
  });

  it('chains the legs it does send, each from the one before', () => {
    const { state, sent } = rig();
    emitDragOutcome(
      state,
      START.x + JUMPED_LEGS * MAX_DRAG_SWEEP_CELLS,
      START.y,
      'raise',
      HELD_BAND,
    );

    let previous: { x: number; y: number } = START;
    for (const leg of sent) {
      expect({ x: leg.fromX, y: leg.fromY }).toEqual({ x: previous.x, y: previous.y });
      previous = { x: leg.x, y: leg.y };
    }
  });

  it('cues nothing: a dropped tail is not a refusal', () => {
    const { state } = rig();
    emitDragOutcome(
      state,
      START.x + JUMPED_LEGS * MAX_DRAG_SWEEP_CELLS,
      START.y,
      'raise',
      HELD_BAND,
    );

    expect(state.offlineBlinkCount).toBe(0);
    expect(state.flatBlinkCount).toBe(0);
    expect(state.offlineLatched).toBe(false);
  });

  it('leaves a jump inside the cap whole, ending on the cell asked for', () => {
    const { state, sent } = rig();
    const target = START.x + (MAX_DRAG_LEGS_PER_MOVE - 1) * MAX_DRAG_SWEEP_CELLS;

    emitDragOutcome(state, target, START.y, 'raise', HELD_BAND);

    expect(sent).toHaveLength(MAX_DRAG_LEGS_PER_MOVE - 1);
    expect(sent.at(-1)!.x).toBe(target);
  });
});
