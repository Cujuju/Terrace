import {
  drawnBandOfSample,
  MAX_BAND,
  MAX_BRUSH_RADIUS,
  MAX_DRAG_SWEEP_CELLS,
  MIN_BAND,
  MIN_BRUSH_RADIUS,
} from '@terrace/shared';
import { describe, expect, it } from 'vitest';
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
}

const AT = { x: FACE_CELL.x, y: FACE_CELL.y } as const;

const MALFORMED: readonly MalformedCase[] = [
  { why: 'not an object at all', message: null },
  { why: 'a bare string', message: 'sculpt' },
  { why: 'another message type', message: { type: 'nuke', ...AT, radius: 1, dir: 1 } },
  { why: 'a fractional x', message: sculptMessage({ ...AT, x: 1.5 }) },
  { why: 'an x past the world edge', message: sculptMessage({ ...AT, x: SCENARIO_WORLD_SIZE }) },
  { why: 'a negative y', message: sculptMessage({ ...AT, y: -1 }) },
  { why: 'a radius under the minimum', message: sculptMessage({ ...AT, radius: MIN_BRUSH_RADIUS - 1 }) },
  { why: 'a radius over the maximum', message: sculptMessage({ ...AT, radius: MAX_BRUSH_RADIUS + 1 }) },
  { why: 'a direction that is neither 1 nor -1', message: sculptMessage({ ...AT, dir: 2 }) },
  { why: 'a fractional seq', message: sculptMessage({ ...AT, seq: 1.5 }) },
  { why: 'an unknown tool', message: sculptMessage({ ...AT, tool: 'chisel' }) },
  { why: 'an unknown edge profile', message: sculptMessage({ ...AT, profile: 'medium' }) },
  {
    why: 'a carve asking to raise',
    message: sculptMessage({ ...AT, tool: 'carve', dir: 1, spanBand: 2 }),
  },
  {
    why: 'a targetBand below the lowest band',
    message: sculptMessage({ ...AT, tool: 'drag', targetBand: MIN_BAND - 1 }),
  },
  {
    why: 'a targetBand above the highest band',
    message: sculptMessage({ ...AT, tool: 'drag', targetBand: MAX_BAND + 1 }),
  },
  {
    why: 'a fractional targetBand',
    message: sculptMessage({ ...AT, tool: 'drag', targetBand: 2.5 }),
  },
  { why: 'a targetBand on a stamp', message: sculptMessage({ ...AT, targetBand: 2 }) },
  { why: 'a drag carrying no targetBand', message: sculptMessage({ ...AT, tool: 'drag' }) },
  {
    why: 'a spanBand below the lowest band',
    message: sculptMessage({ ...AT, tool: 'carve', dir: -1, spanBand: MIN_BAND - 1 }),
  },
  {
    why: 'a spanBand above the highest band',
    message: sculptMessage({ ...AT, tool: 'carve', dir: -1, spanBand: MAX_BAND + 1 }),
  },
  {
    why: 'a spanBand on a drag',
    message: sculptMessage({ ...AT, tool: 'drag', targetBand: 2, spanBand: 2 }),
  },
  { why: 'a carve carrying no spanBand', message: sculptMessage({ ...AT, tool: 'carve', dir: -1 }) },
  { why: 'a sweep origin on a stamp', message: sculptMessage({ ...AT, fromX: 4, fromY: 4 }) },
  {
    why: 'a half-named sweep origin',
    message: sculptMessage({ ...AT, tool: 'drag', targetBand: 2, fromX: 4 }),
  },
  {
    why: 'a fractional sweep origin',
    message: sculptMessage({ ...AT, tool: 'drag', targetBand: 2, fromX: 1.5, fromY: 4 }),
  },
  {
    why: 'a sweep origin past the world edge',
    message: sculptMessage({
      ...AT,
      tool: 'drag',
      targetBand: 2,
      fromX: SCENARIO_WORLD_SIZE,
      fromY: 4,
    }),
  },
  {
    why: 'a sweep longer than a chunk',
    message: sculptMessage({
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
  it.each(MALFORMED)('refuses $why', ({ message }) => {
    const scenario = openTerrace();
    const before = scenario.world.heightAt(FACE_CELL.x, FACE_CELL.y);

    const step = scenario.send(SCULPTOR, message);

    expect(step.outcome).toEqual({ applied: false, reason: 'malformed' });
    expect(scenario.world.dirty).toBe(false);
    expect(scenario.world.heightAt(FACE_CELL.x, FACE_CELL.y)).toBe(before);
    expect(entriesOfKind(step.entries, 'diff')).toHaveLength(0);
    expect(entriesOfKind(step.entries, 'ack')).toHaveLength(0);
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
      sculptMessage({ ...LIP_CELL, tool: 'drag', dir: 1, radius: 2, targetBand, seq: SEQ }),
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
});
