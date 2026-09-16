import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BAND_HEIGHT,
  MAX_DRAG_SWEEP_CELLS,
  SCULPT_PRESS_UNITS_PER_CELL,
  strokeSweep,
  sweepAt,
  sweptCellCount,
  type SculptIntent,
} from '@terrace/shared';
import { openedChunkCount, sculptIntentCost, sculptManaCost } from '../pricing.ts';

type ManaClientState = typeof import('../client/state.ts');

let state: ManaClientState;

beforeEach(async () => {
  vi.resetModules();
  state = await import('../client/state.ts');
  state.clearInFlightDebits();
  state.setManaPool(null);
});

const MANA_PER_BAND_CELL = 10;

const POOL_CAPACITY = 1000000;

const BRUSH_RADIUS = 4;

const LEG_FROM = { x: 40, y: 40 } as const;

const LEG_TO = { x: LEG_FROM.x + MAX_DRAG_SWEEP_CELLS, y: LEG_FROM.y } as const;

const HELD_BAND = 3;

const NOTHING_OPEN_CHUNKS = 0;

const EVERYWHERE = { worldSize: () => 0, revealedAt: () => true, terrainHeightAt: () => null };

function dragLeg(from: { x: number; y: number } | null): SculptIntent {
  return {
    type: 'sculpt',
    x: LEG_TO.x,
    y: LEG_TO.y,
    radius: BRUSH_RADIUS,
    dir: 1,
    tool: 'drag',
    targetBand: HELD_BAND,
    ...(from === null ? {} : { fromX: from.x, fromY: from.y }),
    seq: 7,
  };
}

function fundedPool(): void {
  state.setManaPool({
    balance: POOL_CAPACITY,
    capacity: POOL_CAPACITY,
    manaPerBandCell: MANA_PER_BAND_CELL,
    regenPerSecond: 0,
  });
}

describe('a sweep is priced by the cells it sweeps', () => {
  it('charges one press per swept cell, not one per rasterised step', () => {
    const intent = dragLeg(LEG_FROM);
    const swept = sweptCellCount(strokeSweep(intent));

    expect(sculptIntentCost(MANA_PER_BAND_CELL, intent, NOTHING_OPEN_CHUNKS)).toBe(
      Math.ceil((MANA_PER_BAND_CELL * swept * SCULPT_PRESS_UNITS_PER_CELL) / BAND_HEIGHT),
    );
  });

  it('costs more than the same brush pressed once, and less than pressing it every cell', () => {
    const legCost = sculptIntentCost(MANA_PER_BAND_CELL, dragLeg(LEG_FROM), NOTHING_OPEN_CHUNKS);
    const pressCost = sculptManaCost(
      MANA_PER_BAND_CELL,
      BRUSH_RADIUS,
      'hard',
      'drag',
      1,
    );
    expect(legCost).toBeGreaterThan(pressCost);
    expect(legCost).toBeLessThan(pressCost * MAX_DRAG_SWEEP_CELLS);
  });

  it('prices a leg that goes nowhere exactly like the press it is', () => {
    expect(sculptIntentCost(MANA_PER_BAND_CELL, dragLeg(null), NOTHING_OPEN_CHUNKS)).toBe(
      sculptManaCost(MANA_PER_BAND_CELL, BRUSH_RADIUS, 'hard', 'drag', 1),
    );
  });

  it('counts the swept cells the same way on every octant of the same length', () => {
    const straight = sweptCellCount(
      strokeSweep(dragLeg({ x: LEG_TO.x - MAX_DRAG_SWEEP_CELLS, y: LEG_TO.y })),
    );
    const mirrored = sweptCellCount(
      strokeSweep({
        ...dragLeg(null),
        fromX: LEG_TO.x + MAX_DRAG_SWEEP_CELLS,
        fromY: LEG_TO.y,
      }),
    );
    expect(mirrored).toBe(straight);
  });
});

describe('the client quotes what the server charges', () => {
  beforeEach(() => {
    fundedPool();
  });

  it('debits the leg it is about to send for exactly the server price', () => {
    const intent = dragLeg(LEG_FROM);
    const before = state.manaPool()!.balance;

    expect(state.gateLocalSculpt(intent, EVERYWHERE)).toBe(true);

    const debited = before - state.manaPool()!.balance;
    expect(debited).toBe(sculptIntentCost(MANA_PER_BAND_CELL, intent, NOTHING_OPEN_CHUNKS));
  });

  it('counts more frontier for the whole leg than for the disc at its end', () => {
    const worldSize = 128;
    const isOpen = (cx: number, cy: number): boolean => cx >= 2 && cx <= 3 && cy === 2;
    const intent = dragLeg(LEG_FROM);

    expect(openedChunkCount(worldSize, strokeSweep(intent), isOpen)).toBeGreaterThan(
      openedChunkCount(worldSize, sweepAt(intent.x, intent.y, intent.radius), isOpen),
    );
  });
});
