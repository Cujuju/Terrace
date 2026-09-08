import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  CONTOUR_CELL_CENTRE_GUARD,
  SEA_LEVEL,
  isFarmlandCell,
  isFarmlandPlot,
  type FarmlandWorld,
} from '../src/index.ts';

const WORLD_SIZE = 64;

const FARMLAND_BAND = 2;
const DEEP = SEA_LEVEL - 10 * BAND_HEIGHT;

const dryInBand0 = (fifth: number): number => Math.floor((BAND_HEIGHT * fifth) / 5);

function terrainAt(x: number, y: number): number {
  if (x === 11 && y === 10) return DEEP;

  if (x === 29 && y === 30) return (FARMLAND_BAND + 1) * BAND_HEIGHT;
  if (x === 30 && y === 29) return DEEP;

  if (x === 40 && y === 40) return dryInBand0(1);
  if (x === 39 && y === 40) return dryInBand0(2);
  if (x === 41 && y === 40) return SEA_LEVEL;
  if (x === 40 && y === 39) return dryInBand0(4);
  if (x === 40 && y === 41) return dryInBand0(3);

  if (x === 50 && y === 50) return SEA_LEVEL;
  if (x === 49 && y === 50) return dryInBand0(1);
  if (x === 51 && y === 50) return dryInBand0(1);
  if (x === 50 && y === 49) return dryInBand0(1);
  if (x === 50 && y === 51) return dryInBand0(1);

  return FARMLAND_BAND * BAND_HEIGHT;
}

function world(lockedCell?: (x: number, y: number) => boolean): FarmlandWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt: terrainAt,
    isCellUnlocked: (x, y) => (lockedCell === undefined ? true : !lockedCell(x, y)),
  };
}

describe('isFarmlandCell', () => {
  it('accepts a flat terrace edged by ordinary (deep) water', () => {
    expect(isFarmlandCell(world(), 10, 10)).toBe(true);
  });

  it('rejects flat, dry ground with no water neighbour anywhere', () => {
    expect(isFarmlandCell(world(), 20, 20)).toBe(false);
  });

  it('rejects a cell touching water that is not flat among its DRY neighbours', () => {
    expect(isFarmlandCell(world(), 30, 30)).toBe(false);
  });

  it('treats a water neighbour as the terrace edge, not a flatness violation', () => {
    expect(isFarmlandCell(world(), 10, 10)).toBe(true);
  });

  it('counts height exactly SEA_LEVEL as water even though it shares band 0 with the dry cell beside it', () => {
    expect(isFarmlandCell(world(), 40, 40)).toBe(true);
  });

  it('rejects a cell that is itself water, however farmland-like its neighbours look', () => {
    expect(isFarmlandCell(world(), 50, 50)).toBe(false);
  });

  it('rejects a cell whose neighbourhood runs off the world edge', () => {
    expect(isFarmlandCell(world(), 0, 10)).toBe(false);
    expect(isFarmlandCell(world(), WORLD_SIZE - 1, 10)).toBe(false);
  });

  it('rejects a cell outside the world entirely', () => {
    expect(isFarmlandCell(world(), -1, 10)).toBe(false);
    expect(isFarmlandCell(world(), WORLD_SIZE, 10)).toBe(false);
  });

  it('rejects non-integer coordinates rather than silently flooring them', () => {
    expect(isFarmlandCell(world(), 10.5, 10)).toBe(false);
    expect(isFarmlandCell(world(), 10, 10.5)).toBe(false);
  });

  it('requires the CELL ITSELF to be unlocked', () => {
    expect(isFarmlandCell(world((x, y) => x === 10 && y === 10), 10, 10)).toBe(false);
  });

  it('does NOT require its NEIGHBOURS to be unlocked', () => {
    expect(isFarmlandCell(world((x, y) => x === 11 && y === 10), 10, 10)).toBe(true);
  });

  it('is deterministic — the same world and cell answer identically every call', () => {
    const w = world();
    const first = isFarmlandCell(w, 10, 10);
    for (let i = 0; i < 100; i++) expect(isFarmlandCell(w, 10, 10)).toBe(first);
  });
});

function coastAt(x: number, _y: number): number {
  return x === 0 ? DEEP : FARMLAND_BAND * BAND_HEIGHT;
}

function coast(lockedCell?: (x: number, y: number) => boolean): FarmlandWorld {
  return {
    worldSize: WORLD_SIZE,
    heightAt: coastAt,
    isCellUnlocked: (x, y) => (lockedCell === undefined ? true : !lockedCell(x, y)),
  };
}

describe('isFarmlandPlot', () => {
  it('rejects the LIP cell that isFarmlandCell accepts — the whole point of the predicate', () => {
    expect(isFarmlandCell(coast(), 1, 10)).toBe(true);
    expect(isFarmlandPlot(coast(), 1, 10, 1)).toBe(false);
  });

  it('accepts the cell one back from the lip, which has a whole cell of tread', () => {
    expect(isFarmlandPlot(coast(), 2, 10, 1)).toBe(true);
  });

  it('rejects a cell too far inland to be farming a water-edged terrace at all', () => {
    expect(isFarmlandPlot(coast(), 3, 10, 1)).toBe(false);
  });

  it('a bigger model is set further back — the setback follows the ring, not a literal', () => {
    expect(isFarmlandPlot(coast(), 2, 10, 2)).toBe(false);
    expect(isFarmlandPlot(coast(), 3, 10, 2)).toBe(true);
  });

  it('at ring 0 it is the old point test — the guarantee that was not enough', () => {
    expect(isFarmlandPlot(coast(), 1, 10, 0)).toBe(isFarmlandCell(coast(), 1, 10));
    expect(isFarmlandPlot(coast(), 1, 10, 0)).toBe(true);
  });

  it('rejects a tread cell on a different terrace band even when it is dry', () => {
    const stepped: FarmlandWorld = {
      worldSize: WORLD_SIZE,
      heightAt: (x, y) =>
        x === 3 && y === 11 ? (FARMLAND_BAND + 1) * BAND_HEIGHT : coastAt(x, y),
      isCellUnlocked: () => true,
    };
    expect(isFarmlandPlot(stepped, 2, 10, 1)).toBe(false);
  });

  it('rejects a plot whose tread runs off the world edge', () => {
    const rim: FarmlandWorld = {
      worldSize: WORLD_SIZE,
      heightAt: (x, y) => (x === 2 && y === 2 ? DEEP : FARMLAND_BAND * BAND_HEIGHT),
      isCellUnlocked: () => true,
    };
    expect(isFarmlandPlot(rim, 0, 0, 1)).toBe(false);
  });

  it('requires the plot cell itself to be unlocked, but not its tread', () => {
    expect(isFarmlandPlot(coast((x, y) => x === 2 && y === 10), 2, 10, 1)).toBe(false);
    expect(isFarmlandPlot(coast((x, y) => x === 3 && y === 11), 2, 10, 1)).toBe(true);
  });

  it('rejects a negative or non-integer ring rather than guessing', () => {
    expect(isFarmlandPlot(coast(), 2, 10, -1)).toBe(false);
    expect(isFarmlandPlot(coast(), 2, 10, 0.5)).toBe(false);
  });

  it('sets a plot back far enough that no contour can reach it', () => {
    expect(1 + CONTOUR_CELL_CENTRE_GUARD).toBeGreaterThan(0.5);
  });

  it('is deterministic — the same world, cell and ring answer identically every call', () => {
    const w = coast();
    const first = isFarmlandPlot(w, 2, 10, 1);
    for (let i = 0; i < 100; i++) expect(isFarmlandPlot(w, 2, 10, 1)).toBe(first);
  });
});
