import { CHUNK_SIZE, cellIndex, chunksPerEdge, SPAN_STRIDE, anyColumnLayered } from '@terrace/shared';
import { buriedFloorBand, sampleBandRange } from '../../terrain/capEmission.ts';
import { LATTICE_PER_CHUNK, SAMPLE_COUNT } from '../../terrain/contours.ts';
import { renderSampleCell, type TerrainMirror } from '../../terrain/mirror.ts';
import { drawnSurface } from '../../terrain/drawnSurface.ts';

export const WINDOW_LATTICE_EDGE = CHUNK_SIZE + 3;
export const WINDOW_LATTICE_SAMPLES = WINDOW_LATTICE_EDGE ** 2;

/** Layered (floor, ceiling) pairs one chunk window may carry; past it the chunk is CPU work. */
export const WINDOW_SPAN_PAIRS = 2048;

export const SPAN_PAIR_WORDS = SPAN_STRIDE;

/** latticeDesc packs spanCount in the high half and the entry-local pair offset in the low. */
export const SPAN_COUNT_SHIFT = 16;
export const SPAN_OFFSET_MASK = (1 << SPAN_COUNT_SHIFT) - 1;

export const ENTRY_HEADER_WORDS = 16;

export const ENTRY_CHUNK_IDX = 0;
export const ENTRY_LAYERED = 1;
export const ENTRY_LOWEST_BAND = 2;
/** Set when any of the eight neighbour chunks is unreceived or off-world. */
export const ENTRY_EXPOSED = 3;
export const ENTRY_ORIGIN_X_CELLS = 4;
export const ENTRY_ORIGIN_Z_CELLS = 5;
export const ENTRY_LOCAL_ORIGIN_X_UNITS = 6;
export const ENTRY_LOCAL_ORIGIN_Z_UNITS = 7;
export const ENTRY_VERTEX_LIMIT = 9;
export const ENTRY_SURFACE_SCALE = 8;
export const ENTRY_WORLD_SIZE = 10;
export const ENTRY_RECEIVED_MASK = 11;
/** Set when a layered column anywhere in the input window can change a band's field. */
export const ENTRY_BAND_FIELDS = 12;

export const SQUARES_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

export const CHUNK_STATS_WORDS = 4;
export const CHUNK_STATS_VERTEX_COUNT = 0;
export const CHUNK_STATS_COUNT_STAMP = 1;

/** The count pass stamps this; a cleared slot that still reads zero means it never ran. */
export const COUNT_PASS_STAMP = 0x5445_524d;

/** Words per appended lip: entry, band, then ax, az, bx, bz as bitcast f32. */
export const LIP_WORDS = 6;
export const LIP_ENTRY = 0;
export const LIP_BAND = 1;
export const LIP_AX = 2;

/** Chunks counted in one dispatch. Also the arena's backlog cap, so one drain is one batch. */
export const GPU_BATCH_CHUNKS = 64;

/** Two batches of entries stay resident, so an emit reads exactly what its count counted. */
export const GPU_WINDOW_POOL = 2 * GPU_BATCH_CHUNKS;

// Every read-only per-entry input shares one storage buffer: WebGPU guarantees only eight
// storage buffers a stage, and a binding apiece needed eleven.
export const WINDOW_LATTICE_AT = 0;
const WINDOW_LATTICE_WORDS = GPU_WINDOW_POOL * WINDOW_LATTICE_SAMPLES;
export const WINDOW_LATTICE_DESC_AT = WINDOW_LATTICE_AT + WINDOW_LATTICE_WORDS;
export const WINDOW_SPAN_PAIRS_AT = WINDOW_LATTICE_DESC_AT + WINDOW_LATTICE_WORDS;
const WINDOW_SPAN_PAIR_WORDS = GPU_WINDOW_POOL * WINDOW_SPAN_PAIRS * SPAN_PAIR_WORDS;
export const WINDOW_ENTRIES_AT = WINDOW_SPAN_PAIRS_AT + WINDOW_SPAN_PAIR_WORDS;
export const WINDOW_BATCH_LIST_AT = WINDOW_ENTRIES_AT + GPU_WINDOW_POOL * ENTRY_HEADER_WORDS;
export const WINDOW_BUFFER_WORDS = WINDOW_BATCH_LIST_AT + GPU_BATCH_CHUNKS;

/** squareBase then chunkStats, so both read-write count outputs cost one binding. */
export const STATS_SQUARE_BASE_AT = 0;
export const STATS_CHUNK_AT = STATS_SQUARE_BASE_AT + GPU_WINDOW_POOL * SQUARES_PER_CHUNK;
export const STATS_BUFFER_WORDS = STATS_CHUNK_AT + GPU_WINDOW_POOL * CHUNK_STATS_WORDS;

/** The append counter is word 0 of the lips buffer; records follow it. */
export const LIP_COUNTER_AT = 0;
export const LIP_RECORDS_AT = 1;

export const OVER_BUDGET = 'overBudget';

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1],
];

// Only drawn terrain further out hides a square's stacked lower caps, and how far out is
// a view angle, not a square count. So exposure is a whole-chunk property.
function exposedChunk(
  mirror: TerrainMirror,
  cx: number,
  cy: number,
  chunkCols: number,
): boolean {
  for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= chunkCols || ny >= chunkCols) return true;
    if (!mirror.received.has(ny * chunkCols + nx)) return true;
  }
  return false;
}

export interface WindowEntryData {
  readonly surfaceScale: number;
  readonly latticeEdge: number;
  readonly halo: number;
  readonly worldSize: number;
  readonly receivedMask: number;
  /** A layered column in the chunk's own lattice: undersides and full-depth caps. */
  readonly layered: boolean;
  readonly bandFields: boolean;
  readonly exposed: boolean;
  readonly chunkLowestBand: number;
  readonly highestBand: number;
  readonly originXCells: number;
  readonly originZCells: number;
  readonly lattice: Int32Array;
  readonly latticeDesc: Uint32Array;
  readonly spanPairs: Int32Array;
}

interface ExtractScratch {
  readonly lattice: Int32Array;
  readonly latticeDesc: Uint32Array;
  readonly spanPairs: Int32Array;
}

function createScratch(): ExtractScratch {
  return {
    lattice: new Int32Array(WINDOW_LATTICE_SAMPLES),
    latticeDesc: new Uint32Array(WINDOW_LATTICE_SAMPLES),
    spanPairs: new Int32Array(WINDOW_SPAN_PAIRS * SPAN_PAIR_WORDS),
  };
}

const scratch = createScratch();
const filteredCentral = new Int32Array(SAMPLE_COUNT);

/**
 * Raw uses the original 17x17 lattice; binomial adds one sample per side (19x19).
 * Incomplete stencils use the same render-sample pull-back as CPU queries.
 */
export function extractWindowEntry(
  mirror: TerrainMirror,
  chunkIdx: number,
): WindowEntryData | typeof OVER_BUDGET {
  const map = mirror.map;
  const chunkCols = chunksPerEdge(map.size);
  const cx = chunkIdx % chunkCols;
  const cy = (chunkIdx - cx) / chunkCols;
  const originXCells = cx * CHUNK_SIZE;
  const originZCells = cy * CHUNK_SIZE;

  const halo = mirror.surfaceMode === 'binomial' ? 1 : 0;
  const latticeEdge = LATTICE_PER_CHUNK + 2 * halo;
  const lattice = scratch.lattice.subarray(0, latticeEdge ** 2);
  const latticeDesc = scratch.latticeDesc.subarray(0, latticeEdge ** 2);
  const spanPairs = scratch.spanPairs;
  let pairsUsed = 0;
  for (let j = 0; j < latticeEdge; j++) {
    for (let i = 0; i < latticeEdge; i++) {
      const cell = renderSampleCell(mirror, originXCells + i - halo, originZCells + j - halo);
      const index = cellIndex(map, cell.x, cell.y);
      const at = j * latticeEdge + i;
      lattice[at] = map.cells[index]!;
      const packed = map.columnSpans.get(index);
      if (packed === undefined) {
        latticeDesc[at] = 0;
        continue;
      }
      const count = packed.length / SPAN_PAIR_WORDS;
      if (pairsUsed + count > WINDOW_SPAN_PAIRS) return OVER_BUDGET;
      spanPairs.set(packed, pairsUsed * SPAN_PAIR_WORDS);
      latticeDesc[at] = (count << SPAN_COUNT_SHIFT) | pairsUsed;
      pairsUsed += count;
    }
  }

  const floorBand = buriedFloorBand(mirror, originXCells, originZCells);
  const surface = drawnSurface(mirror);
  const central = surface ? filteredCentral : lattice;
  if (surface) {
    for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
      for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
        central[j * LATTICE_PER_CHUNK + i] = surface.sample(originXCells + i, originZCells + j, null);
      }
    }
  }
  const range = sampleBandRange(central, SAMPLE_COUNT, surface?.scale ?? 1);
  const highestBand = surface ? sampleBandRange(lattice, lattice.length).highestBand : range.highestBand;
  let receivedMask = 0;
  for (let b = 0; surface && b < 9; b++) {
    const nx = cx - 1 + b % 3, ny = cy - 1 + Math.floor(b / 3);
    if (nx >= 0 && ny >= 0 && nx < chunkCols && ny < chunkCols && mirror.received.has(ny * chunkCols + nx)) receivedMask |= 1 << b;
  }
  const x0 = Math.max(0, originXCells - halo), y0 = Math.max(0, originZCells - halo);
  const chunkLowestBand =
    floorBand !== null && floorBand < range.lowestBand ? floorBand : range.lowestBand;

  // The arrays alias a module-level scratch: the caller must upload before extracting again.
  return {
    surfaceScale: surface?.scale ?? 1,
    latticeEdge, halo,
    worldSize: map.size,
    receivedMask,
    layered: floorBand !== null,
    bandFields: floorBand !== null || (surface !== undefined && anyColumnLayered(map, x0, y0,
      Math.min(map.size, originXCells + CHUNK_SIZE + halo + 1) - x0,
      Math.min(map.size, originZCells + CHUNK_SIZE + halo + 1) - y0)),
    exposed: exposedChunk(mirror, cx, cy, chunkCols),
    chunkLowestBand,
    highestBand,
    originXCells,
    originZCells,
    lattice,
    latticeDesc,
    spanPairs: spanPairs.subarray(0, pairsUsed * SPAN_PAIR_WORDS),
  };
}
