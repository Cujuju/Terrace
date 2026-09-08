import { BAND_HEIGHT, SEA_LEVEL, cellsAcross, type FreshwaterMap } from '@terrace/shared';
import type { WorldApi } from '../../../server/src/plugins/types.ts';
import { FLOW_RADIUS_WORLD_UNITS, lavaKey } from '../protocol.ts';

export type FlowWorld = Pick<WorldApi, 'worldSize' | 'heightAt'>;

export const FLOW_SPEED_WORLD_UNITS_PER_SECOND = 0.5;
export const FLOW_SPEED_CELLS_PER_SECOND = cellsAcross(FLOW_SPEED_WORLD_UNITS_PER_SECOND);

export const MAX_FLOW_CELLS = 64;

export const FLOW_THICKNESS = BAND_HEIGHT / 2;

export const FLOW_BRUSH_RADIUS = cellsAcross(FLOW_RADIUS_WORLD_UNITS);

export const MAX_TRACKED_FLOW_CELLS = 192;

export type FlowStop = 'water' | 'sea' | 'basin' | 'length';

const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function nextFlowCell(
  world: FlowWorld,
  freshwater: FreshwaterMap,
  x: number,
  y: number,
  visited: ReadonlySet<number>,
): { readonly x: number; readonly y: number } | FlowStop {
  const size = world.worldSize;
  const here = world.heightAt(x, y);

  let bestX = -1;
  let bestY = -1;
  let bestHeight = here;

  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (visited.has(lavaKey(nx, ny))) continue;

    const height = world.heightAt(nx, ny);
    if (height >= bestHeight) continue;
    bestHeight = height;
    bestX = nx;
    bestY = ny;
  }

  if (bestX < 0) return 'basin';

  if (freshwater.at(bestX, bestY) !== 'none') return 'water';
  if (bestHeight < SEA_LEVEL) return 'sea';

  return { x: bestX, y: bestY };
}
