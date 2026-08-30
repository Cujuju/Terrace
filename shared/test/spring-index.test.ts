// THE SPRING INDEX'S ONE CONTRACT: it is a cache, and a cache that ever
// disagrees with the thing it caches is a bug, not an optimisation.
//
// `SpringIndex` exists so a river refresh costs what the terrain CHANGE cost
// rather than what the WORLD costs (issue #235: `selectSprings` rescanned all
// worldSize² cells on every refresh, ~48 ms on a 2048² world, four times a
// second for as long as anything was sculpting). The whole safety of that
// trade rests on one property — the incrementally maintained candidate set is
// EXACTLY the set a full rescan would produce — so every test here compares
// the index's answer against `computeRiverNetwork`, which still does the full
// rescan, over terrain that has been battered in every way the server can
// batter it: single cells, whole regions, height rises, height falls, and
// chunks of the world becoming active after the fact.

import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  cellIndex,
  computeRiverNetwork,
  computeRiverNetworkFromSprings,
  createHeightmap,
  SEA_LEVEL,
  SpringIndex,
  type Heightmap,
} from '../src/index.ts';

/** Big enough to hold real relief, small enough that a full rescan per assertion is free. */
const WORLD_SIZE = 64;

/**
 * Iterations of the randomized sculpt sweep. High enough that the sequence
 * visits every interesting transition (a cell becoming a candidate, ceasing to
 * be one, and knocking a NEIGHBOUR in or out) many times over; low enough that
 * the full-rescan reference it is checked against stays cheap.
 */
const SCULPT_ITERATIONS = 400;

/** Fixed seed: the sweep must replay identically on every machine and every run. */
const SCULPT_SEED = 0x5eed_1235;

/** A 32-bit LCG (Numerical Recipes' constants) — reproducible, and nothing here is cryptographic. */
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_MODULUS = 2 ** 32;

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
}

/** The relief the sweep starts from: a broad hill, well clear of the spring height floor. */
function hillMap(size: number): Heightmap {
  const map = createHeightmap(size);
  const centre = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.max(Math.abs(x - centre), Math.abs(y - centre));
      const bands = Math.max(0, size / 2 - distance);
      map.cells[cellIndex(map, x, y)] = SEA_LEVEL + bands * BAND_HEIGHT;
    }
  }
  return map;
}

/**
 * The assertion every test in this file makes: the network built from the
 * INDEX's springs is indistinguishable from the network built by a full
 * rescan of the same map under the same activity predicate.
 */
function expectIndexAgreesWithFullScan(
  map: Heightmap,
  index: SpringIndex,
  isActive: (x: number, y: number) => boolean,
): void {
  expect(computeRiverNetworkFromSprings(map, index.springs(), isActive)).toEqual(
    computeRiverNetwork(map, { isActive }),
  );
}

describe('SpringIndex', () => {
  const alwaysActive = (): boolean => true;

  it('names the same springs as a full rescan before anything has changed', () => {
    const map = hillMap(WORLD_SIZE);
    expectIndexAgreesWithFullScan(map, new SpringIndex(map, alwaysActive), alwaysActive);
  });

  it('still names the same springs after a long randomized sculpt sequence', () => {
    const map = hillMap(WORLD_SIZE);
    const index = new SpringIndex(map, alwaysActive);
    const random = makeRandom(SCULPT_SEED);

    for (let step = 0; step < SCULPT_ITERATIONS; step++) {
      const x = Math.floor(random() * WORLD_SIZE);
      const y = Math.floor(random() * WORLD_SIZE);
      // Up or down by a whole band: enough to cross the local-maximum test in
      // either direction, so the sweep exercises candidates appearing AND
      // disappearing rather than only one of the two.
      const delta = (random() < 0.5 ? -1 : 1) * BAND_HEIGHT;
      map.cells[cellIndex(map, x, y)] += delta;
      index.noteCellChanged(x, y);
      expectIndexAgreesWithFullScan(map, index, alwaysActive);
    }
  });

  it('still names the same springs after a whole region moves at once', () => {
    const map = hillMap(WORLD_SIZE);
    const index = new SpringIndex(map, alwaysActive);
    const random = makeRandom(SCULPT_SEED);

    for (let step = 0; step < SCULPT_ITERATIONS / 10; step++) {
      const minX = Math.floor(random() * (WORLD_SIZE - 8));
      const minY = Math.floor(random() * (WORLD_SIZE - 8));
      const maxX = minX + Math.floor(random() * 8);
      const maxY = minY + Math.floor(random() * 8);
      const delta = (random() < 0.5 ? -1 : 1) * BAND_HEIGHT;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) map.cells[cellIndex(map, x, y)] += delta;
      }
      index.noteRegionChanged(minX, minY, maxX, maxY);
      expectIndexAgreesWithFullScan(map, index, alwaysActive);
    }
  });

  it('follows the activity predicate when part of the world becomes active', () => {
    const map = hillMap(WORLD_SIZE);
    // Half the world dark to begin with — the reveal frontier a locked chunk
    // makes on the server, in the crudest form that still has a border.
    let activeBelow = WORLD_SIZE / 2;
    const isActive = (_x: number, y: number): boolean => y < activeBelow;
    const index = new SpringIndex(map, isActive);
    expectIndexAgreesWithFullScan(map, index, isActive);

    // Rows revealed one at a time: each one can make its own cells candidates
    // AND unseat the row above, which was passing vacuously on its dark side.
    while (activeBelow < WORLD_SIZE) {
      const revealed = activeBelow;
      activeBelow += 1;
      index.noteRegionChanged(0, revealed, WORLD_SIZE - 1, revealed);
      expectIndexAgreesWithFullScan(map, index, isActive);
    }
  });

  it('rebuilds from scratch when the terrain is replaced wholesale', () => {
    const map = hillMap(WORLD_SIZE);
    const index = new SpringIndex(map, alwaysActive);
    index.springs(); // force the first build, so the rebuild below is a real one

    // A rollback rewinds every cell at once and reports no diff — the case
    // `markStale` exists for.
    map.cells.set(hillMap(WORLD_SIZE).cells.map((h) => SEA_LEVEL + (h - SEA_LEVEL) * 2));
    index.markStale();
    expectIndexAgreesWithFullScan(map, index, alwaysActive);
  });

  it('is a pure function of the terrain, not of the order changes arrived in', () => {
    const map = hillMap(WORLD_SIZE);
    const incremental = new SpringIndex(map, alwaysActive);
    const random = makeRandom(SCULPT_SEED);

    for (let step = 0; step < SCULPT_ITERATIONS; step++) {
      const x = Math.floor(random() * WORLD_SIZE);
      const y = Math.floor(random() * WORLD_SIZE);
      map.cells[cellIndex(map, x, y)] += (random() < 0.5 ? -1 : 1) * BAND_HEIGHT;
      incremental.noteCellChanged(x, y);
    }

    // Same terrain, no history at all: the spring LIST must match element for
    // element, not merely as a set — the order is the trace order rivers get.
    expect(incremental.springs()).toEqual(new SpringIndex(map, alwaysActive).springs());
  });
});
