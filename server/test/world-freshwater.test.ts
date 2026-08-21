// THE FRESHWATER AXIS, END TO END — from the World's river network to the
// verdict a land walker gets back from `shared/`'s traversal predicate.
//
// WHY THIS SUITE EXISTS. `shared/src/traversal.ts` gained a freshwater axis on
// 2026-08-20 so the owner's rule — "terrestrial monsters should only be able
// to traverse the rivers, not the lakes", and land walkers going round a lake
// at all — could be WRITTEN DOWN. It was written down and then nothing
// supplied a map: `TerrainSampler.freshwater` is optional, its absent-default
// is NO_FRESHWATER, and every mover in the running game was reading that
// default. The rule was expressible and inert. These tests are what makes the
// difference observable: each one fails if the supply chain (World →
// freshwaterMap → WorldApi.freshwater → isWalkableCell) is broken at any link,
// including by the axis quietly reverting to its vacuous default.

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

// Four chunks to a side, whatever a chunk is sampled at (2026-08-21: the
// re-sample kept CHUNK_SIZE at 16 cells and shrank what a chunk covers, so a
// four-chunk world is smaller ground than it was — which is fine here: every
// assertion in this suite is about chunk mechanics, not about distances.)
const WORLD_SIZE = CHUNK_SIZE * 4;
/** Every chunk of a 64-cell world (CHUNK_SIZE 16 → 4×4), so nothing is scoped out. */
const ALL_CHUNKS = [0, 1, 2, 3].flatMap((cy) => [0, 1, 2, 3].map((cx) => [cx, cy] as const));

/** A radius-1 stamp writes exactly its one cell, with no falloff and no relaxation. */
const STAMP: SculptOptions = { tool: 'stamp' };

/** The spring cell of the ridge `worldWithRiver` carves, well inside the world. */
const SPRING = { x: 20, y: 20 };

/**
 * A world whose only relief is a one-cell peak with a downhill side — enough
 * for `computeRiverNetwork` to seed a spring and trace a course.
 *
 * Built through `applySculpt`, not by poking `map.cells`, for the reason
 * plugins/mana/test/mana.test.ts gives: the sculpt path is what marks the
 * river cache stale, so a test that writes cells directly would be asserting
 * against a cache that never noticed the terrain moved.
 */
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

    // The fixture is only useful if it actually made a river.
    const points = network.rivers.flatMap((river) => riverPoints(river));
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      // Pool beats channel where a cell is both (freshwater.ts) — so a pooled
      // point pins the answer exactly, and a flowing one only rules out 'none'.
      const answer = freshwater.at(point.x, point.y);
      if (point.pooled) expect(answer).toBe('pool');
      else expect(answer).not.toBe('none');
    }

    // A cell no river touches is dry, not merely "not a pool".
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
    // Identity, not equality: the cache is keyed on the network object, so a
    // second build would mean the transpose is being paid for per query — the
    // exact cost freshwater.ts exists to avoid.
    expect(world.freshwaterMap()).toBe(world.freshwaterMap());
  });

  it('rebuilds once the network recomputes after a sculpt', () => {
    vi.useFakeTimers();
    const world = worldWithRiver();
    const before = world.freshwaterMap();

    // Flatten the ridge back to sea level: the spring's local maximum is gone,
    // so the course it fed is gone with it. `amount` is a DELTA (heightmap.ts's
    // applyBrush), so undoing the fixture means the negatives of what it raised
    // — an amount of 0 would change nothing and never mark the cache stale,
    // which is the same no-op this test would then be asserting against.
    world.applySculpt(SPRING.x, SPRING.y, 1, -4 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x, SPRING.y - 1, 1, -3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x, SPRING.y + 1, 1, -3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x - 1, SPRING.y, 1, -3 * BAND_HEIGHT, STAMP);
    world.applySculpt(SPRING.x + 1, SPRING.y, 1, -2 * BAND_HEIGHT, STAMP);
    // `riverNetwork()` throttles on WALL CLOCK (RIVER_RECOMPUTE_INTERVAL_MS),
    // so the window has to be advanced before the sculpt can be reflected.
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
    // Built BEFORE any river exists — the ordering that catches a snapshot.
    const api = createWorldApi(world, listener, 'test');
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
    const api = createWorldApi(world, listener, 'test');

    // A river cell that is DRY GROUND well clear of the waterline — so the only
    // thing that can refuse it is the freshwater axis, not the ground class and
    // not LAND_WALKER_MIN_GROUND_HEIGHT.
    const wet = world
      .riverNetwork()
      .rivers.flatMap((river) => riverPoints(river))
      .find((point) => world.heightAt(point.x, point.y) >= BAND_HEIGHT);
    expect(wet).toBeDefined();

    // The payoff. Same cell, same profile: refused with the map, allowed
    // without it — which is precisely the state the whole game was in while
    // nothing supplied one.
    expect(isWalkableCell(api, LAND_WALKER_PROFILE, wet!.x, wet!.y)).toBe(false);
    const noRivers = { worldSize: api.worldSize, heightAt: (x: number, y: number) => world.heightAt(x, y) };
    expect(isWalkableCell(noRivers, LAND_WALKER_PROFILE, wet!.x, wet!.y)).toBe(true);
  });
});
