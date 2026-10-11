import { beforeEach, describe, expect, it } from 'vitest';
import { forEachSweptCell, sweepAt, sweepBetween } from '@terrace/shared';
import {
  resetWards,
  stampWard,
  wardHolderAgainst,
  wardedCellCount,
} from '../server/ward.ts';

const WORLD_SIZE = 128;

const HOLDER = 'session-holder';

const ACTOR = 'session-actor';

const BRUSH_RADIUS = 4;

const LEG_FROM = { x: 20, y: 20 } as const;

const LEG_TO = { x: 60, y: 20 } as const;

/** Mid-leg, far outside the disc at either end. */
const MIDWAY_CELL = { x: 40, y: 20 } as const;

describe('a bedrock ward sees the whole swept shape', () => {
  beforeEach(() => {
    resetWards();
  });

  it('refuses a leg that starts and ends clear of the ward but crosses it', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepAt(MIDWAY_CELL.x, MIDWAY_CELL.y, 1));

    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, leg)).toBe(HOLDER);
  });

  it('lets the disc at either end of that leg through, which is why the disc alone missed it', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepAt(MIDWAY_CELL.x, MIDWAY_CELL.y, 1));

    for (const end of [LEG_FROM, LEG_TO]) {
      expect(wardHolderAgainst(WORLD_SIZE, ACTOR, sweepAt(end.x, end.y, BRUSH_RADIUS))).toBeNull();
    }
  });

  it('allows a leg that misses the ward by one cell', () => {
    const outside = { x: MIDWAY_CELL.x, y: MIDWAY_CELL.y + BRUSH_RADIUS };
    const inside = { x: MIDWAY_CELL.x, y: MIDWAY_CELL.y + BRUSH_RADIUS - 1 };
    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);

    stampWard(WORLD_SIZE, HOLDER, sweepAt(outside.x, outside.y, 1));
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, leg)).toBeNull();

    resetWards();
    stampWard(WORLD_SIZE, HOLDER, sweepAt(inside.x, inside.y, 1));
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, leg)).toBe(HOLDER);
  });

  it('never refuses its own holder', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepAt(MIDWAY_CELL.x, MIDWAY_CELL.y, 1));
    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);
    expect(wardHolderAgainst(WORLD_SIZE, HOLDER, leg)).toBeNull();
  });

  it('stamps every cell of the capsule a leg swept', () => {
    const leg = sweepBetween(LEG_FROM.x, LEG_FROM.y, LEG_TO.x, LEG_TO.y, BRUSH_RADIUS);
    stampWard(WORLD_SIZE, HOLDER, leg);

    let swept = 0;
    forEachSweptCell(leg, (x, y) => {
      swept++;
      expect(wardHolderAgainst(WORLD_SIZE, ACTOR, sweepAt(x, y, 1))).toBe(HOLDER);
    });
    expect(wardedCellCount()).toBe(swept);
    expect(swept).toBeGreaterThan(
      (() => {
        let disc = 0;
        forEachSweptCell(sweepAt(LEG_TO.x, LEG_TO.y, BRUSH_RADIUS), () => {
          disc++;
        });
        return disc;
      })(),
    );
  });

  it('clips a capsule that runs off the world', () => {
    stampWard(WORLD_SIZE, HOLDER, sweepBetween(0, 0, 0, 8, BRUSH_RADIUS));
    expect(wardedCellCount()).toBeGreaterThan(0);
    expect(wardHolderAgainst(WORLD_SIZE, ACTOR, sweepAt(0, 4, 1))).toBe(HOLDER);
  });
});
