import { Vector3 } from 'three';
import type { BufferAttribute } from 'three';
import type { Renderer } from 'three/webgpu';
import { CHUNK_SIZE } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import type { ChunkJobAnswer } from '../../terrain/chunkJob.ts';
import { COMPONENTS_PER_COLOR, VERTICES_PER_TRIANGLE } from '../../terrain/vertexGrid.ts';
import {
  releaseAnswer,
  type ArenaSlotBounds,
  type ArenaStore,
  type ArenaSuperBuffers,
} from '../arenaStore.ts';
import { createPackedArenaGeometry, createTerrainMaterial } from '../terrainMaterial.ts';
import { SUPER_MESH_SPAN_WORLD_UNITS } from '../terrainMeshes.ts';
import {
  GPU_COLOR_BYTES_PER_VERTEX,
  GPU_POSITION_BYTES_PER_VERTEX,
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  POSITION_Y_UNITS_PER_WORLD_UNIT,
  SNORM16_MAX,
  type GpuEmitHandle,
  type GpuEmitTarget,
} from './gpuChunkAnswer.ts';

/** No WebGPU adapter, or the renderer runs WebGL2: the caller falls back to the CPU store. */
export class GpuArenaUnavailableError extends Error {}

/** three no longer holds the buffer this store injected, so its vertices would be lost. */
export class GpuArenaInjectionError extends Error {}

/** The local frame's origin is the super-mesh centre, so i16 spans half the mesh each way. */
const SUPER_HALF_EXTENT = SUPER_MESH_SPAN_WORLD_UNITS / 2;

const CHUNK_SPAN_WORLD_UNITS = CHUNK_SIZE * CELL_WORLD_SIZE;

// 12 B a vertex at a conservative 12 GB/s copy rate is a nanosecond; both machines
// clear that eightfold, so compaction never binds (design section 3.3).
export const GPU_ARENA_COPY_MS_PER_VERTEX = 1e-6;

// Two copy commands and the JS that records them, whatever the move's size; a floor
// under the per-vertex rate (design section 3.3).
export const GPU_ARENA_MOVE_OVERHEAD_MS = 0.005;

// Of the 7 ms a 140 fps frame allows, render takes 2.6 and the next count pass the rest,
// so emits get 3 (design section 7).
export const GPU_MESH_FRAME_BUDGET_MS = 3.0;

// The heaviest profiled stroke window emitted at this rate per vertex; the laptop is a
// third dearer and still fits one window in a frame (design section 7).
export const GPU_EMIT_MS_PER_VERTEX = 4.5e-6;

/** A CPU-fallback chunk costs no emit dispatch: its vertices arrive by queue write. */
const GPU_ARENA_CPU_WRITE_COST_MS = 0;

const POSITION_COMPONENTS_PER_VERTEX = GPU_POSITION_BYTES_PER_VERTEX / Int16Array.BYTES_PER_ELEMENT;

/** The fourth position component pads the vertex to two words and is never read. */
const PACKED_POSITION_SPARE = 0;

const COMPONENTS_PER_CPU_POSITION = 3;

const FRAME_ENCODER_LABEL = 'terrace-arena-frame';

const GROW_ENCODER_LABEL = 'terrace-arena-grow';

interface BackendAttributeData {
  buffer?: GPUBuffer;
}

// three r185 keeps an attribute's GPU buffer here; createAttribute allocates only when the
// slot is empty (WebGPUAttributeUtils.js:76-78), so filling it first hands three ours.
interface WebGpuBackendInternals {
  readonly isWebGPUBackend?: boolean;
  readonly device?: GPUDevice;
  get(object: object): BackendAttributeData;
}

interface GpuSuper {
  positions: GPUBuffer;
  colors: GPUBuffer;
  positionAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  target: GpuEmitTarget;
  localOrigin: Vector3;
}

export interface GpuArenaStoreOptions {
  /** Reports a GpuArenaInjectionError instead of throwing it. The guard fires inside the
   *  arena's frame callback, which scene.ts mutes forever once it throws. */
  readonly onFailure?: (error: Error) => void;
}

export function createGpuArenaStore(
  renderer: Renderer,
  options?: GpuArenaStoreOptions,
): ArenaStore {
  const backend = renderer.backend as unknown as WebGpuBackendInternals;
  if (backend.isWebGPUBackend !== true) {
    throw new GpuArenaUnavailableError('the renderer is not running the WebGPU backend');
  }
  const device = backend.device;
  if (device === undefined) {
    throw new GpuArenaUnavailableError('the WebGPU backend has no device yet');
  }

  const ARENA_BUFFER_USAGE =
    GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const SCRATCH_BUFFER_USAGE = GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

  const material = createTerrainMaterial('snorm16');
  const supers = new Map<number, GpuSuper>();
  /** superIdx to `info.render.calls` when the buffer was injected. */
  const uncheckedInjections = new Map<number, number>();

  let encoder: GPUCommandEncoder | null = null;
  let scratchPositions: GPUBuffer | null = null;
  let scratchColors: GPUBuffer | null = null;
  let scratchVertices = 0;
  let cpuPositions = new Int16Array(0);
  let destroyed = false;

  const superAt = (superIdx: number): GpuSuper => {
    const gpu = supers.get(superIdx);
    if (gpu === undefined) throw new Error(`arena super-mesh ${superIdx} has no buffers`);
    return gpu;
  };

  const injectedBuffer = (attribute: BufferAttribute): GPUBuffer | undefined =>
    backend.get(attribute).buffer;

  // three fills an empty attribute slot in createAttribute, which only a render reaches.
  // Checking before then would pass on our own injection and never look again.
  const verifyInjections = (): void => {
    const calls = renderer.info.render.calls;
    for (const [superIdx, injectedAtCalls] of uncheckedInjections) {
      if (calls <= injectedAtCalls) continue;
      uncheckedInjections.delete(superIdx);
      const gpu = superAt(superIdx);
      if (
        injectedBuffer(gpu.positionAttribute) !== gpu.positions ||
        injectedBuffer(gpu.colorAttribute) !== gpu.colors
      ) {
        throw new GpuArenaInjectionError(
          `three replaced the injected buffers of arena super-mesh ${superIdx}`,
        );
      }
    }
  };

  const onFailure = options?.onFailure;
  let reportedFailure = false;

  const commit = (): void => {
    try {
      verifyInjections();
    } catch (error) {
      if (!(error instanceof GpuArenaInjectionError) || onFailure === undefined) throw error;
      // Cleared so the guard stops re-throwing every frame until the owner has rebuilt.
      uncheckedInjections.clear();
      if (!reportedFailure) {
        reportedFailure = true;
        onFailure(error);
      }
    }
    if (encoder === null) return;
    const commands = encoder.finish();
    encoder = null;
    device.queue.submit([commands]);
  };

  const frameEncoder = (): GPUCommandEncoder => {
    encoder ??= device.createCommandEncoder({ label: FRAME_ENCODER_LABEL });
    return encoder;
  };

  const allocate = (
    superIdx: number,
    triangleCapacity: number,
    localOrigin: Vector3,
  ): { gpu: GpuSuper; buffers: ArenaSuperBuffers } => {
    const vertexCapacity = triangleCapacity * VERTICES_PER_TRIANGLE;
    const positions = device.createBuffer({
      label: `terrace-arena-positions-${superIdx}`,
      size: vertexCapacity * GPU_POSITION_BYTES_PER_VERTEX,
      usage: ARENA_BUFFER_USAGE,
    });
    const colors = device.createBuffer({
      label: `terrace-arena-colors-${superIdx}`,
      size: vertexCapacity * GPU_COLOR_BYTES_PER_VERTEX,
      usage: ARENA_BUFFER_USAGE,
    });

    const { geometry, positionAttribute, colorAttribute } =
      createPackedArenaGeometry(vertexCapacity);
    backend.get(positionAttribute).buffer = positions;
    backend.get(colorAttribute).buffer = colors;

    const gpu: GpuSuper = {
      positions,
      colors,
      positionAttribute,
      colorAttribute,
      target: {
        positions,
        colors,
        localOriginX: localOrigin.x,
        localOriginZ: localOrigin.z,
      },
      localOrigin,
    };
    supers.set(superIdx, gpu);
    uncheckedInjections.set(superIdx, renderer.info.render.calls);

    return {
      gpu,
      buffers: {
        geometry,
        positionAttribute,
        colorAttribute,
        normalAttribute: null,
        triangleCapacity,
        localOrigin,
      },
    };
  };

  const ensureScratch = (vertexCount: number): void => {
    if (vertexCount <= scratchVertices) return;
    commit();
    scratchPositions?.destroy();
    scratchColors?.destroy();
    scratchPositions = device.createBuffer({
      label: 'terrace-arena-scratch-positions',
      size: vertexCount * GPU_POSITION_BYTES_PER_VERTEX,
      usage: SCRATCH_BUFFER_USAGE,
    });
    scratchColors = device.createBuffer({
      label: 'terrace-arena-scratch-colors',
      size: vertexCount * GPU_COLOR_BYTES_PER_VERTEX,
      usage: SCRATCH_BUFFER_USAGE,
    });
    scratchVertices = vertexCount;
  };

  const quantize = (units: number): number =>
    Math.min(SNORM16_MAX, Math.max(-SNORM16_MAX, Math.round(units)));

  // A chunk the GPU mesher could not take arrives in the CPU's float layout. Its queue
  // write lands ahead of anything recorded, so recorded commands go out first.
  const packCpuAnswer = (
    gpu: GpuSuper,
    vertexOffset: number,
    answer: ChunkJobAnswer,
  ): ArenaSlotBounds => {
    const count = answer.vertexCount;
    if (cpuPositions.length < count * POSITION_COMPONENTS_PER_VERTEX) {
      cpuPositions = new Int16Array(count * POSITION_COMPONENTS_PER_VERTEX);
    }
    const packed = cpuPositions.subarray(0, count * POSITION_COMPONENTS_PER_VERTEX);
    for (let v = 0; v < count; v++) {
      const source = v * COMPONENTS_PER_CPU_POSITION;
      const target = v * POSITION_COMPONENTS_PER_VERTEX;
      packed[target] = quantize(
        (answer.positions[source]! - gpu.localOrigin.x) * POSITION_XZ_UNITS_PER_WORLD_UNIT,
      );
      packed[target + 1] = quantize(answer.positions[source + 1]! * POSITION_Y_UNITS_PER_WORLD_UNIT);
      packed[target + 2] = quantize(
        (answer.positions[source + 2]! - gpu.localOrigin.z) * POSITION_XZ_UNITS_PER_WORLD_UNIT,
      );
      packed[target + 3] = PACKED_POSITION_SPARE;
    }

    commit();
    device.queue.writeBuffer(gpu.positions, vertexOffset * GPU_POSITION_BYTES_PER_VERTEX, packed);
    device.queue.writeBuffer(
      gpu.colors,
      vertexOffset * GPU_COLOR_BYTES_PER_VERTEX,
      answer.colors.subarray(0, count * COMPONENTS_PER_COLOR),
    );

    return {
      minX: answer.bounds[0]! - gpu.localOrigin.x,
      minY: answer.bounds[1]!,
      minZ: answer.bounds[2]! - gpu.localOrigin.z,
      maxX: answer.bounds[3]! - gpu.localOrigin.x,
      maxY: answer.bounds[4]!,
      maxZ: answer.bounds[5]! - gpu.localOrigin.z,
    };
  };

  // The kernel draws a chunk's caps over its own cells and nothing beyond them, so the
  // footprint and the level range bound every vertex it emits.
  const chunkBounds = (gpu: GpuSuper, handle: GpuEmitHandle): ArenaSlotBounds => {
    const minX = handle.originX - gpu.localOrigin.x;
    const minZ = handle.originZ - gpu.localOrigin.z;
    return {
      minX,
      minY: handle.minY,
      minZ,
      maxX: minX + CHUNK_SPAN_WORLD_UNITS,
      maxY: handle.maxY,
      maxZ: minZ + CHUNK_SPAN_WORLD_UNITS,
    };
  };

  const disposeSuper = (superIdx: number): void => {
    const gpu = supers.get(superIdx);
    if (gpu === undefined) return;
    gpu.positions.destroy();
    gpu.colors.destroy();
    supers.delete(superIdx);
    uncheckedInjections.delete(superIdx);
  };

  const disposeAll = (): void => {
    commit();
    for (const superIdx of [...supers.keys()]) disposeSuper(superIdx);
    scratchPositions?.destroy();
    scratchColors?.destroy();
    scratchPositions = null;
    scratchColors = null;
    scratchVertices = 0;
  };

  return {
    frame: 'superLocal',
    transferMsPerVertex: GPU_ARENA_COPY_MS_PER_VERTEX,
    moveOverheadMs: GPU_ARENA_MOVE_OVERHEAD_MS,
    frameWriteBudgetMs: GPU_MESH_FRAME_BUDGET_MS,
    material,

    /** Both layouts land in the packed buffers: a GPU answer by emit, a CPU one by queue write. */
    accepts(): boolean {
      return true;
    },

    writeCostMs(answer): number {
      if (answer.kind !== 'gpu') return GPU_ARENA_CPU_WRITE_COST_MS;
      return answer.vertexCount * GPU_EMIT_MS_PER_VERTEX;
    },

    residentBytes(): number {
      let bytes = (scratchPositions?.size ?? 0) + (scratchColors?.size ?? 0);
      for (const gpu of supers.values()) bytes += gpu.positions.size + gpu.colors.size;
      return bytes;
    },

    createSuper(superIdx, originX, originZ, triangleCapacity): ArenaSuperBuffers {
      const localOrigin = new Vector3(originX + SUPER_HALF_EXTENT, 0, originZ + SUPER_HALF_EXTENT);
      return allocate(superIdx, triangleCapacity, localOrigin).buffers;
    },

    // Everything recorded still names the old buffers, so it goes out before the copy.
    // The store destroys them: three's dispose listener comes from initGeometry, which
    // runs only once rendered.
    grow(superIdx, triangleCapacity, liveEnd): ArenaSuperBuffers {
      const previous = superAt(superIdx);
      commit();
      const grown = allocate(superIdx, triangleCapacity, previous.localOrigin);
      const growEncoder = device.createCommandEncoder({ label: GROW_ENCODER_LABEL });
      if (liveEnd > 0) {
        growEncoder.copyBufferToBuffer(
          previous.positions,
          0,
          grown.gpu.positions,
          0,
          liveEnd * GPU_POSITION_BYTES_PER_VERTEX,
        );
        growEncoder.copyBufferToBuffer(
          previous.colors,
          0,
          grown.gpu.colors,
          0,
          liveEnd * GPU_COLOR_BYTES_PER_VERTEX,
        );
      }
      device.queue.submit([growEncoder.finish()]);
      // Legal after submit: the submitted commands keep their own reference to the buffers.
      previous.positions.destroy();
      previous.colors.destroy();
      return grown.buffers;
    },

    write(superIdx, vertexOffset, answer): ArenaSlotBounds {
      const gpu = superAt(superIdx);
      if (answer.kind !== 'gpu') return packCpuAnswer(gpu, vertexOffset, answer);
      answer.gpu.emit(frameEncoder(), gpu.target, vertexOffset);
      releaseAnswer(answer);
      return chunkBounds(gpu, answer.gpu);
    },

    // WebGPU forbids a copy that overlaps itself within one buffer, so a move bounces off
    // scratch: out and back, in the order the commands were recorded.
    copyWithin(superIdx, toVertex, fromVertex, vertexCount): void {
      if (vertexCount <= 0) return;
      const gpu = superAt(superIdx);
      ensureScratch(vertexCount);
      const bouncePositions = scratchPositions!;
      const bounceColors = scratchColors!;
      const positionBytes = vertexCount * GPU_POSITION_BYTES_PER_VERTEX;
      const colorBytes = vertexCount * GPU_COLOR_BYTES_PER_VERTEX;
      const frame = frameEncoder();
      frame.copyBufferToBuffer(
        gpu.positions,
        fromVertex * GPU_POSITION_BYTES_PER_VERTEX,
        bouncePositions,
        0,
        positionBytes,
      );
      frame.copyBufferToBuffer(
        bouncePositions,
        0,
        gpu.positions,
        toVertex * GPU_POSITION_BYTES_PER_VERTEX,
        positionBytes,
      );
      frame.copyBufferToBuffer(
        gpu.colors,
        fromVertex * GPU_COLOR_BYTES_PER_VERTEX,
        bounceColors,
        0,
        colorBytes,
      );
      frame.copyBufferToBuffer(
        bounceColors,
        0,
        gpu.colors,
        toVertex * GPU_COLOR_BYTES_PER_VERTEX,
        colorBytes,
      );
    },

    zero(superIdx, startVertex, vertexCount): void {
      if (vertexCount <= 0) return;
      const gpu = superAt(superIdx);
      const frame = frameEncoder();
      frame.clearBuffer(
        gpu.positions,
        startVertex * GPU_POSITION_BYTES_PER_VERTEX,
        vertexCount * GPU_POSITION_BYTES_PER_VERTEX,
      );
      frame.clearBuffer(
        gpu.colors,
        startVertex * GPU_COLOR_BYTES_PER_VERTEX,
        vertexCount * GPU_COLOR_BYTES_PER_VERTEX,
      );
    },

    /** Vertices land in the buffer the attribute already binds; three has nothing to upload. */
    markRange(): void {},

    commit,

    dispose(superIdx): void {
      commit();
      disposeSuper(superIdx);
    },

    disposeAll,

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      disposeAll();
      material.dispose();
    },
  };
}
