import { BAND_HEIGHT, CHUNK_SIZE, chunksPerEdge } from '@terrace/shared';
import type { Renderer } from 'three/webgpu';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../../config.ts';
import {
  CHUNK_TRIANGLE_BUDGET,
  VERTICES_PER_TRIANGLE,
  drawnBandCapY,
  type ChunkDrawnCaps,
  type DrawnCapLevel,
} from '../../terrain/capEmission.ts';
import {
  LIP_LIFT_WORLD_UNITS,
  flattenCapPlan,
  type ChunkLipSegments,
} from '../../terrain/capPlanFlat.ts';
import type { TerrainMirror } from '../../terrain/mirror.ts';
import type { ChunkAnswer, ChunkBuildSource } from '../chunkBuildSource.ts';
import { TIMESTAMP_QUERY_FEATURE } from '../gpuTimer.ts';
import { SHORE_THRESHOLD, buildBandLut, LUT_COMPONENTS, LUT_VEC4_COUNT } from './bandLut.ts';
import {
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  type ChunkGpuAnswer,
  type GpuEmitHandle,
  type GpuEmitTarget,
} from './gpuChunkAnswer.ts';
import {
  MESHER_ENTRY_POINT,
  MODE_COUNT,
  MODE_EMIT,
  WORKGROUPS_PER_CHUNK,
  buildMesherWgsl,
} from './mesherWgsl.ts';
import {
  CHUNK_STATS_COUNT_STAMP,
  CHUNK_STATS_VERTEX_COUNT,
  CHUNK_STATS_WORDS,
  COUNT_PASS_STAMP,
  ENTRY_CHUNK_IDX,
  ENTRY_HEADER_WORDS,
  ENTRY_LAYERED,
  ENTRY_LOCAL_ORIGIN_X_UNITS,
  ENTRY_LOCAL_ORIGIN_Z_UNITS,
  ENTRY_LOWEST_BAND,
  ENTRY_ORIGIN_X_CELLS,
  ENTRY_ORIGIN_Z_CELLS,
  ENTRY_VERTEX_LIMIT,
  GPU_BATCH_CHUNKS,
  GPU_WINDOW_POOL,
  LIP_AX,
  LIP_BAND,
  LIP_COUNTER_AT,
  LIP_ENTRY,
  LIP_RECORDS_AT,
  LIP_WORDS,
  OVER_BUDGET,
  SPAN_PAIR_WORDS,
  SQUARES_PER_CHUNK,
  STATS_BUFFER_WORDS,
  STATS_CHUNK_AT,
  STATS_SQUARE_BASE_AT,
  WINDOW_BATCH_LIST_AT,
  WINDOW_BUFFER_WORDS,
  WINDOW_ENTRIES_AT,
  WINDOW_LATTICE_AT,
  WINDOW_LATTICE_DESC_AT,
  WINDOW_LATTICE_SAMPLES,
  WINDOW_SPAN_PAIRS,
  WINDOW_SPAN_PAIRS_AT,
  extractWindowEntry,
  type WindowEntryData,
} from './terrainGpuInputs.ts';

export { GPU_BATCH_CHUNKS, GPU_WINDOW_POOL };

export const GPU_CHUNK_VERTEX_BUDGET = CHUNK_TRIANGLE_BUDGET * VERTICES_PER_TRIANGLE;

export const GPU_READBACK_POOL_MIN = 2;
export const GPU_READBACK_POOL_MAX = 8;

/** Riser sub-segments one batch may append before the buffer doubles and it re-counts. */
export const LIP_APPEND_CAPACITY = 262_144;

export const GPU_MESHER_RESOLVE_EVERY_BATCHES = 8;

const BYTES_PER_WORD = 4;
const PARAMS_SLOT_BYTES = 256;
const PARAMS_WORDS = 4;
const PARAMS_MODE = 0;
const PARAMS_ENTRY = 1;
const PARAMS_BATCH_BASE = 2;
const PARAMS_LIP_CAPACITY = 3;
const READBACK_SECTION_ALIGNMENT = 256;

const TIMESTAMPS_PER_PASS = 2;
const TIMESTAMP_COUNT_BEGIN = 0;
const TIMESTAMP_COUNT_END = 1;
const TIMESTAMP_EMIT_BASE = 2;

/** Emit passes a frame can time. A frame splices a handful; beyond this they run untimed. */
export const GPU_EMIT_QUERY_PAIRS = 16;

const TIMESTAMP_QUERY_COUNT = TIMESTAMP_EMIT_BASE + GPU_EMIT_QUERY_PAIRS * TIMESTAMPS_PER_PASS;
const TIMESTAMP_BYTES_PER_QUERY = 8;
const NANOSECONDS_PER_MS = 1e6;

const NO_QUERY_PAIR = -1;

const LIP_POSITION_FLOATS_PER_SEGMENT = 6;
const LIP_FLAT_FLOATS_PER_SEGMENT = 4;
const LIP_BAND_TRIPLE_WORDS = 3;

/** ax, az, bx, bz: the record words the sort compares after the band. */
const LIP_COORD_WORDS = 4;

const NO_ENTRY = -1;

const CHUNK_SPAN_WORLD_UNITS = CHUNK_SIZE * CELL_WORLD_SIZE;

/** Group 0's window, stats and lips, plus group 1's positions and colours. */
const STORAGE_BUFFERS_PER_STAGE = 5;

/** Group 0's params and lut. */
const UNIFORM_BUFFERS_PER_STAGE = 2;

function demote(reason: string): null {
  console.warn(`[terrace] terrain mesher: ${reason}`);
  return null;
}

export interface GpuMesherStats {
  readonly countMs: number;
  readonly emitMs: number;
  readonly batches: number;
  readonly chunks: number;
}

export interface GpuChunkBuildSource extends ChunkBuildSource {
  stats(): GpuMesherStats;
  /** Records the frame's emit-query resolve. The arena store calls it on the encoder the
   *  emits were recorded into, so the queries resolve in the command buffer that wrote them. */
  recordEmitTimestamps(encoder: GPUCommandEncoder): void;
  /** Fires once when the device is lost; every later build takes the fallback regardless.
   *  Returns the unsubscribe. */
  onDeviceLost(handler: (reason: string) => void): () => void;
}

interface WebGpuBackendInternals {
  readonly isWebGPUBackend?: boolean;
  readonly device?: GPUDevice;
}

/** One batch's lip records, mapped straight off the readback: no per-segment objects. */
interface LipReadback {
  readonly words: Int32Array;
  readonly floats: Float32Array;
  readonly count: number;
}

interface QueuedChunk {
  readonly mirror: TerrainMirror;
  readonly chunkIdx: number;
  readonly generation: number;
  readonly settle: (answer: ChunkAnswer | null | Promise<ChunkAnswer | null>) => void;
}

interface BatchMember {
  readonly queued: QueuedChunk;
  readonly entry: number;
  readonly lowestBand: number;
  readonly highestBand: number;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function gpuCapPlan(lowestBand: number, highestBand: number): ChunkDrawnCaps {
  const levels: DrawnCapLevel[] = [];
  for (let k = lowestBand; k <= highestBand; k++) {
    const threshold = k * BAND_HEIGHT;
    levels.push({
      threshold,
      sampleBand: k,
      capY: drawnBandCapY(k, threshold),
      polygons: [],
    });
    if (k === 0) {
      levels.push({
        threshold: SHORE_THRESHOLD,
        sampleBand: 0,
        capY: drawnBandCapY(0, SHORE_THRESHOLD),
        polygons: [],
      });
    }
  }
  return { blocky: false, levels };
}

function levelRangeMinY(lowestBand: number): number {
  return drawnBandCapY(lowestBand, lowestBand * BAND_HEIGHT);
}

/** The shoreline level caps at world y 0, above band 0's sunken cap. */
function levelRangeMaxY(lowestBand: number, highestBand: number): number {
  const top = drawnBandCapY(highestBand, highestBand * BAND_HEIGHT);
  const hasShore = lowestBand <= 0 && highestBand >= 0;
  return hasShore ? Math.max(top, drawnBandCapY(0, SHORE_THRESHOLD)) : top;
}

function chunkCornerX(mirror: TerrainMirror, chunkIdx: number): number {
  return (chunkIdx % chunksPerEdge(mirror.map.size)) * CHUNK_SPAN_WORLD_UNITS;
}

function chunkCornerZ(mirror: TerrainMirror, chunkIdx: number): number {
  const chunkCols = chunksPerEdge(mirror.map.size);
  return ((chunkIdx - (chunkIdx % chunkCols)) / chunkCols) * CHUNK_SPAN_WORLD_UNITS;
}

/** Sorts record indices in place, reading the coordinates through the mapped views. */
function sortLipOrder(order: number[], lips: LipReadback): void {
  const { words, floats } = lips;
  order.sort((a, b) => {
    const x = a * LIP_WORDS;
    const y = b * LIP_WORDS;
    if (words[x + LIP_BAND] !== words[y + LIP_BAND]) {
      return words[x + LIP_BAND]! - words[y + LIP_BAND]!;
    }
    for (let c = 0; c < LIP_COORD_WORDS; c++) {
      const difference = floats[x + LIP_AX + c]! - floats[y + LIP_AX + c]!;
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

function buildLipSegments(order: number[], lips: LipReadback): ChunkLipSegments {
  sortLipOrder(order, lips);
  const { words, floats } = lips;
  const positions = new Float32Array(order.length * LIP_POSITION_FLOATS_PER_SEGMENT);
  const flat = new Float32Array(order.length * LIP_FLAT_FLOATS_PER_SEGMENT);
  const bands: number[] = [];
  let runBand = 0;
  let runStart = 0;
  for (let i = 0; i < order.length; i++) {
    const at = order[i]! * LIP_WORDS;
    const band = words[at + LIP_BAND]!;
    const ax = floats[at + LIP_AX]!;
    const az = floats[at + LIP_AX + 1]!;
    const bx = floats[at + LIP_AX + 2]!;
    const bz = floats[at + LIP_AX + 3]!;
    const y = band * BAND_HEIGHT * HEIGHT_WORLD_SCALE + LIP_LIFT_WORLD_UNITS;
    const p = i * LIP_POSITION_FLOATS_PER_SEGMENT;
    positions[p] = ax;
    positions[p + 1] = y;
    positions[p + 2] = az;
    positions[p + 3] = bx;
    positions[p + 4] = y;
    positions[p + 5] = bz;
    const f = i * LIP_FLAT_FLOATS_PER_SEGMENT;
    flat[f] = ax;
    flat[f + 1] = az;
    flat[f + 2] = bx;
    flat[f + 3] = bz;
    if (i === 0 || band !== runBand) {
      if (i > 0) bands.push(runBand, runStart, i - runStart);
      runBand = band;
      runStart = i;
    }
  }
  if (order.length > 0) bands.push(runBand, runStart, order.length - runStart);
  return { positions, flat, bands: Int32Array.from(bands) };
}

/** World-independent, so one session builds one source; `null` demotes the session to
 *  `fallback`, which the caller keeps owning. */
export async function createGpuChunkBuildSource(
  renderer: Renderer,
  fallback: ChunkBuildSource,
): Promise<GpuChunkBuildSource | null> {
  const backend = renderer.backend as unknown as WebGpuBackendInternals;
  if (backend.isWebGPUBackend !== true) {
    return demote('the renderer is not running the WebGPU backend');
  }
  const device = backend.device;
  if (device === undefined) return demote('the WebGPU backend has no device yet');

  const limits = device.limits;
  if (limits.maxStorageBuffersPerShaderStage < STORAGE_BUFFERS_PER_STAGE) {
    return demote(
      `the device allows ${String(limits.maxStorageBuffersPerShaderStage)} storage buffers a ` +
        `compute stage; the kernel binds ${String(STORAGE_BUFFERS_PER_STAGE)}`,
    );
  }
  if (limits.maxUniformBuffersPerShaderStage < UNIFORM_BUFFERS_PER_STAGE) {
    return demote(
      `the device allows ${String(limits.maxUniformBuffersPerShaderStage)} uniform buffers a ` +
        `compute stage; the kernel binds ${String(UNIFORM_BUFFERS_PER_STAGE)}`,
    );
  }
  if (limits.maxUniformBufferBindingSize < LUT_VEC4_COUNT * LUT_COMPONENTS * BYTES_PER_WORD) {
    return demote('the band LUT does not fit the device uniform-buffer binding size');
  }

  const queue = device.queue;
  const STORAGE_READ = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const STORAGE_RW = STORAGE_READ | GPUBufferUsage.COPY_SRC;

  const create = (label: string, size: number, usage: number): GPUBuffer =>
    device.createBuffer({ label: `terrace.gpuMesher.${label}`, size, usage });

  const windowBuffer = create('window', WINDOW_BUFFER_WORDS * BYTES_PER_WORD, STORAGE_READ);
  const statsBuffer = create('stats', STATS_BUFFER_WORDS * BYTES_PER_WORD, STORAGE_RW);
  const lutBuffer = create(
    'lut',
    LUT_VEC4_COUNT * LUT_COMPONENTS * BYTES_PER_WORD,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  );
  const paramsBuffer = create(
    'params',
    (GPU_WINDOW_POOL + 1) * PARAMS_SLOT_BYTES,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  );
  const dummyPositions = create('dummyPositions', BYTES_PER_WORD, STORAGE_RW);
  const dummyColors = create('dummyColors', BYTES_PER_WORD, STORAGE_RW);

  const lipsBufferWords = (capacity: number): number => LIP_RECORDS_AT + capacity * LIP_WORDS;

  let lipCapacity = LIP_APPEND_CAPACITY;
  let lipsBuffer = create('lips', lipsBufferWords(lipCapacity) * BYTES_PER_WORD, STORAGE_RW);

  queue.writeBuffer(lutBuffer, 0, buildBandLut());

  const COUNT_PARAMS_SLOT = GPU_WINDOW_POOL;
  const writeParams = (): void => {
    const slots = new Int32Array(((GPU_WINDOW_POOL + 1) * PARAMS_SLOT_BYTES) / BYTES_PER_WORD);
    const stride = PARAMS_SLOT_BYTES / BYTES_PER_WORD;
    for (let e = 0; e < GPU_WINDOW_POOL; e++) {
      slots[e * stride + PARAMS_MODE] = MODE_EMIT;
      slots[e * stride + PARAMS_ENTRY] = e;
      slots[e * stride + PARAMS_BATCH_BASE] = 0;
      slots[e * stride + PARAMS_LIP_CAPACITY] = lipCapacity;
    }
    slots[COUNT_PARAMS_SLOT * stride + PARAMS_MODE] = MODE_COUNT;
    slots[COUNT_PARAMS_SLOT * stride + PARAMS_LIP_CAPACITY] = lipCapacity;
    queue.writeBuffer(paramsBuffer, 0, slots);
  };
  writeParams();

  const ownedBuffers = (): readonly GPUBuffer[] => [
    windowBuffer,
    statsBuffer,
    lutBuffer,
    paramsBuffer,
    lipsBuffer,
    dummyPositions,
    dummyColors,
  ];

  /** Every path that gives up before the source exists hands the buffers back first. */
  const refuse = (reason: string): null => {
    for (const buffer of ownedBuffers()) buffer.destroy();
    return demote(reason);
  };

  const storageEntry = (
    binding: number,
    type: 'storage' | 'read-only-storage',
  ): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type },
  });

  const module = device.createShaderModule({
    label: 'terrace.gpuMesher.mesher',
    code: buildMesherWgsl(),
  });
  // A device that will not report compilation info has not failed to compile.
  const compilation = await module.getCompilationInfo().catch(() => null);
  const compileErrors = (compilation?.messages ?? []).filter((m) => m.type === 'error');
  if (compileErrors.length > 0) {
    return refuse(
      `the WGSL failed to compile:\n${compileErrors
        .map((m) => `${String(m.lineNum)}:${String(m.linePos)} ${m.message}`)
        .join('\n')}`,
    );
  }

  device.pushErrorScope('validation');
  const group0Layout = device.createBindGroupLayout({
    label: 'terrace.gpuMesher.group0',
    entries: [
      storageEntry(0, 'read-only-storage'),
      storageEntry(1, 'storage'),
      storageEntry(2, 'storage'),
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAMS_WORDS * BYTES_PER_WORD },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      },
    ],
  });
  const group1Layout = device.createBindGroupLayout({
    label: 'terrace.gpuMesher.group1',
    entries: [storageEntry(0, 'storage'), storageEntry(1, 'storage')],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [group0Layout, group1Layout],
  });

  const createGroup0 = (): GPUBindGroup =>
    device.createBindGroup({
      label: 'terrace.gpuMesher.bind0',
      layout: group0Layout,
      entries: [
        { binding: 0, resource: { buffer: windowBuffer } },
        { binding: 1, resource: { buffer: statsBuffer } },
        { binding: 2, resource: { buffer: lipsBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer, size: PARAMS_WORDS * BYTES_PER_WORD } },
        { binding: 4, resource: { buffer: lutBuffer } },
      ],
    });
  let group0 = createGroup0();
  const countGroup1 = device.createBindGroup({
    label: 'terrace.gpuMesher.bind1.count',
    layout: group1Layout,
    entries: [
      { binding: 0, resource: { buffer: dummyPositions } },
      { binding: 1, resource: { buffer: dummyColors } },
    ],
  });
  const layoutError = await device.popErrorScope();
  if (layoutError !== null) {
    return refuse(`the bind groups were refused (${layoutError.message})`);
  }

  let pipeline: GPUComputePipeline;
  try {
    pipeline = await device.createComputePipelineAsync({
      label: 'terrace.gpuMesher.pipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: MESHER_ENTRY_POINT },
    });
  } catch (error) {
    return refuse(`the compute pipeline was refused (${String(error)})`);
  }

  const emitGroups = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
  const emitGroupFor = (target: GpuEmitTarget): GPUBindGroup => {
    let byColor = emitGroups.get(target.positions);
    if (byColor === undefined) {
      byColor = new WeakMap<GPUBuffer, GPUBindGroup>();
      emitGroups.set(target.positions, byColor);
    }
    const cached = byColor.get(target.colors);
    if (cached !== undefined) return cached;
    const group = device.createBindGroup({
      label: 'terrace.gpuMesher.bind1.emit',
      layout: group1Layout,
      entries: [
        { binding: 0, resource: { buffer: target.positions } },
        { binding: 1, resource: { buffer: target.colors } },
      ],
    });
    byColor.set(target.colors, group);
    return group;
  };

  const timestampsSupported =
    renderer.hasFeature(TIMESTAMP_QUERY_FEATURE) && device.features.has(TIMESTAMP_QUERY_FEATURE);
  const querySet = timestampsSupported
    ? device.createQuerySet({ label: 'terrace.gpuMesher.timestamps', type: 'timestamp', count: TIMESTAMP_QUERY_COUNT })
    : null;
  // Count and emit resolve into separate buffers: each pass's queries have to be resolved
  // in the command buffer that wrote them, and those are two different encoders.
  const timestampPair = (
    label: string,
    queries: number,
  ): { resolve: GPUBuffer; readback: GPUBuffer } | null =>
    timestampsSupported
      ? {
          resolve: create(
            `${label}Resolve`,
            queries * TIMESTAMP_BYTES_PER_QUERY,
            GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
          ),
          readback: create(
            `${label}Readback`,
            queries * TIMESTAMP_BYTES_PER_QUERY,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          ),
        }
      : null;
  const countTimestamps = timestampPair('countTimestamp', TIMESTAMPS_PER_PASS);
  const emitTimestamps = timestampPair(
    'emitTimestamp',
    GPU_EMIT_QUERY_PAIRS * TIMESTAMPS_PER_PASS,
  );

  // The counts readback is fixed size and always mapped; the lips readback is copied and
  // mapped afterwards, over exactly the records the counter reported.
  const statsBytes = STATS_BUFFER_WORDS * BYTES_PER_WORD;
  const readbackStatsAt = 0;
  const readbackLipCounterAt = alignUp(statsBytes, READBACK_SECTION_ALIGNMENT);
  const countsReadbackBytes = readbackLipCounterAt + READBACK_SECTION_ALIGNMENT;
  const lipsReadbackBytes = (): number => lipCapacity * LIP_WORDS * BYTES_PER_WORD;

  const READBACK_USAGE = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;

  interface ReadbackPool {
    readonly free: GPUBuffer[];
    live: number;
  }
  const countsPool: ReadbackPool = { free: [], live: 0 };
  const lipsPool: ReadbackPool = { free: [], live: 0 };

  const takeFrom = (pool: ReadbackPool, label: string, bytes: number): GPUBuffer | null => {
    const free = pool.free.pop();
    if (free !== undefined) return free;
    if (pool.live >= GPU_READBACK_POOL_MAX) return null;
    pool.live++;
    return create(`${label}${pool.live}`, bytes, READBACK_USAGE);
  };
  const giveBackTo = (pool: ReadbackPool, buffer: GPUBuffer, bytes: number): void => {
    if (buffer.size !== bytes || pool.free.length >= GPU_READBACK_POOL_MAX) {
      buffer.destroy();
      pool.live--;
      return;
    }
    pool.free.push(buffer);
  };

  const takeReadback = (): GPUBuffer | null =>
    takeFrom(countsPool, 'countsReadback', countsReadbackBytes);
  const giveBackReadback = (buffer: GPUBuffer): void => {
    giveBackTo(countsPool, buffer, countsReadbackBytes);
  };
  const takeLipsReadback = (): GPUBuffer | null =>
    takeFrom(lipsPool, 'lipsReadback', lipsReadbackBytes());
  const giveBackLipsReadback = (buffer: GPUBuffer): void => {
    giveBackTo(lipsPool, buffer, lipsReadbackBytes());
  };

  /** After the lips buffer doubles the free lip readbacks are the wrong size; in-flight ones
   *  are dropped when they come back. */
  const dropFreeReadbacks = (): void => {
    for (const buffer of lipsPool.free.splice(0, lipsPool.free.length)) {
      buffer.destroy();
      lipsPool.live--;
    }
  };
  for (let i = 0; i < GPU_READBACK_POOL_MIN; i++) {
    countsPool.live++;
    countsPool.free.push(
      create(`countsReadback${countsPool.live}`, countsReadbackBytes, READBACK_USAGE),
    );
  }

  const freeEntries: number[] = [];
  for (let e = GPU_WINDOW_POOL - 1; e >= 0; e--) freeEntries.push(e);
  const entryHeld = new Uint8Array(GPU_WINDOW_POOL);
  const releaseEntry = (entry: number): void => {
    if (entryHeld[entry] !== 1) return;
    entryHeld[entry] = 0;
    freeEntries.push(entry);
  };

  /** CPU mirror of the entry headers, so an emit patches without re-deriving the rest. */
  const headers = new Int32Array(GPU_WINDOW_POOL * ENTRY_HEADER_WORDS);
  const prefix = new Uint32Array(SQUARES_PER_CHUNK);
  const batchList = new Int32Array(GPU_BATCH_CHUNKS);
  const uploadHeader = (entry: number): void => {
    queue.writeBuffer(
      windowBuffer,
      (WINDOW_ENTRIES_AT + entry * ENTRY_HEADER_WORDS) * BYTES_PER_WORD,
      headers,
      entry * ENTRY_HEADER_WORDS,
      ENTRY_HEADER_WORDS,
    );
  };

  let disposed = false;
  let deviceLost = false;
  const deviceLostHandlers = new Set<(reason: string) => void>();
  void device.lost.then((info) => {
    deviceLost = true;
    const reason = `the WebGPU device was lost (${info.reason}: ${info.message})`;
    for (const handler of deviceLostHandlers) handler(reason);
  });

  let batches = 0;
  let chunks = 0;
  let countMs = 0;
  let emitMs = 0;
  let batchesSinceResolve = 0;
  let countTimestampInFlight = false;
  let emitTimestampInFlight = false;
  /** Emit query pairs this frame has written, reset when the store resolves them. */
  let emitPairsUsed = 0;
  let emitPairsResolving = 0;

  const growLips = (): void => {
    lipCapacity *= 2;
    lipsBuffer.destroy();
    lipsBuffer = create('lips', lipsBufferWords(lipCapacity) * BYTES_PER_WORD, STORAGE_RW);
    group0 = createGroup0();
    writeParams();
    dropFreeReadbacks();
  };

  const makeHandle = (
    entry: number,
    counts: Uint32Array,
    vertexCount: number,
    minY: number,
    maxY: number,
    originX: number,
    originZ: number,
  ): GpuEmitHandle => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    };
    return {
      minY,
      maxY,
      originX,
      originZ,
      emit(encoder: GPUCommandEncoder, target: GpuEmitTarget, vertexOffset: number): boolean {
        if (released || disposed || deviceLost) {
          release();
          return false;
        }
        let acc = vertexOffset;
        for (let i = 0; i < SQUARES_PER_CHUNK; i++) {
          prefix[i] = acc;
          acc += counts[i]!;
        }
        queue.writeBuffer(
          statsBuffer,
          (STATS_SQUARE_BASE_AT + entry * SQUARES_PER_CHUNK) * BYTES_PER_WORD,
          prefix,
        );
        const at = entry * ENTRY_HEADER_WORDS;
        headers[at + ENTRY_VERTEX_LIMIT] = vertexOffset + vertexCount;
        headers[at + ENTRY_LOCAL_ORIGIN_X_UNITS] = Math.round(
          target.localOriginX * POSITION_XZ_UNITS_PER_WORLD_UNIT,
        );
        headers[at + ENTRY_LOCAL_ORIGIN_Z_UNITS] = Math.round(
          target.localOriginZ * POSITION_XZ_UNITS_PER_WORLD_UNIT,
        );
        uploadHeader(entry);
        // Its own query pair, so a frame's emits sum instead of the last one overwriting.
        const pair =
          querySet === null || emitPairsUsed >= GPU_EMIT_QUERY_PAIRS
            ? NO_QUERY_PAIR
            : emitPairsUsed++;
        const pass = encoder.beginComputePass({
          label: 'terrace.gpuMesher.emit',
          timestampWrites:
            querySet === null || pair === NO_QUERY_PAIR
              ? undefined
              : {
                  querySet,
                  beginningOfPassWriteIndex: TIMESTAMP_EMIT_BASE + pair * TIMESTAMPS_PER_PASS,
                  endOfPassWriteIndex: TIMESTAMP_EMIT_BASE + pair * TIMESTAMPS_PER_PASS + 1,
                },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group0, [entry * PARAMS_SLOT_BYTES]);
        pass.setBindGroup(1, emitGroupFor(target));
        pass.dispatchWorkgroups(WORKGROUPS_PER_CHUNK);
        pass.end();
        release();
        return true;
      },
      release,
    };
  };

  const resolveTimestamps = (encoder: GPUCommandEncoder): boolean => {
    if (querySet === null || countTimestamps === null) return false;
    batchesSinceResolve++;
    if (batchesSinceResolve < GPU_MESHER_RESOLVE_EVERY_BATCHES) return false;
    if (countTimestampInFlight || countTimestamps.readback.mapState !== 'unmapped') return false;
    batchesSinceResolve = 0;
    countTimestampInFlight = true;
    encoder.resolveQuerySet(
      querySet,
      TIMESTAMP_COUNT_BEGIN,
      TIMESTAMPS_PER_PASS,
      countTimestamps.resolve,
      0,
    );
    encoder.copyBufferToBuffer(
      countTimestamps.resolve,
      0,
      countTimestamps.readback,
      0,
      TIMESTAMPS_PER_PASS * TIMESTAMP_BYTES_PER_QUERY,
    );
    return true;
  };

  const readTimestamps = (): void => {
    if (countTimestamps === null) return;
    const readback = countTimestamps.readback;
    void readback.mapAsync(GPUMapMode.READ).then(
      () => {
        const stamps = new BigUint64Array(readback.getMappedRange().slice(0));
        readback.unmap();
        countTimestampInFlight = false;
        const count = stamps[TIMESTAMP_COUNT_END]! - stamps[TIMESTAMP_COUNT_BEGIN]!;
        if (count > 0n) countMs = Number(count) / NANOSECONDS_PER_MS;
      },
      () => {
        countTimestampInFlight = false;
      },
    );
  };

  const readEmitTimestamps = (): void => {
    if (emitTimestamps === null) return;
    const readback = emitTimestamps.readback;
    const pairs = emitPairsResolving;
    const bytes = pairs * TIMESTAMPS_PER_PASS * TIMESTAMP_BYTES_PER_QUERY;
    void readback.mapAsync(GPUMapMode.READ, 0, bytes).then(
      () => {
        const stamps = new BigUint64Array(readback.getMappedRange(0, bytes).slice(0));
        readback.unmap();
        emitTimestampInFlight = false;
        let total = 0n;
        for (let p = 0; p < pairs; p++) {
          const span = stamps[p * TIMESTAMPS_PER_PASS + 1]! - stamps[p * TIMESTAMPS_PER_PASS]!;
          if (span > 0n) total += span;
        }
        emitMs = Number(total) / NANOSECONDS_PER_MS;
      },
      () => {
        emitTimestampInFlight = false;
      },
    );
  };

  const recordEmitTimestamps = (encoder: GPUCommandEncoder): void => {
    if (querySet === null || emitTimestamps === null) return;
    const pairs = emitPairsUsed;
    emitPairsUsed = 0;
    if (pairs === 0) return;
    if (emitTimestampInFlight || emitTimestamps.readback.mapState !== 'unmapped') return;
    emitTimestampInFlight = true;
    emitPairsResolving = pairs;
    encoder.resolveQuerySet(
      querySet,
      TIMESTAMP_EMIT_BASE,
      pairs * TIMESTAMPS_PER_PASS,
      emitTimestamps.resolve,
      0,
    );
    encoder.copyBufferToBuffer(
      emitTimestamps.resolve,
      0,
      emitTimestamps.readback,
      0,
      pairs * TIMESTAMPS_PER_PASS * TIMESTAMP_BYTES_PER_QUERY,
    );
    // The store submits this encoder as soon as it returns, and a map must not outrun its copy.
    queueMicrotask(readEmitTimestamps);
  };

  const runFallback = (queued: QueuedChunk): void => {
    queued.settle(fallback.build(queued.mirror, queued.chunkIdx, queued.generation));
  };

  const dispatchCount = (members: BatchMember[]): GPUBuffer | null => {
    const readback = takeReadback();
    if (readback === null) return null;
    for (let i = 0; i < members.length; i++) batchList[i] = members[i]!.entry;
    queue.writeBuffer(
      windowBuffer,
      WINDOW_BATCH_LIST_AT * BYTES_PER_WORD,
      batchList,
      0,
      members.length,
    );

    const encoder = device.createCommandEncoder({ label: 'terrace.gpuMesher.count' });
    encoder.clearBuffer(lipsBuffer, LIP_COUNTER_AT * BYTES_PER_WORD, BYTES_PER_WORD);
    for (const member of members) {
      encoder.clearBuffer(
        statsBuffer,
        (STATS_CHUNK_AT + member.entry * CHUNK_STATS_WORDS) * BYTES_PER_WORD,
        CHUNK_STATS_WORDS * BYTES_PER_WORD,
      );
    }
    const pass = encoder.beginComputePass({
      label: 'terrace.gpuMesher.count',
      timestampWrites:
        querySet === null
          ? undefined
          : {
              querySet,
              beginningOfPassWriteIndex: TIMESTAMP_COUNT_BEGIN,
              endOfPassWriteIndex: TIMESTAMP_COUNT_END,
            },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group0, [COUNT_PARAMS_SLOT * PARAMS_SLOT_BYTES]);
    pass.setBindGroup(1, countGroup1);
    pass.dispatchWorkgroups(members.length * WORKGROUPS_PER_CHUNK);
    pass.end();

    encoder.copyBufferToBuffer(statsBuffer, 0, readback, readbackStatsAt, statsBytes);
    encoder.copyBufferToBuffer(
      lipsBuffer,
      LIP_COUNTER_AT * BYTES_PER_WORD,
      readback,
      readbackLipCounterAt,
      BYTES_PER_WORD,
    );
    const resolving = resolveTimestamps(encoder);
    queue.submit([encoder.finish()]);
    if (resolving) readTimestamps();
    return readback;
  };

  /** Only what the counter reported is worth copying: the buffer holds a quarter-million slots. */
  const copyLips = (lipCount: number): GPUBuffer | null => {
    const readback = takeLipsReadback();
    if (readback === null) return null;
    const encoder = device.createCommandEncoder({ label: 'terrace.gpuMesher.lips' });
    encoder.copyBufferToBuffer(
      lipsBuffer,
      LIP_RECORDS_AT * BYTES_PER_WORD,
      readback,
      0,
      lipCount * LIP_WORDS * BYTES_PER_WORD,
    );
    queue.submit([encoder.finish()]);
    return readback;
  };

  const NO_LIPS: LipReadback = {
    words: new Int32Array(0),
    floats: new Float32Array(0),
    count: 0,
  };

  const settleBatch = (members: BatchMember[], mapped: ArrayBuffer, lips: LipReadback): void => {
    const squareBases = new Uint32Array(
      mapped,
      readbackStatsAt + STATS_SQUARE_BASE_AT * BYTES_PER_WORD,
      GPU_WINDOW_POOL * SQUARES_PER_CHUNK,
    );
    const stats = new Uint32Array(
      mapped,
      readbackStatsAt + STATS_CHUNK_AT * BYTES_PER_WORD,
      GPU_WINDOW_POOL * CHUNK_STATS_WORDS,
    );
    const lipsByEntry = new Map<number, number[]>();
    for (let i = 0; i < lips.count; i++) {
      const entry = lips.words[i * LIP_WORDS + LIP_ENTRY]!;
      let order = lipsByEntry.get(entry);
      if (order === undefined) {
        order = [];
        lipsByEntry.set(entry, order);
      }
      order.push(i);
    }

    for (const member of members) {
      const { entry, queued } = member;
      const statsAt = entry * CHUNK_STATS_WORDS;
      const vertexCount = stats[statsAt + CHUNK_STATS_VERTEX_COUNT]!;
      // No stamp means the count pass never ran for this entry, so its counts are stale.
      const counted = stats[statsAt + CHUNK_STATS_COUNT_STAMP] === COUNT_PASS_STAMP;
      if (!counted || vertexCount > GPU_CHUNK_VERTEX_BUDGET) {
        releaseEntry(entry);
        runFallback(queued);
        continue;
      }
      const counts = squareBases.slice(
        entry * SQUARES_PER_CHUNK,
        (entry + 1) * SQUARES_PER_CHUNK,
      );
      const caps = gpuCapPlan(member.lowestBand, member.highestBand);
      const answer: ChunkGpuAnswer = {
        kind: 'gpu',
        generation: queued.generation,
        chunkIdx: queued.chunkIdx,
        vertexCount,
        plan: flattenCapPlan(caps),
        topLevel: new Int8Array(0),
        lips: buildLipSegments(lipsByEntry.get(entry) ?? [], lips),
        gpu: makeHandle(
          entry,
          counts,
          vertexCount,
          levelRangeMinY(member.lowestBand),
          levelRangeMaxY(member.lowestBand, member.highestBand),
          chunkCornerX(queued.mirror, queued.chunkIdx),
          chunkCornerZ(queued.mirror, queued.chunkIdx),
        ),
      };
      chunks++;
      queued.settle(answer);
    }
  };

  const fallbackBatch = (members: BatchMember[]): void => {
    for (const member of members) {
      releaseEntry(member.entry);
      runFallback(member.queued);
    }
  };

  // Two maps, in order: the counts say how many lip records exist, and only then is that
  // many bytes of them copied and mapped. Answers resolve after the second map.
  const runBatch = (members: BatchMember[]): void => {
    const readback = dispatchCount(members);
    if (readback === null) {
      fallbackBatch(members);
      return;
    }
    batches++;
    void readback.mapAsync(GPUMapMode.READ).then(
      () => {
        const mapped = readback.getMappedRange();
        const lipTotal = new Uint32Array(mapped, readbackLipCounterAt, 1)[0]!;
        const releaseCounts = (): void => {
          readback.unmap();
          giveBackReadback(readback);
        };
        if (lipTotal > lipCapacity && !disposed && !deviceLost) {
          releaseCounts();
          growLips();
          runBatch(members);
          return;
        }
        const lipCount = Math.min(lipTotal, lipCapacity);
        if (lipCount === 0) {
          settleBatch(members, mapped, NO_LIPS);
          releaseCounts();
          return;
        }
        const lipsReadback = copyLips(lipCount);
        if (lipsReadback === null) {
          releaseCounts();
          fallbackBatch(members);
          return;
        }
        const lipBytes = lipCount * LIP_WORDS * BYTES_PER_WORD;
        void lipsReadback.mapAsync(GPUMapMode.READ, 0, lipBytes).then(
          () => {
            const lipMapped = lipsReadback.getMappedRange(0, lipBytes);
            settleBatch(members, mapped, {
              words: new Int32Array(lipMapped, 0, lipCount * LIP_WORDS),
              floats: new Float32Array(lipMapped, 0, lipCount * LIP_WORDS),
              count: lipCount,
            });
            lipsReadback.unmap();
            giveBackLipsReadback(lipsReadback);
            releaseCounts();
          },
          () => {
            giveBackLipsReadback(lipsReadback);
            releaseCounts();
            fallbackBatch(members);
          },
        );
      },
      () => {
        giveBackReadback(readback);
        fallbackBatch(members);
      },
    );
  };

  const queued: QueuedChunk[] = [];
  let flushScheduled = false;

  const uploadEntry = (entry: number, chunkIdx: number, data: WindowEntryData): void => {
    queue.writeBuffer(
      windowBuffer,
      (WINDOW_LATTICE_AT + entry * WINDOW_LATTICE_SAMPLES) * BYTES_PER_WORD,
      data.lattice,
    );
    queue.writeBuffer(
      windowBuffer,
      (WINDOW_LATTICE_DESC_AT + entry * WINDOW_LATTICE_SAMPLES) * BYTES_PER_WORD,
      data.latticeDesc,
    );
    if (data.spanPairs.length > 0) {
      queue.writeBuffer(
        windowBuffer,
        (WINDOW_SPAN_PAIRS_AT + entry * WINDOW_SPAN_PAIRS * SPAN_PAIR_WORDS) * BYTES_PER_WORD,
        data.spanPairs,
      );
    }
    const at = entry * ENTRY_HEADER_WORDS;
    headers.fill(0, at, at + ENTRY_HEADER_WORDS);
    headers[at + ENTRY_CHUNK_IDX] = chunkIdx;
    headers[at + ENTRY_LAYERED] = data.layered ? 1 : 0;
    headers[at + ENTRY_LOWEST_BAND] = data.chunkLowestBand;
    headers[at + ENTRY_ORIGIN_X_CELLS] = data.originXCells;
    headers[at + ENTRY_ORIGIN_Z_CELLS] = data.originZCells;
    uploadHeader(entry);
  };

  const flushBatch = (): void => {
    flushScheduled = false;
    while (queued.length > 0) {
      const slice = queued.splice(0, GPU_BATCH_CHUNKS);
      const members: BatchMember[] = [];
      for (const item of slice) {
        if (disposed || deviceLost) {
          runFallback(item);
          continue;
        }
        const data = extractWindowEntry(item.mirror, item.chunkIdx);
        if (data === OVER_BUDGET) {
          runFallback(item);
          continue;
        }
        const entry = freeEntries.pop();
        if (entry === undefined) {
          runFallback(item);
          continue;
        }
        entryHeld[entry] = 1;
        uploadEntry(entry, item.chunkIdx, data);
        members.push({
          queued: item,
          entry,
          lowestBand: data.chunkLowestBand,
          highestBand: data.highestBand,
        });
      }
      if (members.length > 0) runBatch(members);
    }
  };

  return {
    concurrency: GPU_BATCH_CHUNKS,
    backlogCap: GPU_BATCH_CHUNKS,
    build(mirror, chunkIdx, generation): Promise<ChunkAnswer | null> {
      if (disposed || deviceLost) {
        return Promise.resolve(fallback.build(mirror, chunkIdx, generation));
      }
      return new Promise<ChunkAnswer | null>((resolve) => {
        queued.push({ mirror, chunkIdx, generation, settle: resolve });
        if (flushScheduled) return;
        flushScheduled = true;
        queueMicrotask(flushBatch);
      });
    },
    stats(): GpuMesherStats {
      return { countMs, emitMs, batches, chunks };
    },
    recordEmitTimestamps,
    onDeviceLost(handler): () => void {
      deviceLostHandlers.add(handler);
      return () => deviceLostHandlers.delete(handler);
    },
    /** The fallback is the caller's: it outlives this source and every world. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (let e = 0; e < GPU_WINDOW_POOL; e++) releaseEntry(e);
      dropFreeReadbacks();
      for (const buffer of countsPool.free.splice(0, countsPool.free.length)) {
        buffer.destroy();
        countsPool.live--;
      }
      for (const buffer of ownedBuffers()) buffer.destroy();
      countTimestamps?.resolve.destroy();
      countTimestamps?.readback.destroy();
      emitTimestamps?.resolve.destroy();
      emitTimestamps?.readback.destroy();
      querySet?.destroy();
    },
  };
}
