import {
  CHUNK_SIZE,
  SEA_LEVEL,
  applyPackedSpans,
  cellIndex,
  chunkIndex,
  columnCoversBand,
  columnSampleAtBand,
  chunksPerEdge,
  createHeightmap,
  isValidHeight,
  writeChunkPayload,
  type ChunkPayload,
  type ChunkUnlockMessage,
  type Heightmap,
  type JoinSnapshotMessage,
  type TerrainDiffMessage,
} from '@terrace/shared';

export interface TerrainMirror {
  readonly map: Heightmap;
  /**
   * What the client draws: `map`, but unreceived halo cells carry their nearest
   * received neighbour's height, so the blend never mixes real ground with cells
   * that have not arrived.
   */
  readonly renderMap: Heightmap;
  readonly received: Set<number>;
}

/** A drawn chunk reads past its own cells: one for the coarsest skirt step, one for the blend. */
export const RENDER_HALO_CELLS = 2;

/** Orthogonal before diagonal, so a straight frontier pulls back along its own axis. */
const HALO_PROBE_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const orthogonal: [number, number][] = [];
  const diagonal: [number, number][] = [];
  for (let r = 1; r <= RENDER_HALO_CELLS; r++) {
    orthogonal.push([0, -r], [-r, 0], [r, 0], [0, r]);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 || dy === 0) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        diagonal.push([dx, dy]);
      }
    }
  }
  return [...orthogonal, ...diagonal];
})();

export function createTerrainMirror(worldSize: number): TerrainMirror {
  chunksPerEdge(worldSize);
  const map = createHeightmap(worldSize);
  return {
    map,
    renderMap: {
      size: map.size,
      cells: new Int16Array(map.cells.length),
      columnSpans: map.columnSpans,
    },
    received: new Set<number>(),
  };
}

export function sampleHeight(mirror: TerrainMirror, x: number, y: number): number {
  const max = mirror.map.size - 1;
  const cx = x < 0 ? 0 : x > max ? max : x;
  const cy = y < 0 ? 0 : y > max ? max : y;
  return mirror.map.cells[cellIndex(mirror.map, cx, cy)];
}

export function hasChunk(mirror: TerrainMirror, chunkIdx: number): boolean {
  return mirror.received.has(chunkIdx);
}

export function isCellReceived(mirror: TerrainMirror, x: number, y: number): boolean {
  const max = mirror.map.size - 1;
  const cx = x < 0 ? 0 : x > max ? max : x;
  const cy = y < 0 ? 0 : y > max ? max : y;
  return cellChunkReceived(mirror, cx, cy);
}

function cellChunkReceived(mirror: TerrainMirror, x: number, y: number): boolean {
  return mirror.received.has(
    chunkIndex(
      mirror.map.size,
      Math.floor(x / CHUNK_SIZE),
      Math.floor(y / CHUNK_SIZE),
    ),
  );
}

function nearestReceivedHeight(mirror: TerrainMirror, x: number, y: number): number {
  const map = mirror.map;
  for (const [dx, dy] of HALO_PROBE_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
    if (!cellChunkReceived(mirror, nx, ny)) continue;
    return map.cells[cellIndex(map, nx, ny)];
  }
  return SEA_LEVEL;
}

function refreshRenderCells(
  mirror: TerrainMirror,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const map = mirror.map;
  const last = map.size - 1;
  const toX = x1 > last ? last : x1;
  const toY = y1 > last ? last : y1;
  for (let y = y0 < 0 ? 0 : y0; y <= toY; y++) {
    for (let x = x0 < 0 ? 0 : x0; x <= toX; x++) {
      const i = cellIndex(map, x, y);
      mirror.renderMap.cells[i] = cellChunkReceived(mirror, x, y)
        ? map.cells[i]
        : nearestReceivedHeight(mirror, x, y);
    }
  }
}

/** For callers that fill `map` and `received` wholesale instead of applying chunk payloads. */
export function refreshRenderMap(mirror: TerrainMirror): void {
  const last = mirror.map.size - 1;
  refreshRenderCells(mirror, 0, 0, last, last);
}

/** Callers that write `mirror.map` outside this module must report every cell they changed. */
export function refreshRenderCellsAt(mirror: TerrainMirror, x: number, y: number): void {
  refreshRenderCells(
    mirror,
    x - RENDER_HALO_CELLS,
    y - RENDER_HALO_CELLS,
    x + RENDER_HALO_CELLS,
    y + RENDER_HALO_CELLS,
  );
}

export function sampleRenderHeight(mirror: TerrainMirror, x: number, y: number): number {
  const cell = renderSampleCell(mirror, x, y);
  return mirror.map.cells[cellIndex(mirror.map, cell.x, cell.y)];
}

export function sampleRenderBandHeight(
  mirror: TerrainMirror,
  x: number,
  y: number,
  band: number,
): number {
  const cell = renderSampleCell(mirror, x, y);
  return columnSampleAtBand(mirror.map, cell.x, cell.y, band);
}

export function sampleRenderBandSolid(
  mirror: TerrainMirror,
  x: number,
  y: number,
  band: number,
): boolean {
  const cell = renderSampleCell(mirror, x, y);
  return columnCoversBand(mirror.map, cell.x, cell.y, band);
}

function renderSampleCell(
  mirror: TerrainMirror,
  x: number,
  y: number,
): { x: number; y: number } {
  const max = mirror.map.size - 1;
  const sx = x < 0 ? 0 : x > max ? max : x;
  const sy = y < 0 ? 0 : y > max ? max : y;
  if (cellChunkReceived(mirror, sx, sy)) return { x: sx, y: sy };
  const onColumnSeam = sx > 0 && sx % CHUNK_SIZE === 0;
  const onRowSeam = sy > 0 && sy % CHUNK_SIZE === 0;
  if (onColumnSeam && onRowSeam) {
    if (cellChunkReceived(mirror, sx, sy - 1)) return { x: sx, y: sy - 1 };
    if (cellChunkReceived(mirror, sx - 1, sy)) return { x: sx - 1, y: sy };
    return { x: sx - 1, y: sy - 1 };
  }
  if (onColumnSeam) return { x: sx - 1, y: sy };
  if (onRowSeam) return { x: sx, y: sy - 1 };
  return { x: sx, y: sy };
}

export function chunksDirtiedByCell(
  mirror: TerrainMirror,
  x: number,
  y: number,
): number[] {
  const worldSize = mirror.map.size;
  const perEdge = chunksPerEdge(worldSize);
  const out: number[] = [];
  addSampleReaders(out, worldSize, perEdge, x, y);

  const lastInChunkColumn = (x + 1) % CHUNK_SIZE === 0;
  const lastInChunkRow = (y + 1) % CHUNK_SIZE === 0;
  if (lastInChunkColumn) addPullBackReaders(out, mirror, perEdge, x + 1, y, x, y);
  if (lastInChunkRow) addPullBackReaders(out, mirror, perEdge, x, y + 1, x, y);
  if (lastInChunkColumn && lastInChunkRow) {
    addPullBackReaders(out, mirror, perEdge, x + 1, y + 1, x, y);
  }
  return out;
}

function addChunk(
  out: number[],
  worldSize: number,
  perEdge: number,
  cx: number,
  cy: number,
): void {
  if (cx < 0 || cy < 0 || cx >= perEdge || cy >= perEdge) return;
  const idx = chunkIndex(worldSize, cx, cy);
  if (!out.includes(idx)) out.push(idx);
}

function addSampleReaders(
  out: number[],
  worldSize: number,
  perEdge: number,
  px: number,
  py: number,
): void {
  const cx = Math.floor(px / CHUNK_SIZE);
  const cy = Math.floor(py / CHUNK_SIZE);
  const onColumnSeam = px % CHUNK_SIZE === 0;
  const onRowSeam = py % CHUNK_SIZE === 0;
  addChunk(out, worldSize, perEdge, cx, cy);
  if (onColumnSeam) addChunk(out, worldSize, perEdge, cx - 1, cy);
  if (onRowSeam) addChunk(out, worldSize, perEdge, cx, cy - 1);
  if (onColumnSeam && onRowSeam) addChunk(out, worldSize, perEdge, cx - 1, cy - 1);
}

function addPullBackReaders(
  out: number[],
  mirror: TerrainMirror,
  perEdge: number,
  px: number,
  py: number,
  x: number,
  y: number,
): void {
  const read = renderSampleCell(mirror, px, py);
  if (read.x !== x || read.y !== y) return;
  addSampleReaders(out, mirror.map.size, perEdge, px, py);
}

export type CellWriteSink = (cellIdx: number) => void;

function applyChunkPayload(mirror: TerrainMirror, chunk: ChunkPayload): number[] {
  const worldSize = mirror.map.size;
  try {
    const rejected = writeChunkPayload(
      mirror.map,
      chunk.cx,
      chunk.cy,
      chunk.heights,
      chunk.layered,
    );
    if (rejected > 0) {
      console.warn(
        `[terrace] chunk (${chunk.cx},${chunk.cy}): dropped ${rejected} malformed layered column(s)`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[terrace] dropping malformed chunk (${chunk.cx},${chunk.cy}): ${message}`);
    return [];
  }

  const idx = chunkIndex(worldSize, chunk.cx, chunk.cy);
  mirror.received.add(idx);
  refreshRenderCells(
    mirror,
    chunk.cx * CHUNK_SIZE - RENDER_HALO_CELLS,
    chunk.cy * CHUNK_SIZE - RENDER_HALO_CELLS,
    (chunk.cx + 1) * CHUNK_SIZE - 1 + RENDER_HALO_CELLS,
    (chunk.cy + 1) * CHUNK_SIZE - 1 + RENDER_HALO_CELLS,
  );

  const dirty = [idx];
  if (chunk.cx > 0) dirty.push(chunkIndex(worldSize, chunk.cx - 1, chunk.cy));
  if (chunk.cy > 0) dirty.push(chunkIndex(worldSize, chunk.cx, chunk.cy - 1));
  if (chunk.cx > 0 && chunk.cy > 0) {
    dirty.push(chunkIndex(worldSize, chunk.cx - 1, chunk.cy - 1));
  }
  return dirty;
}

export function applySnapshot(
  mirror: TerrainMirror,
  msg: JoinSnapshotMessage,
): Set<number> {
  const dirty = new Set<number>();
  for (const chunk of msg.chunks) {
    for (const idx of applyChunkPayload(mirror, chunk)) dirty.add(idx);
  }
  return dirty;
}

export function applyChunkUnlock(
  mirror: TerrainMirror,
  msg: ChunkUnlockMessage,
): Set<number> {
  const dirty = new Set<number>();
  for (const chunk of msg.chunks) {
    for (const idx of applyChunkPayload(mirror, chunk)) dirty.add(idx);
  }
  return dirty;
}

export function applyTerrainDiff(
  mirror: TerrainMirror,
  msg: TerrainDiffMessage,
  onCellWrite?: CellWriteSink,
): Set<number> {
  const worldSize = mirror.map.size;
  const dirty = new Set<number>();
  let rejectedSpans = 0;

  for (const cell of msg.cells) {
    if (
      !Number.isInteger(cell.x) ||
      !Number.isInteger(cell.y) ||
      cell.x < 0 ||
      cell.y < 0 ||
      cell.x >= worldSize ||
      cell.y >= worldSize ||
      !isValidHeight(cell.h)
    ) {
      continue;
    }
    const i = cellIndex(mirror.map, cell.x, cell.y);
    onCellWrite?.(i);
    mirror.map.cells[i] = cell.h;

    if (cell.spans !== undefined && cell.spans[cell.spans.length - 1] !== cell.h) {
      rejectedSpans++;
      applyPackedSpans(mirror.map, cell.x, cell.y, undefined);
    } else if (!applyPackedSpans(mirror.map, cell.x, cell.y, cell.spans)) {
      rejectedSpans++;
    }
    refreshRenderCellsAt(mirror, cell.x, cell.y);

    if (onCellWrite === undefined) {
      for (const idx of chunksDirtiedByCell(mirror, cell.x, cell.y)) {
        dirty.add(idx);
      }
    }
  }
  if (rejectedSpans > 0) {
    console.warn(
      `[terrace] terrain diff: dropped ${rejectedSpans} malformed layered column(s)`,
    );
  }
  return dirty;
}
