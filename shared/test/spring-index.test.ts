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

const WORLD_SIZE = 64;

const SCULPT_ITERATIONS = 400;

const SCULPT_SEED = 0x5eed_1235;

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
    let activeBelow = WORLD_SIZE / 2;
    const isActive = (_x: number, y: number): boolean => y < activeBelow;
    const index = new SpringIndex(map, isActive);
    expectIndexAgreesWithFullScan(map, index, isActive);

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
    index.springs();

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

    expect(incremental.springs()).toEqual(new SpringIndex(map, alwaysActive).springs());
  });
});
