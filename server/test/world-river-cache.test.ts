import { BAND_HEIGHT, CHUNK_SIZE, computeRiverNetwork, type SculptOptions } from '@terrace/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RIVER_RECOMPUTE_INTERVAL_MS } from '../src/world/world.ts';
import type { World } from '../src/world/world.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

const CHUNKS_PER_EDGE = 4;
const WORLD_SIZE = CHUNK_SIZE * CHUNKS_PER_EDGE;

const CHUNKS_EXCEPT_LAST_ROW = Array.from({ length: CHUNKS_PER_EDGE - 1 }, (_, cy) =>
  Array.from({ length: CHUNKS_PER_EDGE }, (_, cx) => [cx, cy] as const),
).flat();

const STAMP: SculptOptions = { tool: 'stamp' };

const SCULPTS_PER_TICK = 10;

const PEAK_BANDS = 6;

function fullRescan(world: World) {
  return computeRiverNetwork(world.map, {
    isActive: (x, y) => world.isCellUnlocked(x, y),
  });
}

function raisePeak(world: World, x: number, y: number, bands = PEAK_BANDS): void {
  world.applySculpt(x, y, 1, bands * BAND_HEIGHT, STAMP);
  world.applySculpt(x, y - 1, 1, (bands - 1) * BAND_HEIGHT, STAMP);
  world.applySculpt(x, y + 1, 1, (bands - 2) * BAND_HEIGHT, STAMP);
  world.applySculpt(x - 1, y, 1, (bands - 1) * BAND_HEIGHT, STAMP);
  world.applySculpt(x + 1, y, 1, (bands - 3) * BAND_HEIGHT, STAMP);
}

describe('World.riverNetwork caching', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recomputes once for many sculpts landing inside one tick', () => {
    vi.useFakeTimers();
    const world = worldWithUnlockedChunks(WORLD_SIZE, CHUNKS_EXCEPT_LAST_ROW);
    raisePeak(world, 8, 8);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    const warm = world.riverNetwork();
    expect(warm.rivers.length).toBeGreaterThan(0);

    for (let i = 0; i < SCULPTS_PER_TICK; i++) {
      world.applySculpt(8, 9 + i, 1, BAND_HEIGHT, STAMP);
      expect(world.riverNetwork()).toBe(warm);
      expect(world.freshwaterMap()).toBe(world.freshwaterMap());
    }

    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    const after = world.riverNetwork();
    expect(after).not.toBe(warm);
    expect(world.riverNetwork()).toBe(after);
  });

  it('serves exactly what a full rescan of the same terrain would say', () => {
    vi.useFakeTimers();
    const world = worldWithUnlockedChunks(WORLD_SIZE, CHUNKS_EXCEPT_LAST_ROW);

    raisePeak(world, 8, 8);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    expect(world.riverNetwork()).toEqual(fullRescan(world));

    raisePeak(world, 24, 20, PEAK_BANDS + 2);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    expect(world.riverNetwork()).toEqual(fullRescan(world));

    raisePeak(world, 8, 8, -PEAK_BANDS);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    expect(world.riverNetwork()).toEqual(fullRescan(world));
  });

  it('notices terrain that a chunk unlock has just made active', () => {
    vi.useFakeTimers();
    const world = worldWithUnlockedChunks(WORLD_SIZE, CHUNKS_EXCEPT_LAST_ROW);

    const lockedY = CHUNK_SIZE * (CHUNKS_PER_EDGE - 1) + 4;
    raisePeak(world, 8, lockedY);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    const beforeUnlock = world.riverNetwork();
    expect(beforeUnlock).toEqual(fullRescan(world));

    world.unlockChunk(0, CHUNKS_PER_EDGE - 1);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    expect(world.riverNetwork()).toEqual(fullRescan(world));
    expect(world.riverNetwork()).not.toBe(beforeUnlock);
  });

  it('serves a rewound world its rewound rivers, not the ones it had', () => {
    vi.useFakeTimers();
    const world = worldWithUnlockedChunks(WORLD_SIZE, CHUNKS_EXCEPT_LAST_ROW);
    const cellsBefore = world.heightsForPersistence();
    const maskBefore = Uint8Array.from(world.mask);

    raisePeak(world, 8, 8);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    expect(world.riverNetwork().rivers.length).toBeGreaterThan(0);

    world.rewindTo(cellsBefore, maskBefore);
    expect(world.riverNetwork()).toEqual(fullRescan(world));
  });
});
