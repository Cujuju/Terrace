import { describe, expect, it } from 'vitest';
import {
  CHUNK_SIZE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  chunkIndex,
  chunksPerEdge,
  drawnBandOfSample,
  quantizeToBand,
  spanCount,
} from '@terrace/shared';
import { carveArchFixture, tunnelRoofFloorBand } from '../src/terrain/archFixture.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

/**
 * Restated from `server/src/world/arch-fixture.ts`; the two fixtures must not
 * share code, so parity is pinned here instead.
 */
const SERVER_TUNNEL_OPENING_BANDS = 5;

function serverRoofFloorBand(base: number): number {
  return drawnBandOfSample(base) + SERVER_TUNNEL_OPENING_BANDS;
}

/** Wide enough to hold the mound (radius 30 cells) around its centre. */
const WORLD = CHUNK_SIZE * 6;
const CENTRE = Math.floor(WORLD / 2);

/** Ground that puts the mound's base at 0, where the two roof formulas used to differ. */
const CENTRE_HEIGHT_AT_BASE_ZERO = 0;
/** A surround that caps in the roof's own band, so no gap can be drawn. */
const BLOCKING_SURROUND_HEIGHT = 72;

function world(centreHeight: number, surroundHeight: number): TerrainMirror {
  const mirror = createTerrainMirror(WORLD);
  const cols = chunksPerEdge(WORLD);
  for (let cy = 0; cy < cols; cy++) {
    for (let cx = 0; cx < cols; cx++) mirror.received.add(chunkIndex(WORLD, cx, cy));
  }
  mirror.map.cells.fill(surroundHeight);
  mirror.map.cells[CENTRE * WORLD + CENTRE] = centreHeight;
  return mirror;
}

describe('client arch fixture roof band', () => {
  it('agrees with the server formula at every base in the height range', () => {
    let checked = 0;
    for (let h = MIN_HEIGHT; h <= MAX_HEIGHT; h++) {
      const base = quantizeToBand(h);
      expect(tunnelRoofFloorBand(base)).toBe(serverRoofFloorBand(base));
      checked++;
    }
    expect(checked).toBe(MAX_HEIGHT - MIN_HEIGHT + 1);
  });

  it('names band 4, not 5, for the base of 0 the old height formula misread', () => {
    expect(tunnelRoofFloorBand(0)).toBe(4);
  });
});

describe('client arch fixture refusals', () => {
  it('refuses in its own words when the ground leaves no band of air', () => {
    const mirror = world(CENTRE_HEIGHT_AT_BASE_ZERO, BLOCKING_SURROUND_HEIGHT);
    expect(() => carveArchFixture(mirror)).toThrow(/^arch fixture: cell \(\d+, \d+\)/);
  });

  it('builds layered columns on flat ground the opening does clear', () => {
    const FLAT_HEIGHT = 40;
    const mirror = world(FLAT_HEIGHT, FLAT_HEIGHT);
    expect(carveArchFixture(mirror).size).toBeGreaterThan(0);

    let layered = 0;
    for (let z = 0; z < WORLD; z++) {
      for (let x = 0; x < WORLD; x++) if (spanCount(mirror.map, x, z) > 1) layered++;
    }
    expect(layered).toBeGreaterThan(0);
  });
});
