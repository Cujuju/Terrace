import { BAND_HEIGHT } from '@terrace/shared';
import type { Renderer } from 'three/webgpu';
import { HEIGHT_WORLD_SCALE } from '../../config.ts';
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
import { SHORE_THRESHOLD, buildBandLut, LUT_VEC4_COUNT } from './bandLut.ts';
import {
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  type ChunkGpuAnswer,
  type GpuEmitHandle,
  type GpuEmitTarget,
} from './gpuChunkAnswer.ts';
import { marchingTableBuffer, MARCH_TABLE_WORDS } from './marchingTable.ts';
import {
  MESHER_ENTRY_POINT,
  MODE_COUNT,
  MODE_EMIT,
  WORKGROUPS_PER_CHUNK,
  buildMesherWgsl,
} from './mesherWgsl.ts';
import {
  CHUNK_STATS_VERTEX_COUNT,
  CHUNK_STATS_WORDS,
  ENTRY_CHUNK_IDX,
  ENTRY_HEADER_WORDS,
  ENTRY_HIGHEST_BAND,
  ENTRY_LAYERED,
  ENTRY_LOCAL_ORIGIN_X_UNITS,
  ENTRY_LOCAL_ORIGIN_Z_UNITS,
  ENTRY_LOWEST_BAND,
  ENTRY_ORIGIN_X_CELLS,
  ENTRY_ORIGIN_Z_CELLS,
  ENTRY_VERTEX_BASE,
  ENTRY_VERTEX_LIMIT,
  LIP_AX,
  LIP_BAND,
  LIP_ENTRY,
  LIP_WORDS,
  OVER_BUDGET,
  SPAN_PAIR_WORDS,
  SQUARES_PER_CHUNK,
  WINDOW_LATTICE_SAMPLES,
  WINDOW_SPAN_PAIRS,
  extractWindowEntry,
  type WindowEntryData,
} from './terrainGpuInputs.ts';

/** Chunks counted in one dispatch. Also the arena's backlog cap, so one drain is one batch. */
export const GPU_BATCH_CHUNKS = 64;

/** Two batches of entries stay resident, so an emit reads exactly what its count counted. */
export const GPU_WINDOW_POOL = 2 * GPU_BATCH_CHUNKS;

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

const TIMESTAMP_COUNT_BEGIN = 0;
const TIMESTAMP_COUNT_END = 1;
const TIMESTAMP_EMIT_BEGIN = 2;
const TIMESTAMP_EMIT_END = 3;
const TIMESTAMP_QUERY_COUNT = 4;
const TIMESTAMP_BYTES_PER_QUERY = 8;
const NANOSECONDS_PER_MS = 1e6;

const LIP_POSITION_FLOATS_PER_SEGMENT = 6;
const LIP_FLAT_FLOATS_PER_SEGMENT = 4;
const LIP_BAND_TRIPLE_WORDS = 3;

const NO_ENTRY = -1;

export interface GpuMesherStats {
  readonly countMs: number;
  readonly emitMs: number;
  readonly batches: number;
  readonly chunks: number;
}

export interface GpuChunkBuildSource extends ChunkBuildSource {
  stats(): GpuMesherStats;
}

interface WebGpuBackendInternals {
  readonly isWebGPUBackend?: boolean;
  readonly device?: GPUDevice;
}

interface LipRecord {
  band: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
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

function compareLips(a: LipRecord, b: LipRecord): number {
  if (a.band !== b.band) return a.band - b.band;
  if (a.ax !== b.ax) return a.ax - b.ax;
  if (a.az !== b.az) return a.az - b.az;
  if (a.bx !== b.bx) return a.bx - b.bx;
  return a.bz - b.bz;
}

function buildLipSegments(records: LipRecord[]): ChunkLipSegments {
  records.sort(compareLips);
  const positions = new Float32Array(records.length * LIP_POSITION_FLOATS_PER_SEGMENT);
  const flat = new Float32Array(records.length * LIP_FLAT_FLOATS_PER_SEGMENT);
  const bands: number[] = [];
  let runBand = 0;
  let runStart = 0;
  for (let i = 0; i < records.length; i++) {
    const lip = records[i]!;
    const y = lip.band * BAND_HEIGHT * HEIGHT_WORLD_SCALE + LIP_LIFT_WORLD_UNITS;
    const p = i * LIP_POSITION_FLOATS_PER_SEGMENT;
    positions[p] = lip.ax;
    positions[p + 1] = y;
    positions[p + 2] = lip.az;
    positions[p + 3] = lip.bx;
    positions[p + 4] = y;
    positions[p + 5] = lip.bz;
    const f = i * LIP_FLAT_FLOATS_PER_SEGMENT;
    flat[f] = lip.ax;
    flat[f + 1] = lip.az;
    flat[f + 2] = lip.bx;
    flat[f + 3] = lip.bz;
    if (i === 0 || lip.band !== runBand) {
      if (i > 0) bands.push(runBand, runStart, i - runStart);
      runBand = lip.band;
      runStart = i;
    }
  }
  if (records.length > 0) bands.push(runBand, runStart, records.length - runStart);
  return { positions, flat, bands: Int32Array.from(bands) };
}

export function createGpuChunkBuildSource(
  renderer: Renderer,
  fallback: ChunkBuildSource,
): GpuChunkBuildSource | null {
  const backend = renderer.backend as unknown as WebGpuBackendInternals;
  if (backend.isWebGPUBackend !== true) return null;
  const device = backend.device;
  if (device === undefined) return null;

  const queue = device.queue;
  const STORAGE_READ = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const STORAGE_RW = STORAGE_READ | GPUBufferUsage.COPY_SRC;

  const create = (label: string, size: number, usage: number): GPUBuffer =>
    device.createBuffer({ label: `terrace.gpuMesher.${label}`, size, usage });

  const latticeBuffer = create(
    'lattice',
    GPU_WINDOW_POOL * WINDOW_LATTICE_SAMPLES * BYTES_PER_WORD,
    STORAGE_READ,
  );
  const latticeDescBuffer = create(
    'latticeDesc',
    GPU_WINDOW_POOL * WINDOW_LATTICE_SAMPLES * BYTES_PER_WORD,
    STORAGE_READ,
  );
  const spanPairsBuffer = create(
    'spanPairs',
    GPU_WINDOW_POOL * WINDOW_SPAN_PAIRS * SPAN_PAIR_WORDS * BYTES_PER_WORD,
    STORAGE_READ,
  );
  const entriesBuffer = create(
    'entries',
    GPU_WINDOW_POOL * ENTRY_HEADER_WORDS * BYTES_PER_WORD,
    STORAGE_READ,
  );
  const squareBaseBuffer = create(
    'squareBase',
    GPU_WINDOW_POOL * SQUARES_PER_CHUNK * BYTES_PER_WORD,
    STORAGE_RW,
  );
  const chunkStatsBuffer = create(
    'chunkStats',
    GPU_WINDOW_POOL * CHUNK_STATS_WORDS * BYTES_PER_WORD,
    STORAGE_RW,
  );
  const marchTableBuffer = create(
    'marchTable',
    MARCH_TABLE_WORDS * BYTES_PER_WORD,
    STORAGE_READ,
  );
  const lutBuffer = create('lut', LUT_VEC4_COUNT * PARAMS_WORDS * BYTES_PER_WORD, STORAGE_READ);
  const paramsBuffer = create(
    'params',
    (GPU_WINDOW_POOL + 1) * PARAMS_SLOT_BYTES,
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  );
  const lipCounterBuffer = create('lipCounter', PARAMS_SLOT_BYTES, STORAGE_RW);
  const batchListBuffer = create(
    'batchList',
    GPU_BATCH_CHUNKS * BYTES_PER_WORD,
    STORAGE_READ,
  );
  const dummyPositions = create('dummyPositions', BYTES_PER_WORD, STORAGE_RW);
  const dummyColors = create('dummyColors', BYTES_PER_WORD, STORAGE_RW);

  let lipCapacity = LIP_APPEND_CAPACITY;
  let lipsBuffer = create('lips', lipCapacity * LIP_WORDS * BYTES_PER_WORD, STORAGE_RW);

  queue.writeBuffer(marchTableBuffer, 0, marchingTableBuffer());
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

  const storageEntry = (
    binding: number,
    type: 'storage' | 'read-only-storage',
  ): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type },
  });

  const group0Layout = device.createBindGroupLayout({
    label: 'terrace.gpuMesher.group0',
    entries: [
      storageEntry(0, 'read-only-storage'),
      storageEntry(1, 'read-only-storage'),
      storageEntry(2, 'read-only-storage'),
      storageEntry(3, 'read-only-storage'),
      storageEntry(4, 'storage'),
      storageEntry(5, 'storage'),
      storageEntry(6, 'read-only-storage'),
      storageEntry(7, 'read-only-storage'),
      {
        binding: 8,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAMS_WORDS * BYTES_PER_WORD },
      },
      storageEntry(9, 'storage'),
      storageEntry(10, 'storage'),
      storageEntry(11, 'read-only-storage'),
    ],
  });
  const group1Layout = device.createBindGroupLayout({
    label: 'terrace.gpuMesher.group1',
    entries: [storageEntry(0, 'storage'), storageEntry(1, 'storage')],
  });

  const module = device.createShaderModule({
    label: 'terrace.gpuMesher.mesher',
    code: buildMesherWgsl(),
  });
  const pipeline = device.createComputePipeline({
    label: 'terrace.gpuMesher.pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [group0Layout, group1Layout] }),
    compute: { module, entryPoint: MESHER_ENTRY_POINT },
  });

  let compileFailure: string | null = null;
  void module.getCompilationInfo().then((info) => {
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length === 0) return;
    compileFailure = errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n');
    console.error(`[terrace] GPU mesher WGSL failed to compile:\n${compileFailure}`);
  });

  let group0 = device.createBindGroup({
    label: 'terrace.gpuMesher.bind0',
    layout: group0Layout,
    entries: [
      { binding: 0, resource: { buffer: latticeBuffer } },
      { binding: 1, resource: { buffer: latticeDescBuffer } },
      { binding: 2, resource: { buffer: spanPairsBuffer } },
      { binding: 3, resource: { buffer: entriesBuffer } },
      { binding: 4, resource: { buffer: squareBaseBuffer } },
      { binding: 5, resource: { buffer: chunkStatsBuffer } },
      { binding: 6, resource: { buffer: marchTableBuffer } },
      { binding: 7, resource: { buffer: lutBuffer } },
      { binding: 8, resource: { buffer: paramsBuffer, size: PARAMS_WORDS * BYTES_PER_WORD } },
      { binding: 9, resource: { buffer: lipsBuffer } },
      { binding: 10, resource: { buffer: lipCounterBuffer } },
      { binding: 11, resource: { buffer: batchListBuffer } },
    ],
  });
  const countGroup1 = device.createBindGroup({
    label: 'terrace.gpuMesher.bind1.count',
    layout: group1Layout,
    entries: [
      { binding: 0, resource: { buffer: dummyPositions } },
      { binding: 1, resource: { buffer: dummyColors } },
    ],
  });

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
  const timestampResolve = timestampsSupported
    ? create(
        'timestampResolve',
        TIMESTAMP_QUERY_COUNT * TIMESTAMP_BYTES_PER_QUERY,
        GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      )
    : null;
  const timestampReadback = timestampsSupported
    ? create(
        'timestampReadback',
        TIMESTAMP_QUERY_COUNT * TIMESTAMP_BYTES_PER_QUERY,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      )
    : null;

  const squareBaseBytes = GPU_WINDOW_POOL * SQUARES_PER_CHUNK * BYTES_PER_WORD;
  const chunkStatsBytes = GPU_WINDOW_POOL * CHUNK_STATS_WORDS * BYTES_PER_WORD;
  const readbackSquareBaseAt = 0;
  const readbackChunkStatsAt = alignUp(squareBaseBytes, READBACK_SECTION_ALIGNMENT);
  const readbackLipCounterAt = alignUp(
    readbackChunkStatsAt + chunkStatsBytes,
    READBACK_SECTION_ALIGNMENT,
  );
  const readbackLipsAt = readbackLipCounterAt + READBACK_SECTION_ALIGNMENT;
  const readbackBytes = (): number => readbackLipsAt + lipCapacity * LIP_WORDS * BYTES_PER_WORD;

  const readbackPool: GPUBuffer[] = [];
  let readbackLive = 0;
  /** After the lips buffer doubles the free readbacks are the wrong size; in-flight ones
   *  are dropped when they come back. */
  const dropFreeReadbacks = (): void => {
    for (const buffer of readbackPool.splice(0, readbackPool.length)) {
      buffer.destroy();
      readbackLive--;
    }
  };
  const takeReadback = (): GPUBuffer | null => {
    const free = readbackPool.pop();
    if (free !== undefined) return free;
    if (readbackLive >= GPU_READBACK_POOL_MAX) return null;
    readbackLive++;
    return create(
      `readback${readbackLive}`,
      readbackBytes(),
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    );
  };
  const giveBackReadback = (buffer: GPUBuffer): void => {
    if (buffer.size !== readbackBytes() || readbackPool.length >= GPU_READBACK_POOL_MAX) {
      buffer.destroy();
      readbackLive--;
      return;
    }
    readbackPool.push(buffer);
  };
  for (let i = 0; i < GPU_READBACK_POOL_MIN; i++) {
    const buffer = takeReadback();
    if (buffer !== null) readbackPool.push(buffer);
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
      entriesBuffer,
      entry * ENTRY_HEADER_WORDS * BYTES_PER_WORD,
      headers,
      entry * ENTRY_HEADER_WORDS,
      ENTRY_HEADER_WORDS,
    );
  };

  let disposed = false;
  let deviceLost = false;
  void device.lost.then(() => {
    deviceLost = true;
  });

  let batches = 0;
  let chunks = 0;
  let countMs = 0;
  let emitMs = 0;
  let batchesSinceResolve = 0;
  let timestampInFlight = false;

  const growLips = (): void => {
    lipCapacity *= 2;
    lipsBuffer.destroy();
    lipsBuffer = create('lips', lipCapacity * LIP_WORDS * BYTES_PER_WORD, STORAGE_RW);
    group0 = device.createBindGroup({
      label: 'terrace.gpuMesher.bind0',
      layout: group0Layout,
      entries: [
        { binding: 0, resource: { buffer: latticeBuffer } },
        { binding: 1, resource: { buffer: latticeDescBuffer } },
        { binding: 2, resource: { buffer: spanPairsBuffer } },
        { binding: 3, resource: { buffer: entriesBuffer } },
        { binding: 4, resource: { buffer: squareBaseBuffer } },
        { binding: 5, resource: { buffer: chunkStatsBuffer } },
        { binding: 6, resource: { buffer: marchTableBuffer } },
        { binding: 7, resource: { buffer: lutBuffer } },
        { binding: 8, resource: { buffer: paramsBuffer, size: PARAMS_WORDS * BYTES_PER_WORD } },
        { binding: 9, resource: { buffer: lipsBuffer } },
        { binding: 10, resource: { buffer: lipCounterBuffer } },
        { binding: 11, resource: { buffer: batchListBuffer } },
      ],
    });
    writeParams();
    dropFreeReadbacks();
  };

  const makeHandle = (
    entry: number,
    counts: Uint32Array,
    vertexCount: number,
    minY: number,
    maxY: number,
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
      emit(encoder: GPUCommandEncoder, target: GpuEmitTarget, vertexOffset: number): void {
        if (released || disposed || deviceLost) {
          release();
          return;
        }
        let acc = vertexOffset;
        for (let i = 0; i < SQUARES_PER_CHUNK; i++) {
          prefix[i] = acc;
          acc += counts[i]!;
        }
        queue.writeBuffer(
          squareBaseBuffer,
          entry * SQUARES_PER_CHUNK * BYTES_PER_WORD,
          prefix,
        );
        const at = entry * ENTRY_HEADER_WORDS;
        headers[at + ENTRY_VERTEX_BASE] = vertexOffset;
        headers[at + ENTRY_VERTEX_LIMIT] = vertexOffset + vertexCount;
        headers[at + ENTRY_LOCAL_ORIGIN_X_UNITS] = Math.round(
          target.localOriginX * POSITION_XZ_UNITS_PER_WORLD_UNIT,
        );
        headers[at + ENTRY_LOCAL_ORIGIN_Z_UNITS] = Math.round(
          target.localOriginZ * POSITION_XZ_UNITS_PER_WORLD_UNIT,
        );
        uploadHeader(entry);
        const pass = encoder.beginComputePass({
          label: 'terrace.gpuMesher.emit',
          timestampWrites:
            querySet === null
              ? undefined
              : {
                  querySet,
                  beginningOfPassWriteIndex: TIMESTAMP_EMIT_BEGIN,
                  endOfPassWriteIndex: TIMESTAMP_EMIT_END,
                },
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group0, [entry * PARAMS_SLOT_BYTES]);
        pass.setBindGroup(1, emitGroupFor(target));
        pass.dispatchWorkgroups(WORKGROUPS_PER_CHUNK);
        pass.end();
        release();
      },
      release,
    };
  };

  const resolveTimestamps = (encoder: GPUCommandEncoder): boolean => {
    if (querySet === null || timestampResolve === null || timestampReadback === null) return false;
    if (timestampInFlight || timestampReadback.mapState !== 'unmapped') return false;
    batchesSinceResolve++;
    if (batchesSinceResolve < GPU_MESHER_RESOLVE_EVERY_BATCHES) return false;
    batchesSinceResolve = 0;
    timestampInFlight = true;
    encoder.resolveQuerySet(querySet, 0, TIMESTAMP_QUERY_COUNT, timestampResolve, 0);
    encoder.copyBufferToBuffer(
      timestampResolve,
      0,
      timestampReadback,
      0,
      TIMESTAMP_QUERY_COUNT * TIMESTAMP_BYTES_PER_QUERY,
    );
    return true;
  };

  const readTimestamps = (): void => {
    if (timestampReadback === null) return;
    void timestampReadback.mapAsync(GPUMapMode.READ).then(
      () => {
        const stamps = new BigUint64Array(timestampReadback.getMappedRange().slice(0));
        timestampReadback.unmap();
        timestampInFlight = false;
        const count = stamps[TIMESTAMP_COUNT_END]! - stamps[TIMESTAMP_COUNT_BEGIN]!;
        const emit = stamps[TIMESTAMP_EMIT_END]! - stamps[TIMESTAMP_EMIT_BEGIN]!;
        if (count > 0n) countMs = Number(count) / NANOSECONDS_PER_MS;
        if (emit > 0n) emitMs = Number(emit) / NANOSECONDS_PER_MS;
      },
      () => {
        timestampInFlight = false;
      },
    );
  };

  const runFallback = (queued: QueuedChunk): void => {
    queued.settle(fallback.build(queued.mirror, queued.chunkIdx, queued.generation));
  };

  const dispatchCount = (members: BatchMember[]): GPUBuffer | null => {
    const readback = takeReadback();
    if (readback === null) return null;
    for (let i = 0; i < members.length; i++) batchList[i] = members[i]!.entry;
    queue.writeBuffer(batchListBuffer, 0, batchList, 0, members.length);

    const encoder = device.createCommandEncoder({ label: 'terrace.gpuMesher.count' });
    encoder.clearBuffer(lipCounterBuffer, 0, BYTES_PER_WORD);
    for (const member of members) {
      encoder.clearBuffer(
        chunkStatsBuffer,
        member.entry * CHUNK_STATS_WORDS * BYTES_PER_WORD,
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

    encoder.copyBufferToBuffer(squareBaseBuffer, 0, readback, readbackSquareBaseAt, squareBaseBytes);
    encoder.copyBufferToBuffer(
      chunkStatsBuffer,
      0,
      readback,
      readbackChunkStatsAt,
      chunkStatsBytes,
    );
    encoder.copyBufferToBuffer(
      lipCounterBuffer,
      0,
      readback,
      readbackLipCounterAt,
      BYTES_PER_WORD,
    );
    encoder.copyBufferToBuffer(
      lipsBuffer,
      0,
      readback,
      readbackLipsAt,
      lipCapacity * LIP_WORDS * BYTES_PER_WORD,
    );
    const resolving = resolveTimestamps(encoder);
    queue.submit([encoder.finish()]);
    if (resolving) readTimestamps();
    return readback;
  };

  const settleBatch = (members: BatchMember[], mapped: ArrayBuffer, lipTotal: number): void => {
    const squareBases = new Uint32Array(mapped, readbackSquareBaseAt, GPU_WINDOW_POOL * SQUARES_PER_CHUNK);
    const stats = new Uint32Array(mapped, readbackChunkStatsAt, GPU_WINDOW_POOL * CHUNK_STATS_WORDS);
    const lipCount = Math.min(lipTotal, lipCapacity);
    const lipWords = new Int32Array(mapped, readbackLipsAt, lipCount * LIP_WORDS);
    const lipFloats = new Float32Array(mapped, readbackLipsAt, lipCount * LIP_WORDS);

    const lipsByEntry = new Map<number, LipRecord[]>();
    for (let i = 0; i < lipCount; i++) {
      const at = i * LIP_WORDS;
      const entry = lipWords[at + LIP_ENTRY]!;
      let list = lipsByEntry.get(entry);
      if (list === undefined) {
        list = [];
        lipsByEntry.set(entry, list);
      }
      list.push({
        band: lipWords[at + LIP_BAND]!,
        ax: lipFloats[at + LIP_AX]!,
        az: lipFloats[at + LIP_AX + 1]!,
        bx: lipFloats[at + LIP_AX + 2]!,
        bz: lipFloats[at + LIP_AX + 3]!,
      });
    }

    for (const member of members) {
      const { entry, queued } = member;
      const vertexCount = stats[entry * CHUNK_STATS_WORDS + CHUNK_STATS_VERTEX_COUNT]!;
      if (vertexCount > GPU_CHUNK_VERTEX_BUDGET) {
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
        lips: buildLipSegments(lipsByEntry.get(entry) ?? []),
        gpu: makeHandle(
          entry,
          counts,
          vertexCount,
          levelRangeMinY(member.lowestBand),
          levelRangeMaxY(member.lowestBand, member.highestBand),
        ),
      };
      chunks++;
      queued.settle(answer);
    }
  };

  const runBatch = (members: BatchMember[]): void => {
    const readback = dispatchCount(members);
    if (readback === null) {
      for (const member of members) {
        releaseEntry(member.entry);
        runFallback(member.queued);
      }
      return;
    }
    batches++;
    void readback.mapAsync(GPUMapMode.READ).then(
      () => {
        const mapped = readback.getMappedRange();
        const lipTotal = new Uint32Array(mapped, readbackLipCounterAt, 1)[0]!;
        const overflow = lipTotal > lipCapacity && !disposed && !deviceLost;
        if (!overflow) settleBatch(members, mapped, lipTotal);
        readback.unmap();
        giveBackReadback(readback);
        if (!overflow) return;
        growLips();
        runBatch(members);
      },
      () => {
        giveBackReadback(readback);
        for (const member of members) {
          releaseEntry(member.entry);
          runFallback(member.queued);
        }
      },
    );
  };

  const queued: QueuedChunk[] = [];
  let flushScheduled = false;

  const uploadEntry = (entry: number, chunkIdx: number, data: WindowEntryData): void => {
    queue.writeBuffer(
      latticeBuffer,
      entry * WINDOW_LATTICE_SAMPLES * BYTES_PER_WORD,
      data.lattice,
    );
    queue.writeBuffer(
      latticeDescBuffer,
      entry * WINDOW_LATTICE_SAMPLES * BYTES_PER_WORD,
      data.latticeDesc,
    );
    if (data.spanPairs.length > 0) {
      queue.writeBuffer(
        spanPairsBuffer,
        entry * WINDOW_SPAN_PAIRS * SPAN_PAIR_WORDS * BYTES_PER_WORD,
        data.spanPairs,
      );
    }
    const at = entry * ENTRY_HEADER_WORDS;
    headers.fill(0, at, at + ENTRY_HEADER_WORDS);
    headers[at + ENTRY_CHUNK_IDX] = chunkIdx;
    headers[at + ENTRY_LAYERED] = data.layered ? 1 : 0;
    headers[at + ENTRY_LOWEST_BAND] = data.chunkLowestBand;
    headers[at + ENTRY_HIGHEST_BAND] = data.highestBand;
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
        if (disposed || deviceLost || compileFailure !== null) {
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
      if (disposed || deviceLost || compileFailure !== null) {
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (let e = 0; e < GPU_WINDOW_POOL; e++) releaseEntry(e);
      dropFreeReadbacks();
      for (const buffer of [
        latticeBuffer,
        latticeDescBuffer,
        spanPairsBuffer,
        entriesBuffer,
        squareBaseBuffer,
        chunkStatsBuffer,
        marchTableBuffer,
        lutBuffer,
        paramsBuffer,
        lipsBuffer,
        lipCounterBuffer,
        batchListBuffer,
        dummyPositions,
        dummyColors,
      ]) {
        buffer.destroy();
      }
      timestampResolve?.destroy();
      timestampReadback?.destroy();
      querySet?.destroy();
      fallback.dispose();
    },
  };
}
