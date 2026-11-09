import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceFleet,
  livingBoats,
  resetFleet,
  restoreFleet,
  type BoatWorld,
} from '../server/fleet.ts';

const TICK_SECONDS = 0.1;
const WORLD_SIZE = 512;
const HOMES = [[39, 38], [39, 39]] as const;
const KRAKEN = { x: 130, y: 250 };

const FIXTURES = [
  {
    name: 'a headland beyond the former direct-routing range',
    isLand: (x: number, y: number) => x === 470 && y >= 180 && y <= 320,
    wallX: 470, launchX: 490, launchSpreadY: 8, timeoutSeconds: 300,
  },
  {
    name: 'a narrow channel after whole-hull route search exhausts its allowance',
    isLand: (x: number, y: number) => x === 250 && (y < 248 || y > 252),
    wallX: 250, launchX: 300, launchSpreadY: 0, timeoutSeconds: 200,
  },
];

afterEach(resetFleet);

describe('long-range combat dispatch', () => {
  it.each(FIXTURES)('gets both original boats into combat through $name', (fixture) => {
    const world: BoatWorld = {
      worldSize: WORLD_SIZE,
      heightAt: (x, y) =>
        fixture.isLand(x, y) ||
        HOMES.some(([hx, hy]) => x === hx && y === hy) ? 500 : -100,
      isCellUnlocked: () => true,
    };
    restoreFleet({
      villages: HOMES.map(([x, y]) => ({ x, y, rebuildSeconds: 0 })),
      boats: HOMES.map(([homeX, homeY], rank) => ({
        id: rank + 1, homeX, homeY,
        x: fixture.launchX + rank * 5, y: 250 + rank * fixture.launchSpreadY,
        heading: Math.PI, fighting: false,
      })),
      nextBoatId: HOMES.length + 1,
    });
    const crossed = new Set<number>();
    const engaged = new Set<number>();
    for (let tick = 0; tick < fixture.timeoutSeconds / TICK_SECONDS; tick++) {
      advanceFleet(world, KRAKEN, TICK_SECONDS);
      for (const boat of livingBoats()) {
        if (boat.id > HOMES.length) continue;
        if (boat.x < fixture.wallX) crossed.add(boat.id);
        if (boat.fighting) engaged.add(boat.id);
      }
      if (engaged.size === HOMES.length) break;
    }
    expect([...crossed].sort()).toEqual([1, 2]);
    expect([...engaged].sort()).toEqual([1, 2]);
  });
});
