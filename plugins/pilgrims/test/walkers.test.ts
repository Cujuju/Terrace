import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, FALL_DROP_HEIGHT_UNITS_PER_SECOND } from '@terrace/shared';
import {
  Pilgrimage,
  VIEWPOINT_RING_CELLS,
  WALKER_PANIC_SECONDS,
  advanceWalker,
  panicStep,
  startleWalkersNear,
  walkerHasArrived,
  type PanickingWalker,
  type Pilgrim,
  type PilgrimWorld,
} from '../server/pilgrimage.ts';

const TICK_SECONDS = 0.1;
const PANIC_TICKS = Math.ceil(WALKER_PANIC_SECONDS / TICK_SECONDS) + 1;
const LOW_GROUND = 2 * BAND_HEIGHT;
const HIGH_GROUND = 12 * BAND_HEIGHT;
const WALL_X = 128;
const WORLD: PilgrimWorld = {
  worldSize: 512,
  heightAt: (x) => x >= WALL_X ? HIGH_GROUND : LOW_GROUND,
};

function walker(id = 1, climbCount = 0): PanickingWalker {
  return {
    id, climbCount,
    x: WALL_X - 0.5, y: 100.5, heading: 0,
    goalX: WALL_X + 20.5, goalY: 100.5,
    route: [{ x: WALL_X - 1, y: 100 }, { x: WALL_X, y: 100 }],
    routeIndex: 0, climb: null,
    stillSeconds: 0, stillX: WALL_X - 0.5, stillY: 100.5,
    stuckSeconds: 0, panicSecondsRemaining: 0, panicFromX: 0, panicFromY: 0,
  };
}

function enterClimb(mover: PanickingWalker): void {
  for (let tick = 0; tick < 10 && mover.climb === null; tick++) {
    advanceWalker(WORLD, mover, TICK_SECONDS);
  }
  expect(mover.climb).not.toBeNull();
}

describe('walker movement modes', () => {
  it('advances a climb while panic time elapses without ground fleeing', () => {
    const mover = walker();
    enterClimb(mover);
    const originalX = mover.x;
    const originalHeight = mover.climb!.height;
    startleWalkersNear([mover], mover.x + 1, mover.y, 10);

    for (let tick = 0; tick < PANIC_TICKS; tick++) {
      if (!panicStep(WORLD, mover, TICK_SECONDS)) advanceWalker(WORLD, mover, TICK_SECONDS);
    }

    expect(mover.x).toBe(originalX);
    expect(mover.climb!.height).toBeGreaterThan(originalHeight);
    expect(mover.panicSecondsRemaining).toBe(0);
    advanceWalker(WORLD, mover, TICK_SECONDS);
    expect(mover.x).toBe(originalX);
  });

  it('lets a fatal fall finish during panic instead of suspending death', () => {
    const mover = walker();
    enterClimb(mover);
    mover.climb!.falling = true;
    mover.climb!.height = LOW_GROUND + FALL_DROP_HEIGHT_UNITS_PER_SECOND * TICK_SECONDS / 2;
    startleWalkersNear([mover], mover.x + 1, mover.y, 10);

    expect(panicStep(WORLD, mover, TICK_SECONDS)).toBe(false);
    expect(advanceWalker(WORLD, mover, TICK_SECONDS)).toBe('fell');
  });

  it('keeps ground fleeing and returns to the interrupted route', () => {
    const flat: PilgrimWorld = { ...WORLD, heightAt: () => LOW_GROUND };
    const mover = walker();
    startleWalkersNear([mover], mover.x + 1, mover.y, 10);
    const originalX = mover.x;
    for (let tick = 0; tick < PANIC_TICKS; tick++) panicStep(flat, mover, TICK_SECONDS);
    expect(mover.x).toBeLessThan(originalX);
    expect(mover.route).not.toBeNull();
    expect(mover.panicSecondsRemaining).toBe(0);
  });
});

describe('walker arrival', () => {
  it('requires matching support and a walkable approach inside the existing radius', () => {
    const mover = walker();
    mover.goalX = WALL_X + 0.5;
    expect(walkerHasArrived(WORLD, mover)).toBe(false);
    expect(walkerHasArrived({ ...WORLD, heightAt: () => LOW_GROUND }, mover)).toBe(true);

    const gap: PilgrimWorld = {
      ...WORLD,
      heightAt: (x) => x === WALL_X ? 0 : LOW_GROUND,
    };
    mover.goalX = WALL_X + 1.5;
    expect(walkerHasArrived(gap, mover)).toBe(false);
    enterClimb(mover);
    mover.goalX = mover.x;
    mover.goalY = mover.y;
    expect(walkerHasArrived(WORLD, mover)).toBe(false);
  });

  it('reaches the high viewpoint before beginning to linger', () => {
    const monster = { id: 1, x: 128, y: 128 };
    const wall = monster.x + VIEWPOINT_RING_CELLS;
    const world: PilgrimWorld = { ...WORLD, heightAt: (x) => x >= wall ? HIGH_GROUND : LOW_GROUND };
    const home = { x: wall - 16, y: monster.y };
    const sim = new Pilgrimage();
    let arrived = false;
    const JOURNEY_TICKS = 4000;
    for (let tick = 0; tick < JOURNEY_TICKS && !arrived; tick++) {
      sim.advance(world, [monster], [home], TICK_SECONDS);
      for (const walker of sim.walkers()) {
        const pilgrim = walker as Pilgrim;
        if (pilgrim.leg !== 'lingering') continue;
        expect(world.heightAt(Math.floor(pilgrim.x), Math.floor(pilgrim.y))).toBe(HIGH_GROUND);
        expect(pilgrim.climb).toBeNull();
        arrived = true;
      }
    }
    expect(arrived).toBe(true);
  });
});

describe('individual climb rolls', () => {
  it('mixes identity and climb count, once per climb, deterministically', () => {
    const movers = [walker(1), walker(2), walker(999), walker(1, 1), walker(1)];
    for (const mover of movers) enterClimb(mover);
    const seeds = movers.map((mover) => mover.climb!.visualId);
    expect(new Set(seeds.slice(0, 4)).size).toBe(4);
    expect(seeds[0]).toBe(seeds[4]);
    expect(movers[0].climbCount).toBe(1);
    expect(movers[3].climbCount).toBe(2);
    advanceWalker(WORLD, movers[0], TICK_SECONDS);
    expect(movers[0].climbCount).toBe(1);

    const approaching = walker();
    approaching.x = WALL_X - 0.9;
    advanceWalker(WORLD, approaching, TICK_SECONDS);
    expect(approaching.climb).toBeNull();
    expect(approaching.climbCount).toBe(0);
    enterClimb(approaching);
    expect(approaching.climbCount).toBe(1);
  });
});
