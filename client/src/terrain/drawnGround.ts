import {
  CHUNK_SIZE,
  DRAWN_GROUND_CELL_CENTRE,
  drawnBandAt,
} from '@terrace/shared';
import { drawnBandCapY } from './capEmission.ts';
import { type ContourLoop } from './contours.ts';
import {
  polygonsOfLevel,
  type ChunkChart,
  type DrawnGroundStore,
} from './drawnGroundStore.ts';
import { type TerrainMirror } from './mirror.ts';
import { type CapPolygon } from './triangulation.ts';

function chunkOf(cell: number): number {
  return Math.floor(cell / CHUNK_SIZE);
}

export interface DrawnGround {
  capYAt(cellX: number, cellZ: number): number;
  bandAt(cellX: number, cellZ: number): number;
  // Exact fractional spot for entity queries; cell probes use capYAt.
  capYAtFractional(x: number, z: number): number;
  bandAtFractional(x: number, z: number): number;
  nearestOnContour(
    threshold: number,
    cellX: number,
    cellZ: number,
  ): { x: number; z: number; loop: ContourLoop; index: number } | null;
  loopsAt(threshold: number, cellX: number, cellZ: number): readonly ContourLoop[];
  isDrawnAt(cellX: number, cellZ: number): boolean;
}

export function createDrawnGround(mirror: TerrainMirror, store: DrawnGroundStore): DrawnGround {
  const chartAt = (cellX: number, cellZ: number): ChunkChart | null =>
    store.chartOf(chunkOf(cellX), chunkOf(cellZ));

  const drawnBandOf = (cellX: number, cellZ: number): number =>
    drawnBandAt(
      mirror.map,
      cellX + DRAWN_GROUND_CELL_CENTRE,
      cellZ + DRAWN_GROUND_CELL_CENTRE,
    );

  const drawnBandOfFractional = (x: number, z: number): number =>
    drawnBandAt(mirror.map, x, z);

  return {
    capYAt(cellX: number, cellZ: number): number {
      return drawnBandCapY(drawnBandOf(cellX, cellZ));
    },

    capYAtFractional(x: number, z: number): number {
      return drawnBandCapY(drawnBandOfFractional(x, z));
    },

    bandAt(cellX: number, cellZ: number): number {
      return drawnBandOf(cellX, cellZ);
    },

    bandAtFractional(x: number, z: number): number {
      return drawnBandOfFractional(x, z);
    },

    nearestOnContour(threshold, cellX, cellZ) {
      let best: { x: number; z: number; loop: ContourLoop; index: number } | null = null;
      let bestDistanceSquared = Infinity;
      for (const loop of polygonsOfThreshold(chartAt(cellX, cellZ), threshold).flatMap(
        (p) => [p.outer, ...p.holes],
      )) {
        for (let i = 0; i < loop.length; i++) {
          const dx = loop[i]!.x - cellX;
          const dz = loop[i]!.z - cellZ;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestDistanceSquared) {
            bestDistanceSquared = d2;
            best = { x: loop[i]!.x, z: loop[i]!.z, loop, index: i };
          }
        }
      }
      return best;
    },

    loopsAt(threshold, cellX, cellZ) {
      return polygonsOfThreshold(chartAt(cellX, cellZ), threshold).map((p) => p.outer);
    },

    isDrawnAt(cellX, cellZ) {
      return chartAt(cellX, cellZ) !== null;
    },
  };
}

function polygonsOfThreshold(
  chart: ChunkChart | null,
  threshold: number,
): readonly CapPolygon[] {
  if (chart === null) return [];
  const thresholds = chart.plan.levelThreshold;
  for (let i = 0; i < thresholds.length; i++) {
    if (thresholds[i] === threshold) return polygonsOfLevel(chart, i);
  }
  return [];
}
