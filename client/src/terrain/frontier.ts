import { CHUNK_SIZE, cellCentreCoord, drawnGroundHeight } from '@terrace/shared';
import type { TerrainMirror } from './mirror.ts';

export type FrontierDirection = 'N' | 'E' | 'S' | 'W';

export const FRONTIER_DIRECTIONS: readonly FrontierDirection[] = ['N', 'E', 'S', 'W'];

const NEIGHBOR_OFFSET: Readonly<Record<FrontierDirection, readonly [dx: number, dy: number]>> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
};

export interface FrontierEdge {
  readonly cx: number;
  readonly cy: number;
  readonly dir: FrontierDirection;
}

export function neighbourChunkIndex(edge: FrontierEdge, chunkCols: number): number | null {
  const [dx, dy] = NEIGHBOR_OFFSET[edge.dir];
  const nx = edge.cx + dx;
  const ny = edge.cy + dy;
  if (nx < 0 || nx >= chunkCols || ny < 0 || ny >= chunkCols) return null;
  return ny * chunkCols + nx;
}

export function frontierEdgeKey(edge: FrontierEdge): string {
  return `${edge.cx},${edge.cy},${edge.dir}`;
}

export function frontierEdges(
  received: ReadonlySet<number>,
  chunkCols: number,
): FrontierEdge[] {
  const orderedIndices = Array.from(received).sort((a, b) => a - b);
  const edges: FrontierEdge[] = [];
  for (const idx of orderedIndices) {
    const cx = idx % chunkCols;
    const cy = (idx - cx) / chunkCols;
    for (const dir of FRONTIER_DIRECTIONS) {
      const neighbour = neighbourChunkIndex({ cx, cy, dir }, chunkCols);
      const neighborReceived = neighbour !== null && received.has(neighbour);
      if (!neighborReceived) edges.push({ cx, cy, dir });
    }
  }
  return edges;
}

export interface FrontierEdgeSpan {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export function frontierEdgeSpan(edge: FrontierEdge): FrontierEdgeSpan {
  const x0 = edge.cx * CHUNK_SIZE;
  const z0 = edge.cy * CHUNK_SIZE;
  const x1 = x0 + CHUNK_SIZE;
  const z1 = z0 + CHUNK_SIZE;
  switch (edge.dir) {
    case 'N':
      return { x0, z0, x1, z1: z0 };
    case 'E':
      return { x0: x1, z0, x1, z1 };
    case 'S':
      return { x0: x1, z0: z1, x1: x0, z1 };
    case 'W':
      return { x0, z0: z1, x1: x0, z1: z0 };
  }
}

export interface FrontierEdgeSampling {
  readonly cellX: number;
  readonly cellY: number;
  readonly cellStepX: number;
  readonly cellStepY: number;
  readonly lineX: number;
  readonly lineZ: number;
  readonly lineStepX: number;
  readonly lineStepZ: number;
}

export function frontierEdgeSampling(edge: FrontierEdge): FrontierEdgeSampling {
  const x0 = edge.cx * CHUNK_SIZE;
  const y0 = edge.cy * CHUNK_SIZE;
  switch (edge.dir) {
    case 'N':
      return {
        cellX: x0, cellY: y0, cellStepX: 1, cellStepY: 0,
        lineX: x0, lineZ: y0, lineStepX: 1, lineStepZ: 0,
      };
    case 'S':
      return {
        cellX: x0, cellY: y0 + CHUNK_SIZE - 1, cellStepX: 1, cellStepY: 0,
        lineX: x0, lineZ: y0 + CHUNK_SIZE, lineStepX: 1, lineStepZ: 0,
      };
    case 'E':
      return {
        cellX: x0 + CHUNK_SIZE - 1, cellY: y0, cellStepX: 0, cellStepY: 1,
        lineX: x0 + CHUNK_SIZE, lineZ: y0, lineStepX: 0, lineStepZ: 1,
      };
    case 'W':
      return {
        cellX: x0, cellY: y0, cellStepX: 0, cellStepY: 1,
        lineX: x0, lineZ: y0, lineStepX: 0, lineStepZ: 1,
      };
  }
}

/** Frontier decoration sits on the drawn surface, not on the raw cell height. */
export function frontierEdgeCellGround(
  mirror: TerrainMirror,
  sampling: FrontierEdgeSampling,
  t: number,
): number {
  return drawnGroundHeight(
    mirror.renderMap,
    cellCentreCoord(sampling.cellX + t * sampling.cellStepX),
    cellCentreCoord(sampling.cellY + t * sampling.cellStepY),
  );
}
