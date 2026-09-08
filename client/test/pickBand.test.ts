import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  createHeightmap,
  setColumn,
  spanIndexCoveringBand,
  type Heightmap,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import { bandOfPick, carveBandOfPick, resolvePick } from '../src/terrain/pickBand.ts';
import type { TerrainRayPick } from '../src/terrain/picking.ts';

const WORLD = 16;
const CELL_X = 4;
const CELL_Z = 4;

function mapWith(spans: ReadonlyArray<{ floor: number; ceiling: number }>): Heightmap {
  const map = createHeightmap(WORLD);
  setColumn(map, CELL_X, CELL_Z, spans);
  return map;
}

function pickAt(
  spanIndex: number,
  hitRiser: boolean,
  hitHeight: number,
  surfaceHeight: number,
): TerrainRayPick {
  return {
    x: CELL_X,
    y: CELL_Z,
    spanIndex,
    hitRiser,
    hitY: hitHeight * HEIGHT_WORLD_SCALE,
    surfaceY: surfaceHeight * HEIGHT_WORLD_SCALE,
    hitX: CELL_X * CELL_WORLD_SIZE,
    hitZ: CELL_Z * CELL_WORLD_SIZE,
  };
}

const LIP_EVERYWHERE = (): boolean => true;
const LIP_NOWHERE = (): boolean => false;

describe('resolvePick / bandOfPick', () => {
  const CAP_BAND = 10;
  const CAP = BAND_HEIGHT * CAP_BAND;
  const oneSpan = (): Heightmap => mapWith([{ floor: BEDROCK_FLOOR, ceiling: CAP }]);

  it('names the band whose slab a riser hit landed in', () => {
    const map = oneSpan();
    const midFace = BAND_HEIGHT * 6 - BAND_HEIGHT / 2;
    expect(resolvePick(map, pickAt(0, true, midFace, CAP))).toEqual({ face: 'riser', band: 6 });
  });

  it('gives a riser hit exactly on the underside boundary the LOWEST drawn band', () => {
    const FLOOR_BAND = 3;
    const map = mapWith([
      { floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + BAND_HEIGHT },
      { floor: BAND_HEIGHT * FLOOR_BAND, ceiling: CAP },
    ]);
    const undersideHeight = BAND_HEIGHT * (FLOOR_BAND - 1);
    expect(resolvePick(map, pickAt(1, true, undersideHeight, CAP))).toEqual({
      face: 'riser',
      band: FLOOR_BAND,
    });
  });

  it('gives a tread hit the cap band of the struck span', () => {
    const map = oneSpan();
    expect(resolvePick(map, pickAt(0, false, CAP, CAP))).toEqual({
      face: 'tread',
      band: CAP_BAND,
    });
  });

  it('gives an underside hit the LOWEST drawn band, not the cap band', () => {
    const FLOOR_BAND = 3;
    const map = mapWith([
      { floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + BAND_HEIGHT },
      { floor: BAND_HEIGHT * FLOOR_BAND, ceiling: CAP },
    ]);
    const underside = BAND_HEIGHT * (FLOOR_BAND - 1);
    expect(resolvePick(map, pickAt(1, false, underside, CAP))).toEqual({
      face: 'underside',
      band: FLOOR_BAND,
    });
  });

  it('is NULL — not a clamped band — when the struck height is outside the span', () => {
    const map = oneSpan();
    const aboveCap = CAP + BAND_HEIGHT;
    const belowUnderside = BEDROCK_FLOOR - BAND_HEIGHT * 2;
    expect(bandOfPick(map, pickAt(0, true, aboveCap, CAP))).toBeNull();
    expect(bandOfPick(map, pickAt(0, true, belowUnderside, CAP))).toBeNull();
  });

  it('is null when the span index no longer exists, or the cell is off the world', () => {
    const map = oneSpan();
    expect(bandOfPick(map, pickAt(1, true, BAND_HEIGHT * 5, CAP))).toBeNull();
    expect(bandOfPick(map, { ...pickAt(0, true, BAND_HEIGHT * 5, CAP), x: -1 })).toBeNull();
    expect(bandOfPick(map, { ...pickAt(0, true, BAND_HEIGHT * 5, CAP), y: WORLD })).toBeNull();
  });
});

describe('carveBandOfPick', () => {
  const CAP_BAND = 10;
  const CAP = BAND_HEIGHT * CAP_BAND;
  const oneSpan = (): Heightmap => mapWith([{ floor: BEDROCK_FLOOR, ceiling: CAP }]);

  it('carves the band of the face on a riser hit — the SIDE FACE', () => {
    const map = oneSpan();
    const midFace = BAND_HEIGHT * 6 - BAND_HEIGHT / 2;
    expect(carveBandOfPick(map, pickAt(0, true, midFace, CAP), LIP_NOWHERE)).toBe(6);
  });

  it('carves the cap band on a tread hit WITH a lip in reach — the CORNER EDGE', () => {
    const map = oneSpan();
    expect(carveBandOfPick(map, pickAt(0, false, CAP, CAP), LIP_EVERYWHERE)).toBe(CAP_BAND);
  });

  it('carves NOTHING on a tread hit with no lip in reach', () => {
    const map = oneSpan();
    expect(carveBandOfPick(map, pickAt(0, false, CAP, CAP), LIP_NOWHERE)).toBeNull();
  });

  it('asks the lip test about exactly the band it would carve', () => {
    const map = oneSpan();
    const asked: number[] = [];
    carveBandOfPick(map, pickAt(0, false, CAP, CAP), (band) => {
      asked.push(band);
      return true;
    });
    expect(asked).toEqual([CAP_BAND]);
  });

  it('never answers a band no span covers — the server-side belt', () => {
    const FLOOR_TOP = BAND_HEIGHT * 3;
    const ROOF_BASE = BAND_HEIGHT * 6;
    const map = mapWith([
      { floor: BEDROCK_FLOOR, ceiling: FLOOR_TOP },
      { floor: ROOF_BASE, ceiling: CAP },
    ]);
    for (const spanIndex of [0, 1]) {
      for (let h = BEDROCK_FLOOR; h <= CAP; h += BAND_HEIGHT / 2) {
        for (const riser of [true, false]) {
          const band = carveBandOfPick(map, pickAt(spanIndex, riser, h, CAP), LIP_EVERYWHERE);
          if (band === null) continue;
          expect(spanIndexCoveringBand(map, CELL_X, CELL_Z, band)).not.toBeNull();
        }
      }
    }
  });
});
