// The freshwater transpose: what rivers.ts's per-river courses look like when
// asked the per-cell question traversal needs (src/freshwater.ts).

import { describe, expect, it } from 'vitest';
import { NO_FRESHWATER, buildFreshwaterMap, type RiverNetwork } from '../src/index.ts';

const WORLD_SIZE = 16;

describe('buildFreshwaterMap', () => {
  it('separates a flowing channel from a standing pool', () => {
    const network: RiverNetwork = {
      rivers: [
        {
          points: [
            { x: 1, y: 1, pooled: false },
            { x: 2, y: 1, pooled: false },
            { x: 3, y: 1, pooled: true, poolHeight: 40 },
          ],
          waterfalls: [],
          reachedSea: true,
          truncated: false,
        },
      ],
    };
    const map = buildFreshwaterMap(network, WORLD_SIZE);
    expect(map.at(1, 1)).toBe('channel');
    expect(map.at(2, 1)).toBe('channel');
    expect(map.at(3, 1)).toBe('pool');
    expect(map.at(9, 9)).toBe('none');
  });

  it('calls a cell that is both a pool AND a channel a pool', () => {
    // A basin's spillway is emitted twice — pooled, and as the cell the course
    // flows on through. Standing water is the stronger claim, and the answer
    // must not depend on which river was walked first.
    const spillwayFirstAsChannel: RiverNetwork = {
      rivers: [
        {
          points: [
            { x: 4, y: 4, pooled: false },
            { x: 4, y: 4, pooled: true, poolHeight: 12 },
          ],
          waterfalls: [],
          reachedSea: false,
          truncated: false,
        },
      ],
    };
    const spillwayFirstAsPool: RiverNetwork = {
      rivers: [
        {
          points: [
            { x: 4, y: 4, pooled: true, poolHeight: 12 },
            { x: 4, y: 4, pooled: false },
          ],
          waterfalls: [],
          reachedSea: false,
          truncated: false,
        },
      ],
    };
    expect(buildFreshwaterMap(spillwayFirstAsChannel, WORLD_SIZE).at(4, 4)).toBe('pool');
    expect(buildFreshwaterMap(spillwayFirstAsPool, WORLD_SIZE).at(4, 4)).toBe('pool');
  });

  it('floors fractional positions to their containing cell', () => {
    const network: RiverNetwork = {
      rivers: [{ points: [{ x: 7, y: 2, pooled: false }], waterfalls: [], reachedSea: true, truncated: false }],
    };
    const map = buildFreshwaterMap(network, WORLD_SIZE);
    expect(map.at(7.9, 2.1)).toBe('channel');
    expect(map.at(8.0, 2.1)).toBe('none');
  });

  it('NO_FRESHWATER answers "none" everywhere', () => {
    expect(NO_FRESHWATER.at(0, 0)).toBe('none');
    expect(NO_FRESHWATER.at(500, 500)).toBe('none');
  });
});
