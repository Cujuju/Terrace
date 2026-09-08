import { CHUNK_SIZE, chunksPerEdge } from '@terrace/shared';
import { BAND_GRID_CELLS } from './bandGrid.ts';
import { CLIFF_PALETTE, TERRAIN_PALETTE } from './bandColors.ts';
import { planChunkCaps, type ChunkDrawnCaps, type ChunkPalettes } from './capEmission.ts';
import {
  emitLipSegments,
  flattenCapPlan,
  rehydrateLevelPolygons,
  type ChunkLipSegments,
  type FlatCapPlan,
} from './capPlanFlat.ts';
import { type ContourLoop } from './contours.ts';
import { type TerrainMirror } from './mirror.ts';
import { type CapPolygon } from './triangulation.ts';

export { BAND_GRID_CELLS } from './bandGrid.ts';

const BAND_GRID_SAMPLES_PER_CELL = Math.round(1 / BAND_GRID_CELLS);

const BAND_GRID_EDGE = CHUNK_SIZE * BAND_GRID_SAMPLES_PER_CELL + 1;

const BAND_GRID_UNCOVERED = -1;

export interface ChunkChart {
  readonly originX: number;
  readonly originZ: number;
  readonly plan: FlatCapPlan;
  readonly topLevel: Int8Array;
  readonly lips: ChunkLipSegments;
  readonly polygonCache: (readonly CapPolygon[] | undefined)[];
}

export interface DrawnGroundStore {
  publish(chunkIdx: number, caps: ChunkDrawnCaps): void;
  publishRastered(
    chunkIdx: number,
    plan: FlatCapPlan,
    topLevel: Int8Array,
    lips: ChunkLipSegments,
  ): void;
  chartOf(chunkX: number, chunkZ: number): ChunkChart | null;
  clear(): void;
  size(): number;
}

export function topLevelIndexAt(chart: ChunkChart, cellX: number, cellZ: number): number | null {
  if (chart.topLevel.length === 0) return null;
  const i = clampToGrid(Math.round((cellX - chart.originX) / BAND_GRID_CELLS));
  const j = clampToGrid(Math.round((cellZ - chart.originZ) / BAND_GRID_CELLS));
  const value = chart.topLevel[j * BAND_GRID_EDGE + i]!;
  return value === BAND_GRID_UNCOVERED ? null : value;
}

export function polygonsOfLevel(chart: ChunkChart, levelIndex: number): readonly CapPolygon[] {
  const cached = chart.polygonCache[levelIndex];
  if (cached !== undefined) return cached;
  const built = rehydrateLevelPolygons(chart.plan, levelIndex);
  chart.polygonCache[levelIndex] = built;
  return built;
}

function clampToGrid(index: number): number {
  if (!(index >= 0)) return 0;
  if (index > BAND_GRID_EDGE - 1) return BAND_GRID_EDGE - 1;
  return index;
}

export function createDrawnGroundStore(worldSize: number): DrawnGroundStore {
  const chunkCols = chunksPerEdge(worldSize);
  const charts = new Map<number, ChunkChart>();

  const file = (
    chunkIdx: number,
    plan: FlatCapPlan,
    topLevel: Int8Array,
    lips: ChunkLipSegments,
  ): void => {
    const chunkX = chunkIdx % chunkCols;
    const chunkZ = (chunkIdx - chunkX) / chunkCols;
    charts.set(chunkIdx, {
      originX: chunkX * CHUNK_SIZE,
      originZ: chunkZ * CHUNK_SIZE,
      plan,
      topLevel,
      lips,
      polygonCache: new Array<readonly CapPolygon[] | undefined>(plan.levelThreshold.length),
    });
  };

  return {
    publish(chunkIdx: number, caps: ChunkDrawnCaps): void {
      const chunkX = chunkIdx % chunkCols;
      const chunkZ = (chunkIdx - chunkX) / chunkCols;
      file(
        chunkIdx,
        flattenCapPlan(caps),
        rasterizeLevels(caps, chunkX * CHUNK_SIZE, chunkZ * CHUNK_SIZE),
        emitLipSegments(caps),
      );
    },

    publishRastered(
      chunkIdx: number,
      plan: FlatCapPlan,
      topLevel: Int8Array,
      lips: ChunkLipSegments,
    ): void {
      file(chunkIdx, plan, topLevel, lips);
    },
    chartOf(chunkX: number, chunkZ: number): ChunkChart | null {
      if (chunkX < 0 || chunkZ < 0 || chunkX >= chunkCols || chunkZ >= chunkCols) return null;
      return charts.get(chunkZ * chunkCols + chunkX) ?? null;
    },
    clear(): void {
      charts.clear();
    },
    size(): number {
      return charts.size;
    },
  };
}

export function publishPlannedChunk(
  store: DrawnGroundStore,
  mirror: TerrainMirror,
  chunkX: number,
  chunkZ: number,
): void {
  const plan = planChunkCaps(mirror, chunkX, chunkZ, DRAWN_PALETTES);
  const caps: ChunkDrawnCaps = plan.overBudget
    ? { blocky: true, levels: [] }
    : {
        blocky: false,
        levels: plan.levels.map((level, index) => ({
          threshold: level.threshold,
          sampleBand: level.sampleBand,
          capY: level.capY,
          polygons: plan.polygonsPerLevel[index]!,
        })),
      };
  store.publish(chunkZ * chunksPerEdge(mirror.map.size) + chunkX, caps);
}

const DRAWN_PALETTES: ChunkPalettes = {
  top: TERRAIN_PALETTE,
  cliff: CLIFF_PALETTE,
};

export function publishPlannedWorld(store: DrawnGroundStore, mirror: TerrainMirror): void {
  const chunkCols = chunksPerEdge(mirror.map.size);
  for (const chunkIdx of mirror.received) {
    const chunkX = chunkIdx % chunkCols;
    publishPlannedChunk(store, mirror, chunkX, (chunkIdx - chunkX) / chunkCols);
  }
}

const rowCrossings: number[][] = Array.from({ length: BAND_GRID_EDGE }, () => []);

const ascending = (a: number, b: number): number => a - b;

export function rasterizeLevels(caps: ChunkDrawnCaps, originX: number, originZ: number): Int8Array {
  if (caps.blocky || caps.levels.length === 0) return new Int8Array(0);
  const grid = new Int8Array(BAND_GRID_EDGE * BAND_GRID_EDGE).fill(BAND_GRID_UNCOVERED);
  for (let index = 0; index < caps.levels.length; index++) {
    for (const polygon of caps.levels[index]!.polygons) {
      fillPolygon(grid, index, polygon, originX, originZ);
    }
  }
  return grid;
}

function fillPolygon(
  grid: Int8Array,
  levelIndex: number,
  polygon: CapPolygon,
  originX: number,
  originZ: number,
): void {
  let minRow = BAND_GRID_EDGE;
  let maxRow = -1;

  const bucketLoop = (loop: ContourLoop): void => {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i]!;
      const b = loop[j]!;
      const lowZ = a.z < b.z ? a.z : b.z;
      const highZ = a.z < b.z ? b.z : a.z;
      if (lowZ === highZ) continue;
      let firstRow = Math.ceil((lowZ - originZ) / BAND_GRID_CELLS);
      let lastRow = Math.ceil((highZ - originZ) / BAND_GRID_CELLS) - 1;
      if (firstRow < 0) firstRow = 0;
      if (lastRow > BAND_GRID_EDGE - 1) lastRow = BAND_GRID_EDGE - 1;
      for (let row = firstRow; row <= lastRow; row++) {
        const pz = originZ + row * BAND_GRID_CELLS;
        const t = (pz - a.z) / (b.z - a.z);
        rowCrossings[row]!.push(a.x + t * (b.x - a.x));
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
      }
    }
  };

  bucketLoop(polygon.outer);
  for (const hole of polygon.holes) bucketLoop(hole);

  for (let row = minRow; row <= maxRow; row++) {
    const crossings = rowCrossings[row]!;
    if (crossings.length === 0) continue;
    crossings.sort(ascending);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      let firstColumn = Math.ceil((crossings[k]! - originX) / BAND_GRID_CELLS);
      let lastColumn = Math.ceil((crossings[k + 1]! - originX) / BAND_GRID_CELLS) - 1;
      if (firstColumn < 0) firstColumn = 0;
      if (lastColumn > BAND_GRID_EDGE - 1) lastColumn = BAND_GRID_EDGE - 1;
      const rowStart = row * BAND_GRID_EDGE;
      for (let column = firstColumn; column <= lastColumn; column++) {
        grid[rowStart + column] = levelIndex;
      }
    }
    crossings.length = 0;
  }
}
