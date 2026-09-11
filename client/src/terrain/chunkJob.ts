import { CHUNK_SIZE, applyPackedSpans, chunkIndex, chunksPerEdge } from '@terrace/shared';
import { CLIFF_PALETTE, TERRAIN_PALETTE } from './bandColors.ts';
import {
  COMPONENTS_PER_COLOR,
  COMPONENTS_PER_NORMAL,
  createChunkGeometryBuffers,
  writeChunkVertexData,
  type ChunkGeometryBuffers,
  type ChunkPalettes,
} from './capEmission.ts';
import {
  emitLipSegments,
  flattenCapPlan,
  type ChunkLipSegments,
  type FlatCapPlan,
} from './capPlanFlat.ts';
import { createTerrainMirror, type TerrainMirror } from './mirror.ts';
import { rasterizeLevels } from './drawnGroundStore.ts';

const JOB_WINDOW_REACH_CELLS = 1;

export const CHUNK_PALETTES: ChunkPalettes = {
  top: TERRAIN_PALETTE,
  cliff: CLIFF_PALETTE,
};

export interface ChunkJobRequest {
  readonly generation: number;
  readonly chunkIdx: number;
  readonly worldSize: number;
  readonly windowX: number;
  readonly windowY: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly heights: Int16Array;
  readonly spanCells: Int32Array;
  readonly spanStarts: Int32Array;
  readonly spanPacked: Int16Array;
  readonly receivedMask: number;
}

export interface ChunkJobAnswer {
  readonly kind: 'cpu';
  readonly generation: number;
  readonly chunkIdx: number;
  readonly vertexCount: number;
  readonly positions: Float32Array;
  readonly normals: Int8Array;
  readonly colors: Uint8Array;
  readonly bounds: Float32Array;
  readonly plan: FlatCapPlan;
  readonly topLevel: Int8Array;
  readonly lips: ChunkLipSegments;
}

export function chunkJobTransfers(answer: ChunkJobAnswer): ArrayBufferLike[] {
  return [
    answer.positions.buffer,
    answer.normals.buffer,
    answer.colors.buffer,
    answer.bounds.buffer,
    answer.plan.levelThreshold.buffer,
    answer.plan.levelSampleBand.buffer,
    answer.plan.levelCapY.buffer,
    answer.plan.levelPolygonStart.buffer,
    answer.plan.polygonLoopStart.buffer,
    answer.plan.loopPointStart.buffer,
    answer.plan.points.buffer,
    answer.plan.rects.buffer,
    answer.topLevel.buffer,
    answer.lips.positions.buffer,
    answer.lips.flat.buffer,
    answer.lips.bands.buffer,
  ];
}

export function chunkRequestTransfers(request: ChunkJobRequest): ArrayBufferLike[] {
  return [
    request.heights.buffer,
    request.spanCells.buffer,
    request.spanStarts.buffer,
    request.spanPacked.buffer,
  ];
}

export function extractChunkWindow(
  mirror: TerrainMirror,
  chunkIdx: number,
  generation: number,
): ChunkJobRequest {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const cx = chunkIdx % chunkCols;
  const cy = (chunkIdx - cx) / chunkCols;
  const originX = cx * CHUNK_SIZE;
  const originY = cy * CHUNK_SIZE;

  const windowX = Math.max(0, originX - JOB_WINDOW_REACH_CELLS);
  const windowY = Math.max(0, originY - JOB_WINDOW_REACH_CELLS);
  const windowRight = Math.min(worldSize - 1, originX + CHUNK_SIZE);
  const windowBottom = Math.min(worldSize - 1, originY + CHUNK_SIZE);
  const windowWidth = windowRight - windowX + 1;
  const windowHeight = windowBottom - windowY + 1;

  const heights = new Int16Array(windowWidth * windowHeight);
  const cells = mirror.map.cells;
  for (let j = 0; j < windowHeight; j++) {
    const from = (windowY + j) * worldSize + windowX;
    heights.set(cells.subarray(from, from + windowWidth), j * windowWidth);
  }

  const spanCells: number[] = [];
  const spanStarts: number[] = [0];
  const spanValues: number[] = [];
  const live = mirror.map.columnSpans;
  if (live.size > 0) {
    for (let j = 0; j < windowHeight; j++) {
      const rowStart = (windowY + j) * worldSize + windowX;
      for (let i = 0; i < windowWidth; i++) {
        const packed = live.get(rowStart + i);
        if (packed === undefined) continue;
        spanCells.push(rowStart + i);
        for (const value of packed) spanValues.push(value);
        spanStarts.push(spanValues.length);
      }
    }
  }

  let receivedMask = 0;
  for (let b = 0; b < 9; b++) {
    const nx = cx - 1 + (b % 3);
    const ny = cy - 1 + Math.floor(b / 3);
    if (nx < 0 || ny < 0 || nx >= chunkCols || ny >= chunkCols) continue;
    if (mirror.received.has(chunkIndex(worldSize, nx, ny))) receivedMask |= 1 << b;
  }

  return {
    generation,
    chunkIdx,
    worldSize,
    windowX,
    windowY,
    windowWidth,
    windowHeight,
    heights,
    spanCells: Int32Array.from(spanCells),
    spanStarts: Int32Array.from(spanStarts),
    spanPacked: Int16Array.from(spanValues),
    receivedMask,
  };
}

export interface ChunkJobWorkspace {
  mirror: TerrainMirror;
  scratch: ChunkGeometryBuffers;
}

export function createChunkJobWorkspace(worldSize: number): ChunkJobWorkspace {
  return { mirror: createTerrainMirror(worldSize), scratch: createChunkGeometryBuffers() };
}

export function loadWindow(
  workspace: ChunkJobWorkspace,
  request: ChunkJobRequest,
): TerrainMirror {
  const { mirror } = workspace;
  const worldSize = mirror.map.size;
  const cells = mirror.map.cells;
  for (let j = 0; j < request.windowHeight; j++) {
    const to = (request.windowY + j) * worldSize + request.windowX;
    cells.set(
      request.heights.subarray(j * request.windowWidth, (j + 1) * request.windowWidth),
      to,
    );
  }

  mirror.map.columnSpans.clear();
  for (let k = 0; k < request.spanCells.length; k++) {
    const i = request.spanCells[k]!;
    const packed = Array.from(
      request.spanPacked.subarray(request.spanStarts[k]!, request.spanStarts[k + 1]!),
    );
    applyPackedSpans(mirror.map, i % worldSize, Math.floor(i / worldSize), packed);
  }

  mirror.received.clear();
  const chunkCols = chunksPerEdge(worldSize);
  const cx = request.chunkIdx % chunkCols;
  const cy = (request.chunkIdx - cx) / chunkCols;
  for (let b = 0; b < 9; b++) {
    if ((request.receivedMask & (1 << b)) === 0) continue;
    const nx = cx - 1 + (b % 3);
    const ny = cy - 1 + Math.floor(b / 3);
    mirror.received.add(chunkIndex(worldSize, nx, ny));
  }
  return mirror;
}

export function buildChunkAnswer(
  mirror: TerrainMirror,
  workspaceScratch: ChunkGeometryBuffers,
  chunkIdx: number,
  generation: number,
): { answer: ChunkJobAnswer; scratch: ChunkGeometryBuffers } {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const cx = chunkIdx % chunkCols;
  const cy = (chunkIdx - cx) / chunkCols;

  const counts = writeChunkVertexData(mirror, cx, cy, workspaceScratch, CHUNK_PALETTES);
  const scratch = workspaceScratch;
  const vertexCount = counts.vertexCount;

  const positions = scratch.positions.slice(0, vertexCount * 3);
  const normals = scratch.normals.slice(0, vertexCount * COMPONENTS_PER_NORMAL);
  const colors = scratch.colors.slice(0, vertexCount * COMPONENTS_PER_COLOR);

  const bounds = new Float32Array(6);
  measureBounds(positions, vertexCount, bounds);

  const originX = cx * CHUNK_SIZE;
  const originZ = cy * CHUNK_SIZE;
  const plan = flattenCapPlan(counts.drawnCaps);
  const topLevel = rasterizeLevels(counts.drawnCaps, originX, originZ);
  const lips = emitLipSegments(counts.drawnCaps);

  return {
    scratch,
    answer: {
      kind: 'cpu',
      generation,
      chunkIdx,
      vertexCount,
      positions,
      normals,
      colors,
      bounds,
      plan,
      topLevel,
      lips,
    },
  };
}

function measureBounds(positions: Float32Array, vertexCount: number, out: Float32Array): void {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  out[0] = minX;
  out[1] = minY;
  out[2] = minZ;
  out[3] = maxX;
  out[4] = maxY;
  out[5] = maxZ;
}
