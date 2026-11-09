import { describe, expect, it } from 'vitest';
import {
  applySculpt, bandFloorHeight, bandLevelHeight, BAND_HEIGHT, BEDROCK_BAND,
  createHeightmap, createSeededRng, DEFAULT_SCULPT_AMOUNT, MAX_HEIGHT, MIN_HEIGHT, setColumn,
} from '../src/index.ts';
import { hashCellDiff, hashHeightmap } from './support/goldenCorpus.ts';

type Fixture = 'cliff' | 'noise' | 'layers' | 'waterline';
const SIZE = 32;
const RADIUS = 8;
const SEED = 0x5eed;

function fixture(kind: Fixture) {
  const map = createHeightmap(SIZE);
  const rng = createSeededRng(SEED);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const band = (kind === 'waterline' ? -3 : 8) + Math.floor(rng.next() * (kind === 'waterline' ? 7 : 24));
    if (kind === 'cliff') map.cells[y * SIZE + x] = x < SIZE / 2 ? MIN_HEIGHT : MAX_HEIGHT;
    else if (kind === 'layers') setLayer(x, y, band);
    else map.cells[y * SIZE + x] = bandFloorHeight(band) + Math.floor(rng.next() * BAND_HEIGHT);
  }
  return map;

  function setLayer(x: number, y: number, band: number): void {
    setColumn(map, x, y, [
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight((x + y) % 4 === 0 ? 4 : 8 + band % 3) },
      { floorBand: 20, ceiling: bandLevelHeight(24) },
    ]);
  }
}

// Terrain and diff hashes captured from the baseline algorithm at 8575a69.
const CASES = [
  ['cliff', false, 2, '93999c91', '535b992e'],
  ['cliff', false, 8, '93999c91', '535b992e'],
  ['cliff', true, 2, '93999c91', '535b992e'],
  ['cliff', true, 8, '93999c91', '535b992e'],
  ['noise', false, 2, 'ce33d9c8', '6408d441'],
  ['noise', false, 8, 'cdf82131', 'f27fb158'],
  ['noise', true, 2, '9557fd4b', '9c45f15d'],
  ['noise', true, 8, '248eb155', 'f1c3d2b9'],
  ['layers', false, 2, '5b18cba0', 'db5f9a69'],
  ['layers', false, 8, 'fc66ced0', '3eb6e833'],
  ['layers', true, 2, '49647c73', '329bbf1a'],
  ['layers', true, 8, '6e369788', '6be3b4fa'],
  ['waterline', false, 2, 'e71dc351', '655c4820'],
  ['waterline', false, 8, '21cee416', 'e7fdf97c'],
  ['waterline', true, 2, '625353aa', '7fdd0b34'],
  ['waterline', true, 8, '6faa86c7', 'e0388430'],
] as const;

describe('outline smoothing preserves exact terrain and wire diffs', () => {
  it.each(CASES)('%s walls=%s kink=%s', (kind, walls, kink, terrainHash, diffHash) => {
    const map = fixture(kind);
    const diff = applySculpt(map, SIZE / 2 - 1, SIZE / 2, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'smooth', anchor: 'clicked', smoothWalls: walls, smoothKinkHalfCells: kink,
      ...(kind === 'layers' ? { spanBand: 8 } : {}),
    });
    expect(hashHeightmap(map)).toBe(terrainHash);
    expect(hashCellDiff(diff)).toBe(diffHash);
  });
});
