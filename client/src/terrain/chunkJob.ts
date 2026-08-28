// ONE CHUNK'S BUILD, AS A SELF-CONTAINED JOB.
//
// The chunk build — sample, march, smooth, triangulate, write vertices, plan
// the caps, rasterise the band grid, emit the terrace lips — is the single
// biggest thing a sculpt costs the main thread: ~6 ms per chunk on a developed
// world, against the project's 7.1 ms frame budget (140 fps). The drain queue
// in render/terrainMeshes.ts can spread SEVERAL chunks across frames but not
// ONE chunk across frames, because the pipeline is not resumable mid-chunk. So
// the chunk itself moves off the thread that draws.
//
// STATELESS, AND THAT IS THE WHOLE DESIGN. A worker that kept its own mirror
// fed by cell writes would have to be fed spans (which travel both on the wire
// and in predictions), rollbacks and rejoins, and any feed that misses one
// write draws terrain the player never made. Instead every job carries its own
// window of the world:
//
//   * HEIGHTS over [originX−1 .. originX+CHUNK_SIZE] on both axes — 18×18
//     cells, 648 bytes. The extra ring is NOT margin. The chunk is marched on a
//     17×17 lattice (cells origin+0 .. origin+CHUNK_SIZE), and
//     `renderSampleCell`'s frontier pull-back can step one cell back in x, in
//     y, or — at a lattice corner where both seams meet — diagonally, so a
//     sample on the chunk's first row can legitimately read the row above it.
//   * SPANS: the entries of `map.columnSpans` whose cell falls in that window,
//     in the packed layout `applyPackedSpans` already speaks. Free in an
//     uncarved world, where the table is empty.
//   * RECEIVED: a 3×3 bitmask of the chunk neighbourhood, because the pull-back
//     is a function of the received set and every cell in the window lies in
//     one of those nine chunks.
//   * A GENERATION stamp, bumped when the world is replaced, so an answer
//     computed against a world that no longer exists is dropped rather than
//     spliced.
//
// THE WORKER-SIDE MIRROR IS A REAL MIRROR, not an adapter. The samplers take a
// `TerrainMirror`, so the worker allocates one of the world's own size once and
// writes each job's window into its true cell positions before running the very
// same `writeChunkVertexData` the main thread runs. Nothing is forked, nothing
// is re-implemented, and there is no second opinion about the geometry to keep
// in agreement. Cells outside the window hold whatever an earlier job left
// there and are never read: every sample of this chunk's build lands inside the
// window, which is the point of the window's shape. The cost is one heightmap
// per worker (512 KB at 512², 8 MB at 2048²), which buys the guarantee that the
// worker and the main thread run identical code over identical inputs.
//
// WHAT COMES BACK IS TYPED ARRAYS AND NOTHING ELSE. The published cap plan is a
// tree of point objects on the main thread today; posting that tree across the
// boundary would move the whole cost into the receiving thread's deserialiser,
// which is the thread this exists to unload. It travels flat instead, and the
// points travel as Float64Array because `ContourPoint.x/z` are double-precision
// marching interpolants and the published contract is "the very polygons handed
// to the ear clipper" — a Float32 round trip would make the published polygon a
// different polygon from the drawn one, which is the producer/consumer
// disagreement four water rewrites died on.

import { CHUNK_SIZE, applyPackedSpans, chunkIndex, chunksPerEdge } from '@terrace/shared';
import { CLIFF_PALETTE, TERRAIN_PALETTE } from './bandColors.ts';
import {
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

/**
 * How far BEFORE its origin a chunk's job window reaches, in cells.
 *
 * ONE, and it is not margin. At the NE lattice corner the double-seam branch of
 * `renderSampleCell` (mirror.ts) can pull back one row above and one column
 * before the chunk's own 17 lattice columns, so a window that started at the
 * origin would sample a cell it had not been sent. Enforced in
 * `extractChunkWindow` below, which is the only place a window is cut; the
 * window is therefore at most CHUNK_SIZE + 1 + this = 18 cells on a side, and
 * smaller where it clamps to the world edge.
 */
const JOB_WINDOW_REACH_CELLS = 1;

/** The palettes every chunk is emitted with — one statement, both threads. */
export const CHUNK_PALETTES: ChunkPalettes = {
  top: TERRAIN_PALETTE,
  cliff: CLIFF_PALETTE,
};

/** One chunk build's complete input. Every field is transferable or a number. */
export interface ChunkJobRequest {
  /** Dropped on arrival if it no longer matches the live world. */
  readonly generation: number;
  readonly chunkIdx: number;
  readonly worldSize: number;
  /** Cell coordinate of the window's first column/row, already world-clamped. */
  readonly windowX: number;
  readonly windowY: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  /** Row-major heights over the window. */
  readonly heights: Int16Array;
  /** Flat cell indices of the window's layered columns; empty in an uncarved world. */
  readonly spanCells: Int32Array;
  /** Start of each column's packed run in `spanPacked`, plus a final end. */
  readonly spanStarts: Int32Array;
  readonly spanPacked: Int16Array;
  /**
   * Bit b of the 3×3 neighbourhood is set when chunk (cx − 1 + b % 3,
   * cy − 1 + floor(b / 3)) has been received. Out-of-world neighbours are 0,
   * which is what `cellChunkReceived` would say about them anyway.
   */
  readonly receivedMask: number;
}

/** One chunk build's complete output. */
export interface ChunkJobAnswer {
  readonly generation: number;
  readonly chunkIdx: number;
  readonly vertexCount: number;
  readonly positions: Float32Array;
  readonly normals: Int8Array;
  readonly colors: Uint8Array;
  readonly selfLit: Uint8Array;
  /** minX, minY, minZ, maxX, maxY, maxZ over the emitted vertices. */
  readonly bounds: Float32Array;
  readonly plan: FlatCapPlan;
  /** The band grid — see drawnGroundStore's `rasterizeLevels`. */
  readonly topLevel: Int8Array;
  readonly lips: ChunkLipSegments;
}

/** Every transferable buffer in an answer, for `postMessage`'s transfer list. */
export function chunkJobTransfers(answer: ChunkJobAnswer): ArrayBufferLike[] {
  return [
    answer.positions.buffer,
    answer.normals.buffer,
    answer.colors.buffer,
    answer.selfLit.buffer,
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

/** Every transferable buffer in a request. */
export function chunkRequestTransfers(request: ChunkJobRequest): ArrayBufferLike[] {
  return [
    request.heights.buffer,
    request.spanCells.buffer,
    request.spanStarts.buffer,
    request.spanPacked.buffer,
  ];
}

/**
 * Copies everything the chunk's build will read out of the live mirror.
 *
 * Read HERE, on the thread that owns the mirror, and never held: the arrays
 * below are the job's own and are transferred away from this thread.
 */
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

  // FREE IN AN UNCARVED WORLD: the table holds only columns with more than one
  // span, so the common case is a size check and three empty arrays.
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

/**
 * A worker's long-lived state: one mirror of the world's size and one geometry
 * scratch, both reused across jobs for the same amortisation reason
 * terrainMeshes' own scratch is reused.
 */
export interface ChunkJobWorkspace {
  mirror: TerrainMirror;
  scratch: ChunkGeometryBuffers;
}

export function createChunkJobWorkspace(worldSize: number): ChunkJobWorkspace {
  return { mirror: createTerrainMirror(worldSize), scratch: createChunkGeometryBuffers() };
}

/**
 * Writes one request's window into a workspace's mirror and returns it.
 *
 * The mirror is rewritten, not accumulated: `received` is cleared to exactly
 * this job's nine neighbours and the span table to exactly this window's
 * columns, so a job can never read another job's leftovers through either.
 * The heights outside the window are leftovers, and are never read — see the
 * module header.
 */
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
    // `applyPackedSpans` takes the wire's own `readonly number[]`, so the run
    // is handed over as one — the same shape a diff carries.
    const packed = Array.from(
      request.spanPacked.subarray(request.spanStarts[k]!, request.spanStarts[k + 1]!),
    );
    // Through the SHARED writer, so a packed run means here exactly what it
    // means on the wire and in the mirror.
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

/**
 * The chunk build itself — vertices, bounds, cap plan, band grid, lips.
 *
 * Runs unchanged on either thread: the worker calls it over a window-loaded
 * mirror, the direct source calls it over the live one.
 */
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

  // EXACT-SIZE COPIES, not the scratch itself: transferring the scratch would
  // detach it and move the doubled capacity rather than the live vertices, and
  // the next job would have to allocate a fresh one. This is the same
  // count-length copy the main thread used to make on its way into the
  // super-mesh, moved here.
  const positions = scratch.positions.slice(0, vertexCount * 3);
  const normals = scratch.normals.slice(0, vertexCount * 3);
  const colors = scratch.colors.slice(0, vertexCount * 3);
  const selfLit = scratch.selfLit.slice(0, vertexCount);

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
      generation,
      chunkIdx,
      vertexCount,
      positions,
      normals,
      colors,
      selfLit,
      bounds,
      plan,
      topLevel,
      lips,
    },
  };
}

/** min/max XYZ over the first `vertexCount` vertices, into `out`. */
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

