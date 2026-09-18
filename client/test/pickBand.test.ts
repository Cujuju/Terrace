import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_BAND,
  BEDROCK_FLOOR,
  createHeightmap,
  setColumn,
  spanIndexCoveringBand,
  type Heightmap,
  type Span,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import { bandOfPick, carveBandOfPick, resolvePick } from '../src/terrain/pickBand.ts';
import type { PickFace, TerrainRayPick } from '../src/terrain/picking.ts';

const WORLD = 16;
const CELL_X = 4;
const CELL_Z = 4;

function mapWith(spans: readonly Span[]): Heightmap {
  const map = createHeightmap(WORLD);
  setColumn(map, CELL_X, CELL_Z, spans);
  return map;
}

function pickAt(
  spanIndex: number,
  face: PickFace,
  hitHeight: number,
  surfaceHeight: number,
): TerrainRayPick {
  return {
    x: CELL_X,
    y: CELL_Z,
    spanIndex,
    face,
    hitY: hitHeight * HEIGHT_WORLD_SCALE,
    surfaceY: surfaceHeight * HEIGHT_WORLD_SCALE,
    hitX: CELL_X * CELL_WORLD_SIZE,
    hitZ: CELL_Z * CELL_WORLD_SIZE,
  };
}


describe('resolvePick / bandOfPick', () => {
  const CAP_BAND = 10;
  const CAP = BAND_HEIGHT * CAP_BAND;
  const oneSpan = (): Heightmap => mapWith([{ floorBand: BEDROCK_BAND, ceiling: CAP }]);

  it('names the band whose slab a riser hit landed in', () => {
    const map = oneSpan();
    const midFace = BAND_HEIGHT * 6 - BAND_HEIGHT / 2;
    expect(resolvePick(map, pickAt(0, 'riser', midFace, CAP))).toEqual({ face: 'riser', band: 6 });
  });

  it('gives a riser hit exactly on the underside boundary the LOWEST drawn band', () => {
    const FLOOR_BAND = 3;
    const map = mapWith([
      { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR + BAND_HEIGHT },
      { floorBand: FLOOR_BAND, ceiling: CAP },
    ]);
    const undersideHeight = BAND_HEIGHT * (FLOOR_BAND - 1);
    expect(resolvePick(map, pickAt(1, 'riser', undersideHeight, CAP))).toEqual({
      face: 'riser',
      band: FLOOR_BAND,
    });
  });

  it('gives a tread hit the cap band of the struck span', () => {
    const map = oneSpan();
    expect(resolvePick(map, pickAt(0, 'tread', CAP, CAP))).toEqual({
      face: 'tread',
      band: CAP_BAND,
    });
  });

  it('gives an underside hit the LOWEST drawn band, not the cap band', () => {
    const FLOOR_BAND = 3;
    const map = mapWith([
      { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR + BAND_HEIGHT },
      { floorBand: FLOOR_BAND, ceiling: CAP },
    ]);
    const underside = BAND_HEIGHT * (FLOOR_BAND - 1);
    expect(resolvePick(map, pickAt(1, 'underside', underside, CAP))).toEqual({
      face: 'underside',
      band: FLOOR_BAND,
    });
  });

  it('is NULL — not a clamped band — when the struck height is outside the span', () => {
    const map = oneSpan();
    const aboveCap = CAP + BAND_HEIGHT;
    const belowUnderside = BEDROCK_FLOOR - BAND_HEIGHT * 2;
    expect(bandOfPick(map, pickAt(0, 'riser', aboveCap, CAP))).toBeNull();
    expect(bandOfPick(map, pickAt(0, 'riser', belowUnderside, CAP))).toBeNull();
  });

  it('is null when the span index no longer exists, or the cell is off the world', () => {
    const map = oneSpan();
    expect(bandOfPick(map, pickAt(1, 'riser', BAND_HEIGHT * 5, CAP))).toBeNull();
    expect(bandOfPick(map, { ...pickAt(0, 'riser', BAND_HEIGHT * 5, CAP), x: -1 })).toBeNull();
    expect(bandOfPick(map, { ...pickAt(0, 'riser', BAND_HEIGHT * 5, CAP), y: WORLD })).toBeNull();
  });
});

describe('carveBandOfPick', () => {
  const CAP_BAND = 10;
  const CAP = BAND_HEIGHT * CAP_BAND;
  const oneSpan = (): Heightmap => mapWith([{ floorBand: BEDROCK_BAND, ceiling: CAP }]);

  it('carves the band of the face on a riser hit — the SIDE FACE', () => {
    const map = oneSpan();
    const midFace = BAND_HEIGHT * 6 - BAND_HEIGHT / 2;
    expect(carveBandOfPick(map, pickAt(0, 'riser', midFace, CAP))).toBe(6);
  });

  it('carves the cap band on a tread hit — the CORNER EDGE', () => {
    const map = oneSpan();
    expect(carveBandOfPick(map, pickAt(0, 'tread', CAP, CAP))).toBe(CAP_BAND);
  });

  it('never answers a band no span covers — the server-side belt', () => {
    const FLOOR_TOP = BAND_HEIGHT * 3;
    const ROOF_BAND = 6;
    const map = mapWith([
      { floorBand: BEDROCK_BAND, ceiling: FLOOR_TOP },
      { floorBand: ROOF_BAND, ceiling: CAP },
    ]);
    for (const spanIndex of [0, 1]) {
      for (let h = BEDROCK_FLOOR; h <= CAP; h += BAND_HEIGHT / 2) {
        for (const face of ['riser', 'tread', 'underside'] as const) {
          const band = carveBandOfPick(map, pickAt(spanIndex, face, h, CAP));
          if (band === null) continue;
          expect(spanIndexCoveringBand(map, CELL_X, CELL_Z, band)).not.toBeNull();
        }
      }
    }
  });
});
