// The steering contract: the route follower, the separation term, and the
// determinism both of them owe the rest of shared/.
//
// THE REGRESSION THESE PIN (owner, 2026-08-20: walkers "get stuck in the
// middle of nowhere", boats "spin on top of each other"). Both were one
// missing contract — see src/steering.ts's header — and the first test below
// is the exact 2-cycle traced out of the live world, reduced to the smallest
// terrain that reproduces it.

import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  LAND_WALKER_MAX_GRADIENT_PER_CELL,
  LAND_WALKER_PROFILE,
  findRoute,
  followRoute,
  steerAvoiding,
  withoutSelf,
  type Occupant,
  type RouteCell,
  type RoutedMover,
  type TerrainSampler,
} from '../src/index.ts';

/** Flat, walkable dry ground: band 1, well clear of the waterline fringe. */
const FLAT = BAND_HEIGHT;

/** The steepest single-cell step a land walker accepts, and one that is not.
 *  DERIVED, never restated as a literal: BAND_HEIGHT is a live tuning dial
 *  (it moved 64 → 16 while this file was being written), and a test pinned to
 *  absolute heights would silently start testing a different question. */
const LEGAL_STEP = LAND_WALKER_MAX_GRADIENT_PER_CELL;
const RISER = LAND_WALKER_MAX_GRADIENT_PER_CELL * 3;

/** Deep water — anything a land walker refuses on ground class alone. */
const SEA = -BAND_HEIGHT * 4;

/** A look-ahead far enough to leave the mover's own cell on ANY heading.
 *  At the shipped walker's 0.3 cells a diagonal probe lands 0.21 cells out,
 *  still inside the same cell, so no terrain beyond it is ever consulted —
 *  a real property of the tuning, and one a terrain test must step past to
 *  ask its question at all. */
const PROBE_PAST_CELL_CELLS = 1;

function world(size: number, heightAt: (x: number, y: number) => number = () => FLAT): TerrainSampler {
  return { worldSize: size, heightAt };
}

function mover(x: number, y: number, route: RouteCell[] | null, routeIndex = 0): RoutedMover {
  return { x, y, heading: 0, route, routeIndex };
}

/** One tick of a shipped walker: 0.5 cells/s at 10 Hz, probing 0.3 cells out. */
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
  /**
   * THE LIVE-WORLD 2-CYCLE, reduced. Heights lifted from the real cells around
   * the walker traced at (223.5, 232.2) in server/data/world.db snapshot #188:
   * the route runs north then north-west, both edges legal, but the DIAGONAL
   * SHORTCUT from the start cell to the third cell crosses a 44-unit riser the
   * profile refuses. The old follower skipped the middle waypoint (it sat
   * inside the 0.75-cell arrival radius), judged that shortcut, failed it,
   * replanned onto its own cell and walked back — forever.
   */
  function cliffWorld(): TerrainSampler {
    // x → 0 1 2  (the route runs right to left, i.e. 2 → 1 across two rows)
    const base = FLAT + RISER; // room to sit a riser either side of the route
    const heights: Record<string, number> = {
      '2,2': base, // the walker's cell
      '2,1': base + LEGAL_STEP, // due north — exactly at the limit, so legal
      '2,0': base + LEGAL_STEP * 2, // north again — legal from (2,1)
      '1,1': base + RISER, // THE RISER a diagonal shortcut would have to cross
      '1,0': base + RISER, // and its neighbour, so the westward diagonal is out
    };
    return {
      worldSize: 8,
      heightAt: (x, y) => heights[`${Math.floor(x)},${Math.floor(y)}`] ?? FLAT,
    };
  }

  /**
   * The route as A* emits it once the corner guard is honest (pathing.ts,
   * 2026-08-20): an ORTHOGONAL climb, because any diagonal off it would have
   * to pass through the riser at (1,1). Asserted below rather than assumed.
   */
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
    // One tick: the walker is 0.7 from route[1]'s centre — INSIDE the old
    // 0.75-cell arrival radius, which is exactly what used to skip it.
    walk(terrain, walker, 2.5, 0.5);
    expect(walker.routeIndex).toBe(0); // still in its own cell, so still index 0
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
    // One more step carries it over the y = 2 boundary into cell (2, 1).
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
    // 200 ticks × 0.05 cells is 10 cells of travel available; the whole route
    // is two. The old follower moved ±0.05 forever and never left its cell.
    expect(walker.y).toBeLessThan(startY - 0.5);
    expect(walker.routeIndex).toBeGreaterThan(0);
    expect(replans).toBe(0); // the route was legal all along — nothing to replan
  });
});

describe('followRoute — progress reporting', () => {
  it('reports progress on a detour that moves AWAY from the goal', () => {
    // A route whose first leg heads north while the goal is due east: the
    // straight-line-distance measure this replaces would call that no progress.
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

  it('reports no progress for a walker held still by terrain', () => {
    // An island one cell wide: every heading off it is water, so the sweep
    // finds nothing and the walker holds — which the give-up timer must see.
    //
    // Probed at PROBE_PAST_CELL_CELLS rather than the shipped walker's 0.3 —
    // see that constant on why 0.3 cannot see this island's shore at all.
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
    expect(walker.x).toBe(3.5);
  });

  it('degrades to steering at the goal when a route is cut and cannot be replanned', () => {
    // Route says go east; the cell east of the walker has since become water,
    // and so has everything else, so the replan fails too.
    const terrain = world(8, (x, y) => (Math.floor(x) === 1 && Math.floor(y) === 1 ? FLAT : SEA));
    const walker = mover(1.5, 1.5, [{ x: 1, y: 1 }, { x: 2, y: 1 }], 0);
    const result = walk(terrain, walker, 6.5, 1.5);
    expect(result.replanned).toBe(true);
    expect(walker.route).toBeNull();
    expect(result.progressed).toBe(false); // nowhere legal to go, so it holds
  });
});

/** Personal space used throughout the separation tests, and the gap two of
 *  them must hold: the shipped walker's own figure
 *  (pilgrims' WALKER_PERSONAL_SPACE_CELLS), stated here because `shared/` may
 *  not import a plugin's constant. */
const BODY_RADIUS_CELLS = 0.2;
const BODY_GAP_CELLS = BODY_RADIUS_CELLS * 2;

describe('steerAvoiding — separation', () => {
  it('refuses a heading that would put the mover inside somebody else', () => {
    const terrain = world(16);
    const walker = { x: 5.5, y: 5.5, heading: 0 };
    // Just inside the gap once the step is taken: stepping due east lands
    // BODY_GAP_CELLS − 0.05 from the blocker, which is a body overlap.
    const blocker: Occupant = {
      x: walker.x + WALK_STEP_CELLS + BODY_GAP_CELLS - 0.05,
      y: walker.y,
      radiusCells: BODY_RADIUS_CELLS,
    };
    const desired = 0; // due east, straight at the blocker
    const heading = steerAvoiding(terrain, LAND_WALKER_PROFILE, walker, desired, WALK_LOOKAHEAD_CELLS, {
      stepCells: WALK_STEP_CELLS,
      occupants: [blocker],
      selfRadiusCells: BODY_RADIUS_CELLS,
    });
    expect(heading).not.toBeNull();
    expect(heading).not.toBe(0);
    // Whatever it picked keeps the two bodies apart WHERE THE WALKER WILL BE.
    const stepX = walker.x + Math.cos(heading!) * WALK_STEP_CELLS;
    const stepY = walker.y + Math.sin(heading!) * WALK_STEP_CELLS;
    expect(Math.hypot(stepX - blocker.x, stepY - blocker.y)).toBeGreaterThanOrEqual(BODY_GAP_CELLS);
  });

  it('judges bodies at the STEP, not at the look-ahead — the 2026-08-21 defect', () => {
    // THE BUG, pinned. Separation used to be tested at the TERRAIN probe point,
    // which made it an accident of the ratio between a mover's look-ahead and
    // its body. It happened to work for the walker above (a 0.3-cell probe
    // against a 0.4-cell gap, so the probe point never left the exclusion
    // circle and the test read as "is anyone near me"). It was worth nothing at
    // all to a fast, small mover, whose probe point flies clean past every
    // neighbour: measured separation inside a school of five small fish was
    // 0.033 cells against a 0.42-cell gap — i.e. nothing — and 0.290 after this
    // fix, on the same 100-trial harness.
    //
    // The numbers below are that mover, the shipped small fish, restated here
    // because `shared/` may not import a plugin's constants: 3 cells/s at the
    // 10 Hz tick is a 0.3-cell step; its probe is max(body, speed × 0.6 s) =
    // 1.8 cells; its body is 0.7 cells scaled by the small class's 0.6, so its
    // half-extent is 0.21 and two of them hold 0.42. LAND_WALKER_PROFILE stands
    // in for its traversal rule — the question here is geometry, and flat
    // ground is flat ground.
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

    // (a) A body a full look-ahead away is 1.5 cells from where this mover will
    //     actually be — four gaps clear. It must not veto the heading. The old
    //     contract vetoed it outright: the probe point landed ON it.
    expect(steer(eastOf(FISH_LOOKAHEAD_CELLS))).toBe(0);

    // (b) A body 0.6 cells ahead IS in the way: one step east closes to 0.3,
    //     inside the 0.42 gap. The old contract waved it through, because the
    //     probe point sailed 1.2 cells past it. Turning aside clears it — the
    //     first 45° candidate steps to 0.442 away — so this is a genuine
    //     deflection, not the crowded second pass giving up on separation.
    const IN_THE_WAY_CELLS = 0.6;
    expect(IN_THE_WAY_CELLS - FISH_STEP_CELLS).toBeLessThan(FISH_GAP_CELLS); // it is a real overlap
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
    // Eight bodies ringing the walker one STEP out — close enough that every
    // candidate step point lands inside somebody, so every candidate is
    // crowded. The mover must still move: a deadlocked knot of walkers would be
    // the very bug this file fixes, wearing a hat.
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

    // Terrain is NOT relaxed on that second pass: a walker on a one-cell island
    // surrounded by bodies still refuses to walk into the sea. Probed at 1 cell
    // so the sweep can actually see past its own cell — see the "held still by
    // terrain" test above on why 0.3 cannot — while the ring stays at the step
    // distance, which is where separation is now judged, so the first pass
    // genuinely fails on CROWDING and the second one genuinely fails on
    // TERRAIN. Two different reasons, which is the whole point of the case.
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
    // "Only eastward of here is permitted" — the shape boats' unlocked-territory
    // rule and monsters' whole-body pose check both take.
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
    const b = { x: 1, y: 1, radiusCells: 0.2 }; // same place, different body
    expect(withoutSelf([a, b], a)).toEqual([b]);
  });
});
