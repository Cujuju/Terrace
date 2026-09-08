import { describe, expect, it } from 'vitest';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';
import { footOfFaceCell } from '../src/terrain/faceFoot.ts';
import type { TerrainRayPick } from '../src/terrain/picking.ts';

const WORLD = 16;
const CELL_X = 4;
const CELL_Z = 4;
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
    const direction = { x: 0.8, y: -0.6, z: 0 };

    expect(footOfFaceCell(pick, direction, WORLD)).toEqual({ x: CELL_X - 1, y: CELL_Z });
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
