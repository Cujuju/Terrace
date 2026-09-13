import { describe, expect, it } from 'vitest';
import {
  MAX_DEBUG_CHAINS_PER_FRAME,
  MAX_DEBUG_SAILED_CELLS_PER_CHAIN,
  advanceWaypointChain,
  buildWaypointChain,
  createWaypointChain,
  groupArrived,
  memberTargetIndex,
  memberWaypoint,
  parseWaypointDebugFrame,
  resetWaypointChain,
  slotOffsetForMember,
  snapWaypointToWalkable,
  subdivideLeg,
  waypointChainComplete,
  waypointChainCurrent,
  waypointChainRemaining,
  waypointForMember,
  type TerrainSampler,
  type TraversalProfile,
  type Waypoint,
  type WaypointDebugFrame,
} from '../src/index.ts';

function chebyshev(a: Waypoint, b: Waypoint): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

describe('waypoint chain cursors', () => {
  it('starts at the first point with everything remaining', () => {
    const chain = createWaypointChain([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(waypointChainCurrent(chain)).toEqual({ x: 0, y: 0 });
    expect(waypointChainRemaining(chain)).toBe(2);
    expect(waypointChainComplete(chain)).toBe(false);
  });

  it('copies its input, so later caller edits cannot move the cursor target', () => {
    const points = [{ x: 4, y: 4 }];
    const chain = createWaypointChain(points);
    points[0].x = 999;
    expect(waypointChainCurrent(chain)).toEqual({ x: 4, y: 4 });
  });

  it('advances past every hop within radius, reporting progress once', () => {
    const chain = createWaypointChain([
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 1, y: 0 },
      { x: 50, y: 0 },
    ]);
    expect(advanceWaypointChain(chain, 0.8, 0, 1)).toBe(true);
    expect(chain.index).toBe(3);
    expect(waypointChainCurrent(chain)).toEqual({ x: 50, y: 0 });
    expect(advanceWaypointChain(chain, 0.8, 0, 1)).toBe(false);
  });

  it('completes only when the cursor leaves the last point', () => {
    const chain = createWaypointChain([{ x: 7, y: 7 }]);
    expect(waypointChainComplete(chain)).toBe(false);
    expect(advanceWaypointChain(chain, 7, 7, 1)).toBe(true);
    expect(waypointChainComplete(chain)).toBe(true);
    expect(waypointChainCurrent(chain)).toBeNull();
    expect(waypointChainRemaining(chain)).toBe(0);
  });

  it('treats an empty chain as complete with no current point', () => {
    const chain = createWaypointChain([]);
    expect(waypointChainComplete(chain)).toBe(true);
    expect(waypointChainCurrent(chain)).toBeNull();
    expect(advanceWaypointChain(chain, 0, 0, 1)).toBe(false);
  });

  it('resets to a clamped integer index', () => {
    const chain = createWaypointChain([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    advanceWaypointChain(chain, 0, 0, 0.5);
    expect(chain.index).toBe(1);
    resetWaypointChain(chain);
    expect(chain.index).toBe(0);
    resetWaypointChain(chain, 99);
    expect(chain.index).toBe(2);
  });
});

describe('subdivideLeg', () => {
  it('splits a 300-cell leg into hops of at most 96, ending on the goal', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 300, y: 40 };
    const hops = subdivideLeg(from, to, 96);
    expect(hops.length).toBe(4);
    expect(hops[hops.length - 1]).toEqual(to);
    let anchor = from;
    for (const hop of hops) {
      expect(chebyshev(anchor, hop)).toBeLessThanOrEqual(96);
      anchor = hop;
    }
  });

  it('returns the goal alone when the leg already fits', () => {
    expect(
      subdivideLeg({ x: 0, y: 0 }, { x: 10, y: 10 }, 96),
    ).toEqual([{ x: 10, y: 10 }]);
  });

  it('returns nothing for a coincident leg', () => {
    expect(subdivideLeg({ x: 5, y: 5 }, { x: 5, y: 5 }, 96)).toEqual([]);
  });

  it('is deterministic: identical inputs give identical hops', () => {
    const from = { x: 3, y: -7 };
    const to = { x: 260, y: 130 };
    expect(subdivideLeg(from, to, 96)).toEqual(subdivideLeg(from, to, 96));
  });
});

describe('buildWaypointChain', () => {
  it('expands coarse legs so every hop fits one budgeted search', () => {
    const hops = buildWaypointChain(
      { x: 0, y: 0 },
      [
        { x: 256, y: 0 },
        { x: 512, y: 100 },
      ],
      96,
    );
    expect(hops.length).toBeGreaterThan(2);
    expect(hops[hops.length - 1]).toEqual({ x: 512, y: 100 });
    let anchor: Waypoint = { x: 0, y: 0 };
    for (const hop of hops) {
      expect(chebyshev(anchor, hop)).toBeLessThanOrEqual(96);
      anchor = hop;
    }
  });

  it('returns nothing when given no legs', () => {
    expect(buildWaypointChain({ x: 0, y: 0 }, [], 96)).toEqual([]);
  });
});

describe('shared-path group cursors', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];

  it('stagger 0 is leader-follow; stagger N trails N hops behind', () => {
    expect(memberTargetIndex(points.length, 3, 0)).toBe(3);
    expect(memberTargetIndex(points.length, 3, 2)).toBe(1);
    expect(memberWaypoint(points, 3, 2)).toEqual({ x: 10, y: 0 });
  });

  it('clamps a trailing member to the start and a runaway leader to the end', () => {
    expect(memberTargetIndex(points.length, 1, 5)).toBe(0);
    expect(memberTargetIndex(points.length, 99, 0)).toBe(3);
  });

  it('reports null for an empty point list', () => {
    expect(memberTargetIndex(0, 0, 0)).toBeNull();
    expect(memberWaypoint([], 0, 0)).toBeNull();
  });
});

describe('slotOffsetForMember', () => {
  it('parks rank 0 on the goal itself', () => {
    expect(slotOffsetForMember(0, 2)).toEqual({ dx: 0, dy: 0 });
  });

  it('fans the first ring out instead of stacking', () => {
    const seen = new Set<string>();
    for (let rank = 0; rank < 9; rank++) {
      const offset = slotOffsetForMember(rank, 2);
      seen.add(`${offset.dx},${offset.dy}`);
    }
    expect(seen.size).toBe(9);
  });

  it('starts the first ring at the top-left corner, scaled by spacing', () => {
    expect(slotOffsetForMember(1, 2)).toEqual({ dx: -2, dy: -2 });
    expect(slotOffsetForMember(1, 5)).toEqual({ dx: -5, dy: -5 });
  });

  it('is deterministic across calls', () => {
    expect(slotOffsetForMember(14, 3)).toEqual(slotOffsetForMember(14, 3));
  });

  it('composes over a goal via waypointForMember', () => {
    expect(waypointForMember({ x: 100, y: 100 }, 0, 2)).toEqual({ x: 100, y: 100 });
    expect(waypointForMember({ x: 100, y: 100 }, 1, 2)).toEqual({ x: 98, y: 98 });
  });
});

describe('groupArrived', () => {
  it('all needs every member; any needs one; flagship needs the flagship', () => {
    expect(groupArrived([true, true], 'all')).toBe(true);
    expect(groupArrived([true, false], 'all')).toBe(false);
    expect(groupArrived([false, true], 'any')).toBe(true);
    expect(groupArrived([false, false], 'any')).toBe(false);
    expect(groupArrived([false, true], 'flagship')).toBe(false);
    expect(groupArrived([false, true], 'flagship', 1)).toBe(true);
  });

  it('never arrives with an empty group', () => {
    expect(groupArrived([], 'all')).toBe(false);
    expect(groupArrived([], 'any')).toBe(false);
    expect(groupArrived([], 'flagship')).toBe(false);
  });
});

describe('parseWaypointDebugFrame', () => {
  const frame: WaypointDebugFrame = {
    chains: [
      {
        id: 3,
        label: 'squadron 3',
        anchor: { x: 10.5, y: 20.5 },
        hops: [
          { x: 106, y: 20 },
          { x: 202, y: 20 },
        ],
        cursor: 1,
        members: 5,
        spacing: 3,
        sailed: [{ x: 60.5, y: 20.5 }],
      },
    ],
  };

  it('round-trips through JSON', () => {
    const revived = parseWaypointDebugFrame(JSON.parse(JSON.stringify(frame)));
    expect(revived).toEqual(frame);
  });

  it('rejects garbage and over-cap frames', () => {
    expect(parseWaypointDebugFrame(null)).toBeNull();
    expect(parseWaypointDebugFrame({})).toBeNull();
    expect(parseWaypointDebugFrame({ chains: 'nope' })).toBeNull();
    expect(
      parseWaypointDebugFrame({
        chains: [{ ...frame.chains[0], cursor: 99 }],
      }),
    ).toBeNull();
    expect(
      parseWaypointDebugFrame({
        chains: [{ ...frame.chains[0], hops: [{ x: NaN, y: 0 }] }],
      }),
    ).toBeNull();
    const tooMany = Array.from(
      { length: MAX_DEBUG_CHAINS_PER_FRAME + 1 },
      (_, id) => ({ ...frame.chains[0], id }),
    );
    expect(parseWaypointDebugFrame({ chains: tooMany })).toBeNull();
    const tooMuchSailed = Array.from(
      { length: MAX_DEBUG_SAILED_CELLS_PER_CHAIN + 1 },
      () => ({ x: 0, y: 0 }),
    );
    expect(
      parseWaypointDebugFrame({
        chains: [{ ...frame.chains[0], sailed: tooMuchSailed }],
      }),
    ).toBeNull();
  });
});

describe('snapWaypointToWalkable', () => {
  const LAND: TraversalProfile = {
    grounds: ['dry'],
    minGroundHeight: 1,
    freshwater: 'blocked',
    maxGradientPerCell: 2,
  };
  const worldAt = (walkable: (x: number, y: number) => boolean): TerrainSampler => ({
    worldSize: 32,
    heightAt: (x, y) => (walkable(x, y) ? 8 : -8),
  });

  it('returns the point unchanged when its own cell is walkable', () => {
    const world = worldAt(() => true);
    expect(snapWaypointToWalkable(world, LAND, 10.2, 11.7, 4)).toEqual({
      x: 10.2,
      y: 11.7,
    });
  });

  it('slides to the first walkable ring cell in fixed order', () => {
    const world = worldAt((x, y) => x === 9 && y === 9);
    expect(snapWaypointToWalkable(world, LAND, 10.2, 10.8, 4)).toEqual({
      x: 9.5,
      y: 9.5,
    });
    expect(snapWaypointToWalkable(world, LAND, 10.2, 10.8, 4)).toEqual(
      snapWaypointToWalkable(world, LAND, 10.2, 10.8, 4),
    );
  });

  it('returns the point unchanged when nothing within radius is walkable', () => {
    const world = worldAt(() => false);
    expect(snapWaypointToWalkable(world, LAND, 10.2, 10.8, 4)).toEqual({
      x: 10.2,
      y: 10.8,
    });
  });

  it('a zero radius never leaves the starting cell', () => {
    const world = worldAt((x, y) => x === 11 && y === 10);
    expect(snapWaypointToWalkable(world, LAND, 10.2, 10.8, 0)).toEqual({
      x: 10.2,
      y: 10.8,
    });
  });
});
