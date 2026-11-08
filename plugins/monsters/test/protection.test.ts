import { describe, expect, it } from 'vitest';
import { MAX_DRAG_SWEEP_CELLS, strokeWriteSweep, type SculptIntent } from '@terrace/shared';
import { reachesProtectedGround } from '../server/protection.ts';
import { groundProtectionRadiusCells, profileOf } from '../server/kinds.ts';
import type { Monster } from '../server/summoning.ts';

const GUARDING_KIND = 'cthulhu';

const BRUSH_RADIUS = 4;

const LEG_FROM = { x: 20, y: 20 } as const;

const LEG_TO = { x: LEG_FROM.x + MAX_DRAG_SWEEP_CELLS, y: 20 } as const;

const MIDWAY = { x: (LEG_FROM.x + LEG_TO.x) / 2, y: 20 } as const;

function monsterAt(x: number, y: number): Monster {
  return {
    id: 1,
    kind: GUARDING_KIND,
    x,
    y,
    heading: 0,
    idle: true,
    climb: null,
    stillSeconds: 0,
    stillX: x,
    stillY: y,
  };
}

function raise(from: { x: number; y: number } | null): SculptIntent {
  return {
    type: 'sculpt',
    x: LEG_TO.x,
    y: LEG_TO.y,
    radius: BRUSH_RADIUS,
    dir: 1,
    tool: 'stamp',
    profile: 'hard',
    ...(from === null ? {} : { tool: 'drag', targetBand: 3, fromX: from.x, fromY: from.y }),
  };
}

const REACH = strokeWriteSweep(raise(LEG_FROM)).radius + groundProtectionRadiusCells(profileOf(GUARDING_KIND));

/** Off the leg's flank: inside the capsule, outside the disc at either end. */
const FLANK_STANDOFF = REACH - 0.5;

describe('ground protection sees the whole swept shape', () => {
  it.each(['soft', 'stepped'] as const)('protects ground reached by %s mound flanks', (profile) => {
    const centre = { x: 48, y: 48 };
    const outsideCore = monsterAt(centre.x + 25.5, centre.y + 0.5);
    const stamp: SculptIntent = { type: 'sculpt', ...centre, radius: BRUSH_RADIUS, dir: 1, tool: 'stamp', profile };
    expect(reachesProtectedGround(stamp, outsideCore)).toBe(true);
    expect(reachesProtectedGround({ ...stamp, profile: 'hard' }, outsideCore)).toBe(false);
  });
  it('blocks a leg that only meets the monster off its flank', () => {
    const monster = monsterAt(MIDWAY.x + 0.5, MIDWAY.y + 0.5 + FLANK_STANDOFF);
    expect(reachesProtectedGround(raise(LEG_FROM), monster)).toBe(true);
  });

  it('is why the disc at the leg end alone let it through', () => {
    const monster = monsterAt(MIDWAY.x + 0.5, MIDWAY.y + 0.5 + FLANK_STANDOFF);
    expect(reachesProtectedGround(raise(null), monster)).toBe(false);
    expect(reachesProtectedGround({ ...raise(null), x: LEG_FROM.x, y: LEG_FROM.y }, monster)).toBe(
      false,
    );
  });

  it('keeps the same reach off the flank of a leg as around a press', () => {
    const justInside = monsterAt(MIDWAY.x + 0.5, MIDWAY.y + 0.5 + REACH - 0.01);
    const justOutside = monsterAt(MIDWAY.x + 0.5, MIDWAY.y + 0.5 + REACH + 0.01);
    expect(reachesProtectedGround(raise(LEG_FROM), justInside)).toBe(true);
    expect(reachesProtectedGround(raise(LEG_FROM), justOutside)).toBe(false);
  });

  it('still ignores a lowering stroke', () => {
    const monster = monsterAt(MIDWAY.x + 0.5, MIDWAY.y + 0.5);
    expect(reachesProtectedGround(raise(LEG_FROM), monster)).toBe(true);
    expect(reachesProtectedGround({ ...raise(LEG_FROM), dir: -1 }, monster)).toBe(false);
  });
});
