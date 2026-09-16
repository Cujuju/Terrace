import { Vector4 } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { GroundSampler } from '../../../client/src/plugins/kit/groundFollow.ts';
import {
  ARMS_PER_SPIRAL,
  COLUMN_CAPACITY,
  COLUMNS_PER_SPIRAL,
  CYCLONE_WALL_FLOOR_WORLD_Y,
  POSITIONS_PER_ARM,
  alongAt,
  columnBearingTurns,
  columnRadiusFraction,
} from './spiralLayout.ts';

const TWO_PI = Math.PI * 2;

// Four column grounds ride each uniform lane, since a lone float is padded to one.
// The shader's one-hot lane mask is written for exactly this width.
export const COLUMN_LANES = 4;

export const COLUMN_LANE_CAPACITY = Math.ceil(COLUMN_CAPACITY / COLUMN_LANES);

export interface ColumnGround {
  // What the shader reads: lane = column / COLUMN_LANES, component = column % COLUMN_LANES.
  readonly lanes: Vector4[];
  stand(
    slot: number,
    x: number,
    z: number,
    radius: number,
    spinTurns: number,
    groundAt: GroundSampler,
  ): void;
}

// The ground under every column of a slot, sampled where the column stands this
// frame: on the terrain, or on the sea where the terrain is drowned or unsent.
export function createColumnGround(): ColumnGround {
  const lanes = Array.from({ length: COLUMN_LANE_CAPACITY }, () =>
    new Vector4(
      CYCLONE_WALL_FLOOR_WORLD_Y,
      CYCLONE_WALL_FLOOR_WORLD_Y,
      CYCLONE_WALL_FLOOR_WORLD_Y,
      CYCLONE_WALL_FLOOR_WORLD_Y,
    ),
  );

  function write(column: number, groundY: number): void {
    lanes[Math.floor(column / COLUMN_LANES)]!.setComponent(column % COLUMN_LANES, groundY);
  }

  return {
    lanes,

    stand(slot, x, z, radius, spinTurns, groundAt): void {
      let column = slot * COLUMNS_PER_SPIRAL;
      for (let arm = 0; arm < ARMS_PER_SPIRAL; arm++) {
        for (let index = 0; index < POSITIONS_PER_ARM; index++) {
          const along = alongAt(index);
          const angle = TWO_PI * (columnBearingTurns(arm, along) - spinTurns);
          const reach = radius * columnRadiusFraction(along);
          const cellX = Math.round((x + Math.cos(angle) * reach) / CELL_WORLD_SIZE);
          const cellZ = Math.round((z + Math.sin(angle) * reach) / CELL_WORLD_SIZE);
          const terrainY = groundAt(cellX, cellZ);
          write(
            column,
            terrainY === null
              ? CYCLONE_WALL_FLOOR_WORLD_Y
              : Math.max(CYCLONE_WALL_FLOOR_WORLD_Y, terrainY),
          );
          column++;
        }
      }
    },
  };
}
