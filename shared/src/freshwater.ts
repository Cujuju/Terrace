import { riverPoints, type RiverNetwork } from './rivers.ts';

export type Freshwater = 'none' | 'channel' | 'pool';

export interface FreshwaterMap {
  at(x: number, y: number): Freshwater;
}

export const NO_FRESHWATER: FreshwaterMap = {
  at: (): Freshwater => 'none',
};

export function buildFreshwaterMap(network: RiverNetwork, worldSize: number): FreshwaterMap {
  const channels = new Set<number>();
  const pools = new Set<number>();

  for (const river of network.rivers) {
    for (const point of riverPoints(river)) {
      const key = point.y * worldSize + point.x;
      if (point.pooled) pools.add(key);
      else channels.add(key);
    }
  }

  return {
    at(x: number, y: number): Freshwater {
      const key = Math.floor(y) * worldSize + Math.floor(x);
      if (pools.has(key)) return 'pool';
      return channels.has(key) ? 'channel' : 'none';
    },
  };
}
