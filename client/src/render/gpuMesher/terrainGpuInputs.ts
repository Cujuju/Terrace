import { CHUNK_SIZE, cellIndex, chunksPerEdge } from '@terrace/shared';
import { buriedFloorBand, sampleBandRange } from '../../terrain/capEmission.ts';
import { LATTICE_PER_CHUNK, SAMPLE_COUNT } from '../../terrain/contours.ts';
import { renderSampleCell, type TerrainMirror } from '../../terrain/mirror.ts';

export const WINDOW_LATTICE_SAMPLES = SAMPLE_COUNT;

/** Layered (floor, ceiling) pairs one chunk window may carry; past it the chunk is CPU work. */
export const WINDOW_SPAN_PAIRS = 2048;

export const SPAN_PAIR_WORDS = 2;

/** latticeDesc packs spanCount in the high half and the entry-local pair offset in the low. */
export const SPAN_COUNT_SHIFT = 16;
export const SPAN_OFFSET_MASK = (1 << SPAN_COUNT_SHIFT) - 1;

export const ENTRY_HEADER_WORDS = 16;

export const ENTRY_CHUNK_IDX = 0;
export const ENTRY_LAYERED = 1;
export const ENTRY_LOWEST_BAND = 2;
export const ENTRY_ORIGIN_X_CELLS = 4;
export const ENTRY_ORIGIN_Z_CELLS = 5;
export const ENTRY_LOCAL_ORIGIN_X_UNITS = 6;
export const ENTRY_LOCAL_ORIGIN_Z_UNITS = 7;
export const ENTRY_VERTEX_LIMIT = 9;

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

export interface WindowEntryData {
  readonly layered: boolean;
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

/**
 * The 17x17 lattice the CPU mesher would march, resolved through the same seam
 * pull-back, plus the chunk-level values makeLevels derives.
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

  const { lattice, latticeDesc, spanPairs } = scratch;
  let pairsUsed = 0;
  for (let j = 0; j < LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < LATTICE_PER_CHUNK; i++) {
      const cell = renderSampleCell(mirror, originXCells + i, originZCells + j);
      const index = cellIndex(map, cell.x, cell.y);
      const at = j * LATTICE_PER_CHUNK + i;
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
  const range = sampleBandRange(lattice, WINDOW_LATTICE_SAMPLES);
  const chunkLowestBand =
    floorBand !== null && floorBand < range.lowestBand ? floorBand : range.lowestBand;

  // The arrays alias a module-level scratch: the caller must upload before extracting again.
  return {
    layered: floorBand !== null,
    chunkLowestBand,
    highestBand: range.highestBand,
    originXCells,
    originZCells,
    lattice,
    latticeDesc,
    spanPairs: spanPairs.subarray(0, pairsUsed * SPAN_PAIR_WORDS),
  };
}
