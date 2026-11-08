import { beforeEach, describe, expect, it } from 'vitest';
import { sculptTargetOf, pointSculptIntent } from '../src/input/sculpt/intent.ts';
import {
  setBrushProfile, setBrushRadius, setNudgeStrength, setSmoothKinkHalfCells,
} from '../src/state/hudState.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import type { TerrainRayPick } from '../src/terrain/picking.ts';

const SIZE = 32;
const FACE_CELL = { x: 12, y: 12 };
const FLOOR_BAND = 10;
const RADIUS = 4;
const DIRECTION = { x: 0.8, y: -0.6, z: 0 };
const PICK: TerrainRayPick = {
  ...FACE_CELL, face: 'riser', band: FLOOR_BAND, spanIndex: 0, surfaceY: 1,
  hitX: (FACE_CELL.x - 0.5) * CELL_WORLD_SIZE, hitY: 1, hitZ: FACE_CELL.y * CELL_WORLD_SIZE,
};

beforeEach(() => { setBrushRadius(RADIUS); setBrushProfile('stepped'); });

describe('point sculpt description', () => {
  it.each(['stamp', 'smooth', 'nudge'] as const)('resolves %s preview and intent to the same foot and layer', (tool) => {
    const target = sculptTargetOf(PICK, DIRECTION, SIZE, tool, (_pick, x, y) => {
      expect({ x, y }).toEqual({ x: FACE_CELL.x - 1, y: FACE_CELL.y });
      return FLOOR_BAND;
    });
    const intent = pointSculptIntent(target, tool, 1, false);
    expect(intent).toMatchObject({ x: target.x, y: target.y, spanBand: FLOOR_BAND, radius: RADIUS });
    const held = { x: FACE_CELL.x - 2, y: FACE_CELL.y };
    expect(sculptTargetOf(PICK, DIRECTION, SIZE, tool, () => FLOOR_BAND, held)).toEqual({ ...held, spanBand: FLOOR_BAND });
  });

  it('carries the live tool options and directionless mode through the shared builder', () => {
    const target = { ...FACE_CELL, spanBand: FLOOR_BAND };
    const strength = 73;
    const kink = 7;
    setNudgeStrength(strength); setSmoothKinkHalfCells(kink);
    expect(pointSculptIntent(target, 'nudge', -1, false)).toMatchObject({ nudgeStrength: strength, dir: -1 });
    expect(pointSculptIntent(target, 'smooth', 1, true)).toMatchObject({ smoothKinkHalfCells: kink, smoothWalls: true, dir: -1 });
    expect(pointSculptIntent(target, 'stamp', 1, false)).toMatchObject({ profile: 'stepped', dir: 1 });
  });
});
