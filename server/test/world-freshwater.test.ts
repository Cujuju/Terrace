import {
  BAND_HEIGHT,
  LAND_WALKER_PROFILE,
  isWalkableCell,
  riverPoints,
  type SculptOptions,
} from '@terrace/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE } from '@terrace/shared';
import { createWorldApi } from '../src/plugins/world-api.ts';
import { RIVER_RECOMPUTE_INTERVAL_MS } from '../src/world/world.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const ALL_CHUNKS = [0, 1, 2, 3].flatMap((cy) => [0, 1, 2, 3].map((cx) => [cx, cy] as const));

const STAMP: SculptOptions = { tool: 'stamp' };

const SPRING = { x: 20, y: 20 };

function worldWithRiver() {
  const world = worldWithUnlockedChunks(WORLD_SIZE, ALL_CHUNKS);
  world.applySculpt(SPRING.x, SPRING.y, 1, 4 * BAND_HEIGHT, STAMP);
  world.applySculpt(SPRING.x, SPRING.y - 1, 1, 3 * BAND_HEIGHT, STAMP);
  world.applySculpt(SPRING.x, SPRING.y + 1, 1, 3 * BAND_HEIGHT, STAMP);
  world.applySculpt(SPRING.x - 1, SPRING.y, 1, 3 * BAND_HEIGHT, STAMP);
  world.applySculpt(SPRING.x + 1, SPRING.y, 1, 2 * BAND_HEIGHT, STAMP);
  return world;
}

describe('World.freshwaterMap', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers for every point the river network emitted, and only those', () => {
    const world = worldWithRiver();
    const network = world.riverNetwork();
    const freshwater = world.freshwaterMap();

    const points = network.rivers.flatMap((river) => riverPoints(river));
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      const answer = freshwater.at(point.x, point.y);
      if (point.pooled) expect(answer).toBe('pool');
      else expect(answer).not.toBe('none');
    }

    const river = new Set(points.map((point) => point.y * WORLD_SIZE + point.x));
    let checked = 0;
    for (let y = 0; y < WORLD_SIZE && checked < 64; y++) {
      for (let x = 0; x < WORLD_SIZE && checked < 64; x++) {
        if (river.has(y * WORLD_SIZE + x)) continue;
        expect(freshwater.at(x, y)).toBe('none');
        checked++;
      }
    }
    expect(checked).toBe(64);
  });

  it('serves the same map object while the network it transposes is unchanged', () => {
    const world = worldWithRiver();
    expect(world.freshwaterMap()).toBe(world.freshwaterMap());
  });

  it('rebuilds once the network recomputes after a sculpt', () => {
    vi.useFakeTimers();
    const world = worldWithRiver();
    const before = world.freshwaterMap();

    world.applySculpt(SPRING.x, SPRING.y, 1, -4 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x, SPRING.y - 1, 1, -3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x, SPRING.y + 1, 1, -3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x - 1, SPRING.y, 1, -3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x + 1, SPRING.y, 1, -2 * BAND_HEIGHT, STAMP);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);

    const after = world.freshwaterMap();
    expect(after).not.toBe(before);
    expect(after.at(SPRING.x, SPRING.y)).toBe('none');
  });
});

describe('WorldApi.freshwater', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads through to the world at the moment it is asked, not at build time', () => {
    vi.useFakeTimers();
    const world = worldWithUnlockedChunks(WORLD_SIZE, ALL_CHUNKS);
    const listener = {
      notifyTerrainChanged: () => {},
      notifyChunkUnlockedForToken: () => {},
      notifyWorldEvent: () => {},
    };
    const api = createWorldApi(world, listener, 'test').api;
    expect(api.freshwater.at(SPRING.x, SPRING.y)).toBe('none');

    world.applySculpt(SPRING.x, SPRING.y, 1, 4 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x, SPRING.y - 1, 1, 3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x, SPRING.y + 1, 1, 3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x - 1, SPRING.y, 1, 3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x + 1, SPRING.y, 1, 2 * BAND_HEIGHT, STAMP);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);

    const wet = world
      .riverNetwork()
      .rivers.flatMap((river) => riverPoints(river))
      .find((point) => world.heightAt(point.x, point.y) >= BAND_HEIGHT);
    expect(wet).toBeDefined();
    expect(api.freshwater.at(wet!.x, wet!.y)).not.toBe('none');
  });

  it('makes a land walker decline a river cell it would otherwise accept', () => {
    vi.useFakeTimers();
    const world = worldWithRiver();
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    const listener = {
      notifyTerrainChanged: () => {},
      notifyChunkUnlockedForToken: () => {},
      notifyWorldEvent: () => {},
    };
    const api = createWorldApi(world, listener, 'test').api;

    const wet = world
      .riverNetwork()
      .rivers.flatMap((river) => riverPoints(river))
      .find((point) => world.heightAt(point.x, point.y) >= BAND_HEIGHT);
    expect(wet).toBeDefined();

    expect(isWalkableCell(api, LAND_WALKER_PROFILE, wet!.x, wet!.y)).toBe(false);
    const noRivers = { worldSize: api.worldSize, heightAt: (x: number, y: number) => world.heightAt(x, y) };
    expect(isWalkableCell(noRivers, LAND_WALKER_PROFILE, wet!.x, wet!.y)).toBe(true);
  });
});
