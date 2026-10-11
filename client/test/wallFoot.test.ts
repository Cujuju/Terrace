import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, BEDROCK_BAND, chunkIndex, setColumn } from '@terrace/shared';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE } from '../src/config.ts';
import { CLIFF_PALETTE, TERRAIN_PALETTE } from '../src/terrain/bandColors.ts';
import { planChunkCaps } from '../src/terrain/capEmission.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';
import { drawnCapMet } from '../src/terrain/pick/bandOwner.ts';
import { terrainHitInCell } from '../src/terrain/pick/cellHit.ts';
import { CELL_CENTRE_OFFSET, scaleRayToCellSpace } from '../src/terrain/pick/rayMarch.ts';

const WORLD = 32;
const CHUNKS_PER_EDGE = WORLD / 16;

const WALL_CELL_X = 8;
const WALL_CELL_Z = 3;

/** Ground deep enough that the drawn contour at the cell's west edge dips below the roof's foot. */
const GROUND_HEIGHT = -4 * BAND_HEIGHT;
const FLOOR_SPAN_CEILING = GROUND_HEIGHT;
const ROOF_FLOOR_BAND = 6;
const ROOF_CEILING = 10 * BAND_HEIGHT;

const ROOF_SPAN_INDEX = 1;

const DIRECTION = { x: 0, y: 0, z: 1 };
/** Ray enters on the cell's west boundary, where the drawn cap dips into the gap. */
const ORIGIN_X = (WALL_CELL_X - CELL_CENTRE_OFFSET) * CELL_WORLD_SIZE;
const ORIGIN_Z = (WALL_CELL_Z - CELL_CENTRE_OFFSET) * CELL_WORLD_SIZE;
const T_ENTER = 0;
const T_EXIT = CELL_WORLD_SIZE;

function layeredWorld(): TerrainMirror {
  const mirror = createTerrainMirror(WORLD);
  for (let cy = 0; cy < CHUNKS_PER_EDGE; cy++) {
    for (let cx = 0; cx < CHUNKS_PER_EDGE; cx++) mirror.received.add(chunkIndex(WORLD, cx, cy));
  }
  mirror.map.cells.fill(GROUND_HEIGHT);
  for (let z = 0; z < WORLD; z++) {
    setColumn(mirror.map, WALL_CELL_X, z, [
      { floorBand: BEDROCK_BAND, ceiling: FLOOR_SPAN_CEILING },
      { floorBand: ROOF_FLOOR_BAND, ceiling: ROOF_CEILING },
    ]);
  }
  return mirror;
}

function hitAtEntry(mirror: TerrainMirror, entryY: number): ReturnType<typeof terrainHitInCell> {
  const origin = { x: ORIGIN_X, y: entryY, z: ORIGIN_Z };
  return terrainHitInCell(
    mirror, WALL_CELL_X, WALL_CELL_Z, origin, DIRECTION, T_ENTER, T_EXIT, null,
  );
}

/** The mesher's wall base for the roof span's floor band, read off the emitted plan. */
function meshWallBaseY(mirror: TerrainMirror): number {
  const plan = planChunkCaps(mirror, 0, 0, { top: TERRAIN_PALETTE, cliff: CLIFF_PALETTE });
  const level = plan.levels.find((entry) => entry.sampleBand === ROOF_FLOOR_BAND);
  expect(level).toBeDefined();
  return level!.undersideY;
}

describe('a layered column’s wall foot', () => {
  it('reaches the wall-entry branch: the drawn cap is met nowhere along the ray', () => {
    const mirror = layeredWorld();
    const ray = scaleRayToCellSpace({ x: ORIGIN_X, y: 4 * BAND_WORLD_HEIGHT, z: ORIGIN_Z }, DIRECTION);
    expect(ray).not.toBeNull();
    expect(drawnCapMet(mirror, ray!, T_ENTER, T_EXIT)).toBeNull();
  });

  it('starts the top span’s wall where the mesher starts it', () => {
    const mirror = layeredWorld();
    const footY = meshWallBaseY(mirror);

    const onFoot = hitAtEntry(mirror, footY);
    expect(onFoot).not.toBeNull();
    expect(onFoot!.spanIndex).toBe(ROOF_SPAN_INDEX);
    expect(onFoot!.face).toBe('riser');
    expect(onFoot!.hitY).toBe(footY);
  });

  it('leaves the band below the foot open, and the band above it solid', () => {
    const mirror = layeredWorld();
    const footY = meshWallBaseY(mirror);

    expect(hitAtEntry(mirror, footY - BAND_WORLD_HEIGHT)).toBeNull();
    expect(hitAtEntry(mirror, footY + BAND_WORLD_HEIGHT)?.spanIndex).toBe(ROOF_SPAN_INDEX);
  });
});
