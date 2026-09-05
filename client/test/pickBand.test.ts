// WHICH BAND A PICK NAMES (client/src/terrain/pickBand.ts) — the contract the
// 2026-09-04 hover-pick work rests on (issue #324).
//
// The point of these is the NEGATIVE cases. The old derivation clamped a struck
// height into the span's drawn range, so a pick that had outlived an edit came
// back as a confident band rather than as "I cannot say"; that clamp is what
// turned a stale claim into a wrong carve.

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

/** A map whose one interesting column is (CELL_X, CELL_Z). */
function mapWith(spans: ReadonlyArray<{ floor: number; ceiling: number }>): Heightmap {
  const map = createHeightmap(WORLD);
  setColumn(map, CELL_X, CELL_Z, spans);
  return map;
}

/** A pick of the column above, stated in the terms the march reports. */
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

/** Every band is reachable — the "no lip anywhere" case is its own test. */
const LIP_EVERYWHERE = (): boolean => true;
const LIP_NOWHERE = (): boolean => false;

describe('resolvePick / bandOfPick', () => {
  const CAP_BAND = 10;
  const CAP = BAND_HEIGHT * CAP_BAND;
  const oneSpan = (): Heightmap => mapWith([{ floor: BEDROCK_FLOOR, ceiling: CAP }]);

  it('names the band whose slab a riser hit landed in', () => {
    // Band k's face is [(k−1)·BAND_HEIGHT, k·BAND_HEIGHT] (owner, 2026-08-26),
    // so a hit in the middle of that face is band k.
    const map = oneSpan();
    const midFace = BAND_HEIGHT * 6 - BAND_HEIGHT / 2;
    expect(resolvePick(map, pickAt(0, true, midFace, CAP))).toEqual({ face: 'riser', band: 6 });
  });

  it('gives a riser hit exactly on the underside boundary the LOWEST drawn band', () => {
    // THE ONE LEGITIMATE TIE-BREAK. `ceil` is exact on a boundary and would
    // name the band below the face; the lowest band the span draws is the one
    // whose slab that boundary is the bottom of.
    //
    // The span is [BEDROCK_FLOOR + BAND_HEIGHT, CAP): its underside sits one
    // band below its lowest filled band (columns.ts spanUndersideHeight), so
    // the two are stated from the map rather than assumed.
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
    // The band whose slab the ray actually met, coming up from below. This
    // returned the CAP band before 2026-09-04.
    const FLOOR_BAND = 3;
    const map = mapWith([
      { floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + BAND_HEIGHT },
      { floor: BAND_HEIGHT * FLOOR_BAND, ceiling: CAP },
    ]);
    const underside = BAND_HEIGHT * (FLOOR_BAND - 1);
    // Strictly between the underside and the cap is a riser; the underside
    // FACE is the horizontal one at that boundary.
    expect(resolvePick(map, pickAt(1, false, underside, CAP))).toEqual({
      face: 'underside',
      band: FLOOR_BAND,
    });
  });

  it('is NULL — not a clamped band — when the struck height is outside the span', () => {
    // THE #324 SHAPE: the ground moved under a stationary pointer and the
    // struck height no longer lies in the slab this span draws. The old code
    // clamped and answered; a caller cannot tell that from a real answer.
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
    // A flat tread far from any lip is not a corner edge (D1, owner
    // 2026-09-04); the middle of a plateau must not cut.
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
    // `spanIndexCoveringBand` is the exact test shared/src/heightmap.ts applies
    // before it acts on a `spanBand`, so a band that failed it would reach the
    // wire as a silent no-op.
    //
    // SWEPT, NOT SPOT-CHECKED, because the belt is not reachable from a
    // well-formed pick (see carveBandOfPick's doc): the band `resolvePick`
    // names always lies between the struck span's lowest drawn band and its
    // cap, and a span covers every band in that range. What this pins is that
    // property — if it ever stops holding, the belt starts earning its keep
    // and this test says so by going red on the band instead of on the null.
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
