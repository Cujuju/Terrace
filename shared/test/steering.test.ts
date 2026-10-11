import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  LAND_WALKER_PROFILE,
  findRoute,
  followRoute,
  normalizeAngle,
  steerAvoiding,
  withoutSelf,
  type Occupant,
  type RouteCell,
  type RoutedMover,
  type TerrainSampler,
} from '../src/index.ts';

const FLAT = BAND_HEIGHT;

const LEGAL_STEP = LAND_WALKER_MAX_GRADIENT_PER_CELL;
const RISER = LAND_WALKER_MAX_GRADIENT_PER_CELL * 3;

const SEA = -BAND_HEIGHT * 4;

const PROBE_PAST_CELL_CELLS = 1;

function world(size: number, heightAt: (x: number, y: number) => number = () => FLAT): TerrainSampler {
  return { worldSize: size, heightAt };
}

function mover(x: number, y: number, route: RouteCell[] | null, routeIndex = 0): RoutedMover {
  return { x, y, heading: 0, route, routeIndex };
}

const WALK_STEP_CELLS = 0.05;
const WALK_LOOKAHEAD_CELLS = 0.3;

function walk(
  terrain: TerrainSampler,
  walker: RoutedMover,
  goalX: number,
  goalY: number,
  occupants: readonly Occupant[] = [],
) {
  return followRoute(terrain, LAND_WALKER_PROFILE, walker, {
    stepCells: WALK_STEP_CELLS,
    lookaheadCells: WALK_LOOKAHEAD_CELLS,
    goalX,
    goalY,
    occupants,
    selfRadiusCells: occupants.length > 0 ? 0.2 : 0,
  });
}

describe('followRoute — the freeze this replaces', () => {
  function cliffWorld(): TerrainSampler {
    const base = FLAT + RISER;
    const heights: Record<string, number> = {
      '2,2': base,
      '2,1': base + LEGAL_STEP,
      '2,0': base + LEGAL_STEP * 2,
      '1,1': base + RISER,
      '1,0': base + RISER,
    };
    return {
      worldSize: 8,
      heightAt: (x, y) => heights[`${Math.floor(x)},${Math.floor(y)}`] ?? FLAT,
    };
  }

  const ROUTE: RouteCell[] = [
    { x: 2, y: 2 },
    { x: 2, y: 1 },
    { x: 2, y: 0 },
  ];

  it('is the route A* actually plans over this terrain', () => {
    const plan = findRoute(cliffWorld(), LAND_WALKER_PROFILE, { x: 2, y: 2 }, { x: 2, y: 0 });
    expect(plan?.cells).toEqual(ROUTE);
  });

  it('never targets a route cell it has not walked to', () => {
    const terrain = cliffWorld();
    const walker = mover(2.5, 2.2, [...ROUTE], 0);
    walk(terrain, walker, 2.5, 0.5);
    expect(walker.routeIndex).toBe(0);
  });

  it('advances only once the walker is actually in the next cell', () => {
    const terrain = world(8);
    const route: RouteCell[] = [
      { x: 2, y: 2 },
      { x: 2, y: 1 },
    ];
    const walker = mover(2.5, 2.02, route, 0);
    expect(walk(terrain, walker, 2.5, 1.5).progressed).toBe(false);
    expect(walker.routeIndex).toBe(0);
    const second = walk(terrain, walker, 2.5, 1.5);
    expect(Math.floor(walker.y)).toBe(1);
    expect(second.progressed).toBe(true);
    expect(walker.routeIndex).toBe(1);
  });

  it('makes real ground over the cliff route instead of oscillating', () => {
    const terrain = cliffWorld();
    const walker = mover(2.5, 2.5, [...ROUTE], 0);
    const startY = walker.y;
    let replans = 0;
    for (let tick = 0; tick < 200; tick++) {
      if (walk(terrain, walker, 2.5, 0.5).replanned) replans++;
    }
    expect(walker.y).toBeLessThan(startY - 0.5);
    expect(walker.routeIndex).toBeGreaterThan(0);
    expect(replans).toBe(0);
  });
});

describe('followRoute — progress reporting', () => {
  it('reports progress on a detour that moves AWAY from the goal', () => {
    const terrain = world(8);
    const route: RouteCell[] = [
      { x: 1, y: 2 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ];
    const walker = mover(1.5, 2.02, route, 0);
    const goalX = 6.5;
    const goalY = 2.5;
    const before = Math.hypot(goalX - walker.x, goalY - walker.y);
    let progressed = false;
    for (let tick = 0; tick < 4 && !progressed; tick++) {
      progressed = walk(terrain, walker, goalX, goalY).progressed;
    }
    expect(progressed).toBe(true);
    expect(Math.hypot(goalX - walker.x, goalY - walker.y)).toBeGreaterThan(before);
  });

  it('reports no progress for a walker marooned on one cell', () => {
    const terrain = world(8, (x, y) => (Math.floor(x) === 3 && Math.floor(y) === 3 ? FLAT : SEA));
    const walker = mover(3.5, 3.5, null);
    for (let tick = 0; tick < 10; tick++) {
      const result = followRoute(terrain, LAND_WALKER_PROFILE, walker, {
        stepCells: WALK_STEP_CELLS,
        lookaheadCells: PROBE_PAST_CELL_CELLS,
        goalX: 7.5,
        goalY: 3.5,
      });
      expect(result.progressed).toBe(false);
    }
    expect(Math.floor(walker.x)).toBe(3);
    expect(Math.floor(walker.y)).toBe(3);
  });

  it('degrades to steering at the goal when a route is cut and cannot be replanned', () => {
    const terrain = world(8, (x, y) => (Math.floor(x) === 1 && Math.floor(y) === 1 ? FLAT : SEA));
    const walker = mover(1.5, 1.5, [{ x: 1, y: 1 }, { x: 2, y: 1 }], 0);
    const result = walk(terrain, walker, 6.5, 1.5);
    expect(result.replanned).toBe(true);
    expect(walker.route).toBeNull();
    expect(result.progressed).toBe(false);
  });
});

const BODY_RADIUS_CELLS = 0.2;
const BODY_GAP_CELLS = BODY_RADIUS_CELLS * 2;

describe('steerAvoiding — separation', () => {
  it('refuses a heading that would put the mover inside somebody else', () => {
    const terrain = world(16);
    const walker = { x: 5.5, y: 5.5, heading: 0 };
    const blocker: Occupant = {
      x: walker.x + WALK_STEP_CELLS + BODY_GAP_CELLS - 0.05,
      y: walker.y,
      radiusCells: BODY_RADIUS_CELLS,
    };
    const desired = 0;
    const heading = steerAvoiding(terrain, LAND_WALKER_PROFILE, walker, desired, WALK_LOOKAHEAD_CELLS, {
      stepCells: WALK_STEP_CELLS,
      occupants: [blocker],
      selfRadiusCells: BODY_RADIUS_CELLS,
    });
    expect(heading).not.toBeNull();
    expect(heading).not.toBe(0);
    const stepX = walker.x + Math.cos(heading!) * WALK_STEP_CELLS;
    const stepY = walker.y + Math.sin(heading!) * WALK_STEP_CELLS;
    expect(Math.hypot(stepX - blocker.x, stepY - blocker.y)).toBeGreaterThanOrEqual(BODY_GAP_CELLS);
  });

  it('judges bodies at the STEP, not at the look-ahead — the 2026-08-21 defect', () => {
    const FISH_STEP_CELLS = 0.3;
    const FISH_LOOKAHEAD_CELLS = 1.8;
    const FISH_RADIUS_CELLS = 0.21;
    const FISH_GAP_CELLS = FISH_RADIUS_CELLS * 2;

    const terrain = world(16);
    const fish = { x: 5.5, y: 5.5, heading: 0 };
    const eastOf = (gap: number): Occupant => ({
      x: fish.x + gap,
      y: fish.y,
      radiusCells: FISH_RADIUS_CELLS,
    });
    const steer = (occupant: Occupant) =>
      steerAvoiding(terrain, LAND_WALKER_PROFILE, fish, 0, FISH_LOOKAHEAD_CELLS, {
        stepCells: FISH_STEP_CELLS,
        occupants: [occupant],
        selfRadiusCells: FISH_RADIUS_CELLS,
      });

    expect(steer(eastOf(FISH_LOOKAHEAD_CELLS))).toBe(0);

    const IN_THE_WAY_CELLS = 0.6;
    expect(IN_THE_WAY_CELLS - FISH_STEP_CELLS).toBeLessThan(FISH_GAP_CELLS);
    expect(steer(eastOf(IN_THE_WAY_CELLS))).not.toBe(0);
  });

  it('takes the desired heading when nobody is in the way', () => {
    const terrain = world(16);
    const walker = { x: 5.5, y: 5.5, heading: 0 };
    const far: Occupant = { x: 12, y: 12, radiusCells: BODY_RADIUS_CELLS };
    expect(
      steerAvoiding(terrain, LAND_WALKER_PROFILE, walker, 0, WALK_LOOKAHEAD_CELLS, {
        stepCells: WALK_STEP_CELLS,
        occupants: [far],
        selfRadiusCells: BODY_RADIUS_CELLS,
      }),
    ).toBe(0);
  });

  it('NEVER freezes a mover that is completely surrounded — crowding yields, terrain does not', () => {
    const terrain = world(16);
    const walker = { x: 8.5, y: 8.5, heading: 0 };
    const ringAt = (radiusCells: number): Occupant[] =>
      Array.from({ length: 8 }, (_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        return {
          x: walker.x + Math.cos(angle) * radiusCells,
          y: walker.y + Math.sin(angle) * radiusCells,
          radiusCells: BODY_RADIUS_CELLS,
        };
      });
    expect(
      steerAvoiding(terrain, LAND_WALKER_PROFILE, walker, 0, WALK_LOOKAHEAD_CELLS, {
        stepCells: WALK_STEP_CELLS,
        occupants: ringAt(WALK_STEP_CELLS),
        selfRadiusCells: BODY_RADIUS_CELLS,
      }),
    ).not.toBeNull();

    const island = world(16, (x, y) => (Math.floor(x) === 8 && Math.floor(y) === 8 ? FLAT : SEA));
    expect(
      steerAvoiding(island, LAND_WALKER_PROFILE, walker, 0, PROBE_PAST_CELL_CELLS, {
        stepCells: WALK_STEP_CELLS,
        occupants: ringAt(WALK_STEP_CELLS),
        selfRadiusCells: BODY_RADIUS_CELLS,
      }),
    ).toBeNull();
  });

  it('honours a caller\'s own extra veto', () => {
    const terrain = world(16);
    const walker = { x: 5.5, y: 5.5, heading: 0 };
    const heading = steerAvoiding(terrain, LAND_WALKER_PROFILE, walker, Math.PI, WALK_LOOKAHEAD_CELLS, {
      stepCells: WALK_STEP_CELLS,
      permits: (x) => x > walker.x,
    });
    expect(heading).not.toBeNull();
    expect(Math.cos(heading!)).toBeGreaterThan(0);
  });
});

describe('steering — determinism', () => {
  it('two identical runs produce byte-identical motion', () => {
    const rugged = world(48, (x, y) => FLAT + ((Math.floor(x) * 7 + Math.floor(y) * 13) % 3) * LEGAL_STEP);
    const plan = findRoute(rugged, LAND_WALKER_PROFILE, { x: 4, y: 4 }, { x: 30, y: 26 });
    expect(plan).not.toBeNull();

    const run = (): string => {
      const walker = mover(4.5, 4.5, [...plan!.cells], 0);
      const trace: string[] = [];
      for (let tick = 0; tick < 400; tick++) {
        const result = walk(rugged, walker, 30.5, 26.5);
        trace.push(`${walker.x.toFixed(12)},${walker.y.toFixed(12)},${walker.routeIndex},${result.progressed ? 1 : 0}`);
      }
      return trace.join('|');
    };
    expect(run()).toBe(run());
  });

  it('a mover\'s path does not depend on where it sits in the occupant list', () => {
    const terrain = world(16);
    const self = { x: 5.5, y: 5.5, heading: 0 };
    const crowd: Occupant[] = [
      { x: 5.6, y: 5.5, radiusCells: BODY_RADIUS_CELLS },
      { x: 5.5, y: 5.6, radiusCells: BODY_RADIUS_CELLS },
      { x: 5.4, y: 5.5, radiusCells: BODY_RADIUS_CELLS },
    ];
    const forward = steerAvoiding(terrain, LAND_WALKER_PROFILE, self, 0, WALK_LOOKAHEAD_CELLS, {
      stepCells: WALK_STEP_CELLS,
      occupants: crowd,
      selfRadiusCells: BODY_RADIUS_CELLS,
    });
    const reversed = steerAvoiding(terrain, LAND_WALKER_PROFILE, self, 0, WALK_LOOKAHEAD_CELLS, {
      stepCells: WALK_STEP_CELLS,
      occupants: [...crowd].reverse(),
      selfRadiusCells: BODY_RADIUS_CELLS,
    });
    expect(forward).toBe(reversed);
  });
});

describe('withoutSelf', () => {
  it('drops the mover by identity, not by position', () => {
    const a = { x: 1, y: 1, radiusCells: 0.2 };
    const b = { x: 1, y: 1, radiusCells: 0.2 };
    expect(withoutSelf([a, b], a)).toEqual([b]);
  });
});

describe('followRoute — turn-limited following', () => {
  it('clamps every heading change to maxTurnRadians and never pivots on the spot', () => {
    const TURN = 0.1;
    const terrain = world(16);
    const route: RouteCell[] = [
      { x: 2, y: 5 },
      { x: 3, y: 5 },
      { x: 4, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 5, y: 3 },
      { x: 5, y: 2 },
    ];
    const boat = mover(2.5, 5.5, [...route], 0);
    for (let tick = 0; tick < 300; tick++) {
      const beforeX = boat.x;
      const beforeY = boat.y;
      const beforeHeading = boat.heading;
      followRoute(terrain, LAND_WALKER_PROFILE, boat, {
        stepCells: 0.05,
        lookaheadCells: 1,
        goalX: 5.5,
        goalY: 2.5,
        maxTurnRadians: TURN,
      });
      expect(Math.abs(normalizeAngle(boat.heading - beforeHeading))).toBeLessThanOrEqual(
        TURN + 1e-12,
      );
      if (boat.x === beforeX && boat.y === beforeY) expect(boat.heading).toBe(beforeHeading);
    }
    expect(Math.hypot(boat.x - 5.5, boat.y - 2.5)).toBeLessThan(1);
  });
});

describe('followRoute — aim-ahead', () => {
  it('aims past the next cell and arrives sooner on an L-shaped route', () => {
    const terrain = world(16);
    const cells: RouteCell[] = [
      { x: 2, y: 5 },
      { x: 3, y: 5 },
      { x: 4, y: 5 },
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 6, y: 4 },
      { x: 6, y: 3 },
      { x: 6, y: 2 },
    ];
    const goalX = 6.5;
    const goalY = 2.5;
    const ticksToArrival = (aimAheadCells: number | undefined): number => {
      const walker = mover(2.5, 5.5, [...cells], 0);
      for (let tick = 0; tick < 2000; tick++) {
        if (
          followRoute(terrain, LAND_WALKER_PROFILE, walker, {
            stepCells: 0.2,
            lookaheadCells: 1,
            goalX,
            goalY,
            aimAheadCells,
          }).arrived
        ) {
          return tick;
        }
      }
      throw new Error('never arrived');
    };
    expect(ticksToArrival(6)).toBeLessThan(ticksToArrival(undefined));
  });
});
