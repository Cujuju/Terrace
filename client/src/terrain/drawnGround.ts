import {
  CHUNK_SIZE,
  DRAWN_GROUND_CELL_CENTRE,
  drawnBandAt,
  drawnSampleCellIndex,
} from '@terrace/shared';
import { drawnSurface } from './drawnSurface.ts';
import { drawnBandOfSample } from '@terrace/shared';
import { isCellReceived, sampleRenderHeight } from './mirror.ts';
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

/** Public queries use rendered world cells; shared field coordinates are half a cell ahead. */
export function drawnFieldCoordinate(worldCell: number): number {
  return worldCell + DRAWN_GROUND_CELL_CENTRE;
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

export function drawnGroundYAt(
  mirror: TerrainMirror,
  ground: DrawnGround,
  cellX: number,
  cellZ: number,
): number | null {
  if (!Number.isFinite(cellX) || !Number.isFinite(cellZ)) return null;
  const max = mirror.map.size - 1;
  const clamp = (cell: number): number => Math.max(0, Math.min(max, cell));
  const sampleX = drawnSampleCellIndex(drawnFieldCoordinate(cellX));
  const sampleZ = drawnSampleCellIndex(drawnFieldCoordinate(cellZ));
  const x0 = clamp(sampleX), z0 = clamp(sampleZ);
  const x1 = clamp(sampleX + 1), z1 = clamp(sampleZ + 1);
  const eastChunk = chunkOf(x1) !== chunkOf(x0);
  const southChunk = chunkOf(z1) !== chunkOf(z0);
  const drawn = (x: number, z: number): boolean =>
    isCellReceived(mirror, x, z) && ground.isDrawnAt(x, z);
  if (!drawn(x0, z0)) return null;
  if (eastChunk && !drawn(x1, z0)) return null;
  if (southChunk && !drawn(x0, z1)) return null;
  if (eastChunk && southChunk && !drawn(x1, z1)) return null;
  return ground.capYAtFractional(cellX, cellZ);
}

export function createDrawnGround(mirror: TerrainMirror, store: DrawnGroundStore): DrawnGround {
  const chartAt = (cellX: number, cellZ: number): ChunkChart | null =>
    store.chartOf(chunkOf(cellX), chunkOf(cellZ));

  const drawnBandOf = (x: number, z: number): number => {
    const max = mirror.map.size - 1;
    const chart = chartAt(Math.max(0, Math.min(max, x)), Math.max(0, Math.min(max, z)));
    const fieldX = drawnFieldCoordinate(x);
    const fieldZ = drawnFieldCoordinate(z);
    return chart?.plan.blocky
      ? drawnBandOfSample(sampleRenderHeight(mirror, Math.floor(fieldX), Math.floor(fieldZ)))
      : drawnBandAt(mirror.map, fieldX, fieldZ, drawnSurface(mirror));
  };

  return {
    capYAt(cellX: number, cellZ: number): number {
      return drawnBandCapY(drawnBandOf(cellX, cellZ));
    },

    capYAtFractional(x: number, z: number): number {
      return drawnBandCapY(drawnBandOf(x, z));
    },

    bandAt(cellX: number, cellZ: number): number {
      return drawnBandOf(cellX, cellZ);
    },

    bandAtFractional(x: number, z: number): number {
      return drawnBandOf(x, z);
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
