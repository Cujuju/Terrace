// THE RIVER CACHE'S TWO PROMISES — issue #235.
//
// A sim plugin that sculpts (mudslides, storm surge, volcanoes) drives terrain
// changes at the tick rate with nobody touching anything, and every one of
// them lands on the World's river cache. Two things have to hold for that to
// be affordable, and this suite is where both are written down:
//
//   1. COALESCED. However many sculpts arrive between two recomputes, the
//      readers between them share ONE network. The proof used here is object
//      identity — but since #226 a recompute that finds no river to re-trace
//      hands BACK the same object, so the fixture below sculpts terrain a
//      river actually runs over: identity proves "no recompute" only where a
//      recompute would have produced a different network.
//
//   2. HONEST. The cached network is byte-identical to what a full rescan of
//      the same terrain, under the same unlock mask, would have produced —
//      after sculpts, and after a chunk unlock, which widens the active area
//      and can therefore add springs the previous scan could not see.
//
// The second promise is what makes the first affordable to keep: the cache is
// fed by an incremental SpringIndex (shared/src/rivers.ts) instead of by a
// worldSize² rescan, and a stale index would be invisible without this test.

import { BAND_HEIGHT, CHUNK_SIZE, computeRiverNetwork, type SculptOptions } from '@terrace/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RIVER_RECOMPUTE_INTERVAL_MS } from '../src/world/world.ts';
import type { World } from '../src/world/world.ts';
import { worldWithUnlockedChunks } from './support/harness.ts';

/** Four chunks to a side; the last column of chunks is what the unlock tests reveal. */
const CHUNKS_PER_EDGE = 4;
const WORLD_SIZE = CHUNK_SIZE * CHUNKS_PER_EDGE;

/** Every chunk but the bottom row — leaves somewhere for a later unlock to reach. */
const CHUNKS_EXCEPT_LAST_ROW = Array.from({ length: CHUNKS_PER_EDGE - 1 }, (_, cy) =>
  Array.from({ length: CHUNKS_PER_EDGE }, (_, cx) => [cx, cy] as const),
).flat();

/** A radius-1 stamp writes exactly its one cell, with no falloff and no relaxation. */
const STAMP: SculptOptions = { tool: 'stamp' };

/**
 * How many sculpts one "tick" of this suite fires. Ten is the shape the issue
 * reports — a mudslide's advance step sculpts repeatedly inside a single
 * server tick (plugins/mudslides/server/slides.ts) — and any number > 1 proves
 * the same thing.
 */
const SCULPTS_PER_TICK = 10;

/** The peak the fixtures raise, in whole terrace bands above its surroundings. */
const PEAK_BANDS = 6;

/** What a full rescan of this world says right now — the cache's reference answer. */
function fullRescan(world: World) {
  return computeRiverNetwork(world.map, {
    isActive: (x, y) => world.isCellUnlocked(x, y),
  });
}

/** Raises a cone at (x, y): a strict local maximum, so a spring can seed on it. */
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
    // A spring, so the sculpts below have a river to move. Without one the
    // network is empty however the terrain changes, and since #226 an
    // unchanged network is returned as the same object — which would make the
    // identity check below pass for the wrong reason.
    raisePeak(world, 8, 8);
    // Past the throttle window and read once, so the cache is warm and the
    // count below is about coalescing rather than about the first-ever build.
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    const warm = world.riverNetwork();
    expect(warm.rivers.length).toBeGreaterThan(0);

    // A whole tick's worth of sculpts, each read back the way a plugin's
    // onTerrainChanged listener would read it (wildlife via freshwater, mana
    // via riverNetwork) — no wall-clock time passes inside a tick.
    for (let i = 0; i < SCULPTS_PER_TICK; i++) {
      world.applySculpt(8, 9 + i, 1, BAND_HEIGHT, STAMP);
      expect(world.riverNetwork()).toBe(warm);
      expect(world.freshwaterMap()).toBe(world.freshwaterMap());
    }

    // …and exactly one recompute once the window opens, however many sculpts
    // it has to account for.
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

    // A second peak, higher, somewhere else: the spring ranking has to move.
    raisePeak(world, 24, 20, PEAK_BANDS + 2);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    expect(world.riverNetwork()).toEqual(fullRescan(world));

    // And the first peak flattened away again: a spring must be able to LEAVE
    // the set, not only join it.
    raisePeak(world, 8, 8, -PEAK_BANDS);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    expect(world.riverNetwork()).toEqual(fullRescan(world));
  });

  it('notices terrain that a chunk unlock has just made active', () => {
    vi.useFakeTimers();
    const world = worldWithUnlockedChunks(WORLD_SIZE, CHUNKS_EXCEPT_LAST_ROW);

    // A peak inside the still-locked bottom chunk row. Written straight into
    // the heightmap, because `applySculpt` refuses nothing here but the point
    // is terrain that exists before anyone may see it — exactly what genesis
    // leaves behind the reveal frontier.
    const lockedY = CHUNK_SIZE * (CHUNKS_PER_EDGE - 1) + 4;
    raisePeak(world, 8, lockedY);
    vi.advanceTimersByTime(RIVER_RECOMPUTE_INTERVAL_MS);
    const beforeUnlock = world.riverNetwork();
    expect(beforeUnlock).toEqual(fullRescan(world));

    // Unlocking widens the active area. Nothing sculpts here — if the unlock
    // did not invalidate the cache on its own, the next reader would be served
    // a network that cannot see the newly revealed peak.
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

    // A rewind reports no diff at all, so the index cannot learn what moved —
    // it has to be told the whole terrain is new.
    world.rewindTo(cellsBefore, maskBefore);
    expect(world.riverNetwork()).toEqual(fullRescan(world));
  });
});
