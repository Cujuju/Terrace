import { describe, expect, it, beforeEach } from 'vitest';
import { BOAT_ENGAGEMENT_RANGE_CELLS } from '../protocol.ts';
import {
  advanceFleet,
  livingBoats,
  rememberVillage,
  resetFleet,
  type BoatWorld,
} from '../server/fleet.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tmpVoyageOf: (id: number) => any = () => null;
const fleetModule = (await import('../server/fleet.ts')) as unknown as Record<string, unknown>;
if (typeof fleetModule['tmpVoyageOf'] === 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tmpVoyageOf = fleetModule['tmpVoyageOf'] as (id: number) => any;
}

const WORLD_SIZE = 128;
const TICK_DT = 0.1;
const VILLAGE_X = 39;
const VILLAGE_Y = 38;

function seaWorld(land: ReadonlyArray<readonly [number, number]>): BoatWorld {
  const dry = new Set(land.map(([x, y]) => `${x},${y}`));
  return {
    worldSize: WORLD_SIZE,
    heightAt: (x, y) => (dry.has(`${x},${y}`) ? 500 : -100),
    isCellUnlocked: () => true,
  };
}

beforeEach(() => {
  resetFleet();
});

describe('trace late engagement', () => {
  it('logs per-boat trajectories', () => {
    const world = seaWorld([
      [VILLAGE_X, VILLAGE_Y],
      [VILLAGE_X, VILLAGE_Y + 1],
      [VILLAGE_X + 1, VILLAGE_Y],
    ]);
    rememberVillage(VILLAGE_X, VILLAGE_Y);
    rememberVillage(VILLAGE_X, VILLAGE_Y + 1);
    rememberVillage(VILLAGE_X + 1, VILLAGE_Y);
    const kraken = { x: VILLAGE_X + BOAT_ENGAGEMENT_RANGE_CELLS - 1, y: VILLAGE_Y };
    // Build phase: no kraken.
    for (let n = 0; n < 200; n++) advanceFleet(world, null, TICK_DT);
    const ids = livingBoats().map((b) => b.id);
    const hist = new Map<number, Array<[number, number, boolean]>>();
    for (let n = 0; n < 110; n++) {
      advanceFleet(world, kraken, TICK_DT);
      for (const b of livingBoats()) {
        if (!hist.has(b.id)) hist.set(b.id, []);
        hist.get(b.id)!.push([b.x, b.y, b.fighting]);
      }
      if ((n === 79 || n === 89 || n === 99 || n === 109) && tmpVoyageOf(2) !== null) {
        const v = tmpVoyageOf(2)!;
        const b = livingBoats().find((x) => x.id === 2)!;
        console.log(
          `tick ${n} boat2 pos=${b.x.toFixed(1)},${b.y.toFixed(1)} route=${v.route} idx=${v.routeIndex} ` +
            `noprog=${v.noProgress.toFixed(1)} null=${v.nullSeconds.toFixed(1)} pool=${v.poolTried} ` +
            `goal=${v.goalX.toFixed(1)},${v.goalY.toFixed(1)}`,
        );
      }
    }
    for (const id of ids) {
      const h = hist.get(id) ?? [];
      const firstEngage = h.findIndex(([, , f]) => f);
      const d0 = Math.hypot(h[0][0] - kraken.x, h[0][1] - kraken.y).toFixed(1);
      const dN = Math.hypot(h[h.length - 1][0] - kraken.x, h[h.length - 1][1] - kraken.y).toFixed(1);
      const net = Math.hypot(
        h[h.length - 1][0] - h[0][0],
        h[h.length - 1][1] - h[0][1],
      ).toFixed(1);
      console.log(
        `boat ${id} engageTick=${firstEngage} distStart=${d0} distEnd=${dN} net=${net}`,
      );
      if (id === 2) {
        const boats = livingBoats();
        const b = boats.find((x) => x.id === id)!;
        const trail = h
          .filter((_, i) => i % 10 === 0)
          .map(
            ([x, y]) =>
              `${x.toFixed(1)},${y.toFixed(1)}:${Math.hypot(x - kraken.x, y - kraken.y).toFixed(1)}`,
          )
          .join(' ');
        console.log(`boat2 trail: ${trail} heading=${b.heading.toFixed(2)}`);
      }
    }
    expect(true).toBe(true);
  });
});
