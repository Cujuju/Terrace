// THE FOOT-OF-FACE CONTRACT (client/src/terrain/faceFoot.ts, issue #347): a
// riser hit anchors a brush on the tread the face rises FROM, and anything
// else anchors on the cell the pick already named.

import { describe, expect, it } from 'vitest';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import { footOfFaceCell } from '../src/terrain/faceFoot.ts';
import type { TerrainRayPick } from '../src/terrain/picking.ts';

const WORLD = 16;
const CELL_X = 4;
const CELL_Z = 4;
/** The -X face of cell (4, 4): half a cell short of its centre. */
const FACE_X = (CELL_X - 0.5) * CELL_WORLD_SIZE;
const STRUCK_HEIGHT = 8;

describe('footOfFaceCell', () => {
  it('anchors a riser hit on the tread before the face, and a flat hit on the pick', () => {
    const pick: TerrainRayPick = {
      x: CELL_X,
      y: CELL_Z,
      spanIndex: 0,
      hitRiser: true,
      hitY: STRUCK_HEIGHT * HEIGHT_WORLD_SCALE,
      surfaceY: STRUCK_HEIGHT * HEIGHT_WORLD_SCALE,
      hitX: FACE_X,
      hitZ: CELL_Z * CELL_WORLD_SIZE,
    };
    // Travelling +X and downward, so the cell it occupied before is (3, 4).
    const direction = { x: 0.8, y: -0.6, z: 0 };

    expect(footOfFaceCell(pick, direction, WORLD)).toEqual({ x: CELL_X - 1, y: CELL_Z });
    // A drawn-contour hit lands INSIDE the struck cell; the foot is still the
    // cell the ray entered from, not the struck cell itself.
    expect(footOfFaceCell({ ...pick, hitX: CELL_X * CELL_WORLD_SIZE }, direction, WORLD)).toEqual({
      x: CELL_X - 1,
      y: CELL_Z,
    });
    expect(footOfFaceCell({ ...pick, hitRiser: false }, direction, WORLD)).toEqual({
      x: CELL_X,
      y: CELL_Z,
    });
  });
});
