import { BAND_HEIGHT, CHUNK_SIZE, bandOf } from '@terrace/shared';
import { blockyCellCapY } from './capEmission.ts';
import { type ContourLoop } from './contours.ts';
import {
  polygonsOfLevel,
  topLevelIndexAt,
  type ChunkChart,
  type DrawnGroundStore,
} from './drawnGroundStore.ts';
import { sampleHeight, type TerrainMirror } from './mirror.ts';
import { type CapPolygon } from './triangulation.ts';

function chunkOf(cell: number): number {
  return Math.floor(cell / CHUNK_SIZE);
}

export interface DrawnGround {
  capYAt(cellX: number, cellZ: number): number;
  capYOfBand(band: number, cellX: number, cellZ: number): number;
  bandAt(cellX: number, cellZ: number): number;
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

  const topmostLevelAt = (chart: ChunkChart, cellX: number, cellZ: number): number | null => {
    const index = topLevelIndexAt(chart, cellX, cellZ);
    if (index === null || index >= chart.plan.levelThreshold.length) return null;
    return index;
  };

  const blockyHeightAt = (cellX: number, cellZ: number): number =>
    sampleHeight(mirror, Math.round(cellX), Math.round(cellZ));

  const hasNoContours = (chart: ChunkChart | null): chart is null =>
    chart === null || chart.plan.blocky;

  return {
    capYAt(cellX: number, cellZ: number): number {
      const chart = chartAt(cellX, cellZ);
      if (hasNoContours(chart)) return blockyCellCapY(blockyHeightAt(cellX, cellZ));
      const level = topmostLevelAt(chart, cellX, cellZ);
      if (level !== null) return chart.plan.levelCapY[level]!;
      return chart.plan.levelCapY.length > 0 ? chart.plan.levelCapY[0]! : 0;
    },

    capYOfBand(band: number, cellX: number, cellZ: number): number {
      const chart = chartAt(cellX, cellZ);
      if (!hasNoContours(chart)) {
        const { levelSampleBand, levelCapY } = chart.plan;
        for (let i = levelSampleBand.length - 1; i >= 0; i--) {
          if (levelSampleBand[i] === band) return levelCapY[i]!;
        }
      }
      return blockyCellCapY(band * BAND_HEIGHT);
    },

    bandAt(cellX: number, cellZ: number): number {
      const chart = chartAt(cellX, cellZ);
      if (hasNoContours(chart)) return bandOf(blockyHeightAt(cellX, cellZ));
      const level = topmostLevelAt(chart, cellX, cellZ);
      if (level !== null) return chart.plan.levelSampleBand[level]!;
      return chart.plan.levelSampleBand.length > 0 ? chart.plan.levelSampleBand[0]! : 0;
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
