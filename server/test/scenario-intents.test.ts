import {
  drawnBandOfSample,
  MAX_BAND,
  MAX_BRUSH_RADIUS,
  MAX_DRAG_SWEEP_CELLS,
  MIN_BAND,
  MIN_BRUSH_RADIUS,
} from '@terrace/shared';
import { describe, expect, it } from 'vitest';
import { SCULPT_BURST_INTENTS, SculptRateLimiter } from '../src/net/sculpt-rate-limit.ts';
import type { Player } from '../src/player.ts';
import {
  entriesOfKind,
  EVERY_CHUNK,
  SCENARIO_WORLD_SIZE,
  Scenario,
  sculptMessage,
  wireOrder,
  type ScenarioSpec,
} from './support/scenario.ts';

const SCULPTOR: Player = { id: 'session-1', token: 'token-1', name: 'Sculptor' };

/** A cell on the fixture staircase, well inside the terrace world. */
const FACE_CELL = { x: 20, y: 32 } as const;

/** A cell with an exposed step face beside it, so a drag has a lip to grasp. */
const LIP_CELL = { x: 20, y: 46 } as const;

const OPEN_WORLD: ScenarioSpec = {
  terrain: 'terrace',
  unlocked: EVERY_CHUNK,
  owned: EVERY_CHUNK,
  players: [SCULPTOR],
};

const SEQ = 31;

function openTerrace(): Scenario {
  return new Scenario(OPEN_WORLD);
}

interface MalformedCase {
  readonly why: string;
  readonly message: unknown;
  /** Set where the message cannot carry a routable seq, so no nack can come back. */
  readonly silent?: true;
}

const AT = { x: FACE_CELL.x, y: FACE_CELL.y } as const;

/** Every case that can carry a seq carries one, so its refusal lands on the wire. */
function malformed(overrides: Record<string, unknown>): unknown {
  return sculptMessage({ seq: SEQ, ...overrides });
}

const MALFORMED: readonly MalformedCase[] = [
  { why: 'not an object at all', message: null, silent: true },
  { why: 'a bare string', message: 'sculpt', silent: true },
  { why: 'another message type', message: { type: 'nuke', ...AT, radius: 1, dir: 1, seq: SEQ } },
  { why: 'a fractional x', message: malformed({ ...AT, x: 1.5 }) },
  { why: 'an x past the world edge', message: malformed({ ...AT, x: SCENARIO_WORLD_SIZE }) },
  { why: 'a negative y', message: malformed({ ...AT, y: -1 }) },
  { why: 'a radius under the minimum', message: malformed({ ...AT, radius: MIN_BRUSH_RADIUS - 1 }) },
  { why: 'a radius over the maximum', message: malformed({ ...AT, radius: MAX_BRUSH_RADIUS + 1 }) },
  { why: 'a direction that is neither 1 nor -1', message: malformed({ ...AT, dir: 2 }) },
  { why: 'a fractional seq', message: malformed({ ...AT, seq: 1.5 }), silent: true },
  { why: 'an unknown tool', message: malformed({ ...AT, tool: 'chisel' }) },
  { why: 'an unknown edge profile', message: malformed({ ...AT, profile: 'medium' }) },
  {
    why: 'a carve asking to raise',
    message: malformed({ ...AT, tool: 'carve', dir: 1, spanBand: 2 }),
  },
  {
    why: 'a targetBand below the lowest band',
    message: malformed({ ...AT, tool: 'drag', targetBand: MIN_BAND - 1, floorBand: MIN_BAND }),
  },
  {
    why: 'a targetBand above the highest band',
    message: malformed({ ...AT, tool: 'drag', targetBand: MAX_BAND + 1, floorBand: MIN_BAND }),
  },
  {
    why: 'a fractional targetBand',
    message: malformed({ ...AT, tool: 'drag', targetBand: 2.5, floorBand: 2 }),
  },
  { why: 'a targetBand on a stamp', message: malformed({ ...AT, targetBand: 2 }) },
  {
    why: 'a drag carrying no targetBand',
    message: malformed({ ...AT, tool: 'drag', floorBand: 2 }),
  },
  {
    why: 'a drag carrying no floorBand — the swept cell cannot derive the run',
    message: malformed({ ...AT, tool: 'drag', targetBand: 2 }),
  },
  {
    why: 'a floorBand above its own targetBand',
    message: malformed({ ...AT, tool: 'drag', targetBand: 2, floorBand: 3 }),
  },
  {
    why: 'a floorBand on a stamp',
    message: malformed({ ...AT, floorBand: 2 }),
  },
  {
    why: 'a spanBand below the lowest band',
    message: malformed({ ...AT, tool: 'carve', dir: -1, spanBand: MIN_BAND - 1 }),
  },
  {
    why: 'a spanBand above the highest band',
    message: malformed({ ...AT, tool: 'carve', dir: -1, spanBand: MAX_BAND + 1 }),
  },
  {
    why: 'a spanBand on a drag',
    message: malformed({ ...AT, tool: 'drag', targetBand: 2, spanBand: 2 }),
  },
  { why: 'a carve carrying no spanBand', message: malformed({ ...AT, tool: 'carve', dir: -1 }) },
  { why: 'a sweep origin on a stamp', message: malformed({ ...AT, fromX: 4, fromY: 4 }) },
  {
    why: 'a half-named sweep origin',
    message: malformed({ ...AT, tool: 'drag', targetBand: 2, fromX: 4 }),
  },
  {
    why: 'a fractional sweep origin',
    message: malformed({ ...AT, tool: 'drag', targetBand: 2, fromX: 1.5, fromY: 4 }),
  },
  {
    why: 'a sweep origin past the world edge',
    message: malformed({
      ...AT,
      tool: 'drag',
      targetBand: 2,
      fromX: SCENARIO_WORLD_SIZE,
      fromY: 4,
    }),
  },
  {
    why: 'a sweep longer than a chunk',
    message: malformed({
      x: MAX_DRAG_SWEEP_CELLS + 1,
      y: FACE_CELL.y,
      tool: 'drag',
      targetBand: 2,
      fromX: 0,
      fromY: FACE_CELL.y,
    }),
  },
];

describe('the validator refuses every malformed sculpt the wire can carry', () => {
  it.each(MALFORMED)('refuses $why', ({ message, silent }) => {
    const scenario = openTerrace();
    const before = scenario.world.heightAt(FACE_CELL.x, FACE_CELL.y);

    const step = scenario.send(SCULPTOR, message);

    expect(step.reached).toBe('pipeline');
    expect(scenario.world.dirty).toBe(false);
    expect(scenario.world.heightAt(FACE_CELL.x, FACE_CELL.y)).toBe(before);
    expect(entriesOfKind(step.entries, 'diff')).toHaveLength(0);
    expect(entriesOfKind(step.entries, 'ack')).toHaveLength(0);

    if (silent === true) {
      expect(step.entries).toEqual([]);
      expect(step.outcome).toBeNull();
      return;
    }

    expect(entriesOfKind(step.entries, 'nack')).toEqual([
      { kind: 'nack', to: SCULPTOR.id, seq: SEQ, reason: 'malformed' },
    ]);
    expect(step.outcome).toEqual({ applied: false, reason: 'malformed' });
  });

  it('nacks a malformed intent that carried a routable seq, and stays silent otherwise', () => {
    const scenario = openTerrace();

    const routable = scenario.send(SCULPTOR, sculptMessage({ ...AT, x: 1.5, seq: SEQ }));
    expect(routable.entries).toEqual([
      { kind: 'nack', to: SCULPTOR.id, seq: SEQ, reason: 'malformed' },
    ]);

    const unroutable = scenario.send(SCULPTOR, sculptMessage({ ...AT, x: 1.5 }));
    expect(unroutable.entries).toEqual([]);
  });
});

describe('a carve names the span it grasps; a drag names the lip it holds', () => {
  function bandAt(scenario: Scenario, x: number, y: number): number {
    return drawnBandOfSample(scenario.world.heightAt(x, y));
  }

  it('applies a carve that names its spanBand, and acks after the diff', () => {
    const scenario = openTerrace();
    const spanBand = bandAt(scenario, FACE_CELL.x, FACE_CELL.y);

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({ ...AT, tool: 'carve', dir: -1, radius: 2, spanBand, seq: SEQ }),
    );

    expect(step.outcome?.applied).toBe(true);
    expect(wireOrder(step.entries)).toEqual([
      [SCULPTOR.id, 'diff'],
      [SCULPTOR.id, 'ack'],
    ]);
  });

  it('refuses the same carve once its spanBand is stripped', () => {
    const scenario = openTerrace();
    const step = scenario.send(
      SCULPTOR,
      sculptMessage({ ...AT, tool: 'carve', dir: -1, radius: 2, seq: SEQ }),
    );

    expect(step.outcome).toEqual({ applied: false, reason: 'malformed' });
    expect(step.entries).toEqual([
      { kind: 'nack', to: SCULPTOR.id, seq: SEQ, reason: 'malformed' },
    ]);
  });

  it('applies a drag that names its targetBand, and acks after the diff', () => {
    const scenario = openTerrace();
    const targetBand = bandAt(scenario, LIP_CELL.x, LIP_CELL.y) + 1;

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({
        ...LIP_CELL,
        tool: 'drag',
        dir: 1,
        radius: 2,
        targetBand,
        floorBand: targetBand,
        seq: SEQ,
      }),
    );

    expect(step.outcome?.applied).toBe(true);
    expect(wireOrder(step.entries)).toEqual([
      [SCULPTOR.id, 'diff'],
      [SCULPTOR.id, 'ack'],
    ]);
    expect(entriesOfKind(step.entries, 'ack')).toEqual([
      { kind: 'ack', to: SCULPTOR.id, seq: SEQ },
    ]);
  });

  it('refuses that drag when it also carries a spanBand', () => {
    const scenario = openTerrace();
    const targetBand = bandAt(scenario, FACE_CELL.x, FACE_CELL.y) + 1;

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({
        ...AT,
        tool: 'drag',
        dir: 1,
        radius: 2,
        targetBand,
        spanBand: targetBand,
        seq: SEQ,
      }),
    );

    expect(step.outcome).toEqual({ applied: false, reason: 'malformed' });
    expect(scenario.world.dirty).toBe(false);
  });
});

describe('the room gates a sender before the pipeline sees the message', () => {
  /** A clock that never moves, so the bucket never refills mid-burst. */
  const FROZEN_MS = 0;

  function malformedAt(seq: number): unknown {
    return sculptMessage({ ...AT, x: 1.5, seq });
  }

  it('drops the stroke past a sender burst, and says nothing back', () => {
    const scenario = new Scenario({
      ...OPEN_WORLD,
      rate: new SculptRateLimiter({ now: () => FROZEN_MS }),
    });

    for (let sent = 0; sent < SCULPT_BURST_INTENTS; sent++) {
      expect(scenario.send(SCULPTOR, malformedAt(sent)).entries).toHaveLength(1);
    }

    const dropped = scenario.send(SCULPTOR, malformedAt(SCULPT_BURST_INTENTS));

    expect(dropped.reached).toBe('dropped');
    expect(dropped.entries).toEqual([]);
    expect(dropped.outcome).toBeNull();
  });
});

describe('a locked centre is refused before any plugin sees it', () => {
  const HOME: readonly (readonly [number, number])[] = [[0, 0]];
  const LOCKED_CELL = { x: SCENARIO_WORLD_SIZE - 8, y: SCENARIO_WORLD_SIZE - 8 } as const;

  it('nacks a locked-centre intent as locked, not as malformed', () => {
    const scenario = new Scenario({
      terrain: 'terrace',
      unlocked: HOME,
      owned: HOME,
      players: [SCULPTOR],
    });

    const step = scenario.send(
      SCULPTOR,
      sculptMessage({ ...LOCKED_CELL, seq: SEQ }),
    );

    expect(step.outcome).toEqual({ applied: false, reason: 'locked' });
    expect(step.entries).toEqual([
      { kind: 'nack', to: SCULPTOR.id, seq: SEQ, reason: 'locked' },
    ]);
  });

  it('reaches the pipeline even when an unroutable seq leaves no evidence', () => {
    const scenario = new Scenario({
      terrain: 'terrace',
      unlocked: HOME,
      owned: HOME,
      players: [SCULPTOR],
    });

    const step = scenario.send(SCULPTOR, sculptMessage(LOCKED_CELL));

    expect(step.reached).toBe('pipeline');
    expect(step.outcome).toBeNull();
    expect(step.entries).toEqual([]);
  });
});
