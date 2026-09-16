import { describe, expect, it } from 'vitest';
import {
  DEV_SEARCH_RADIUS_CELLS,
  DEV_SEARCH_STEP_CELLS,
  searchOutwardFromCentre,
} from '../src/plugins/kit/devSite.ts';

const WORLD_SIZE = 512;

const CENTRE = { x: 200, y: 256 };

const LAND_EDGE_X = 300;

describe('dev force-spawn search reach', () => {
  it('steps in whole cells, coarsely enough to be a search and not a scan', () => {
    expect(Number.isInteger(DEV_SEARCH_STEP_CELLS)).toBe(true);
    expect(DEV_SEARCH_STEP_CELLS).toBeGreaterThan(0);
    expect(DEV_SEARCH_STEP_CELLS).toBeLessThan(DEV_SEARCH_RADIUS_CELLS);
  });
});

describe('searchOutwardFromCentre', () => {
  it('takes the centre itself when the centre will do', () => {
    expect(searchOutwardFromCentre(WORLD_SIZE, () => true, CENTRE)).toEqual(CENTRE);
  });

  it('walks outward to the nearest ground that will do', () => {
    const found = searchOutwardFromCentre(WORLD_SIZE, (x) => x >= LAND_EDGE_X, CENTRE);
    expect(found).not.toBeNull();
    expect(found!.y).toBe(CENTRE.y);
    expect(found!.x).toBeGreaterThanOrEqual(LAND_EDGE_X);
    expect(found!.x - LAND_EDGE_X).toBeLessThan(DEV_SEARCH_RADIUS_CELLS);
  });

  it('refuses when nothing within reach will do', () => {
    expect(searchOutwardFromCentre(WORLD_SIZE, () => false, CENTRE)).toBeNull();
  });

  it('refuses a centre that is not in the world at all', () => {
    const OFF_WORLD = { x: -WORLD_SIZE, y: -WORLD_SIZE };
    expect(searchOutwardFromCentre(WORLD_SIZE, () => true, OFF_WORLD)).toBeNull();
  });

  it('refuses a centre that is not a place: NaN searches nowhere', () => {
    expect(searchOutwardFromCentre(WORLD_SIZE, () => true, { x: Number.NaN, y: 0 })).toBeNull();
    expect(
      searchOutwardFromCentre(WORLD_SIZE, () => true, { x: 0, y: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });
});
