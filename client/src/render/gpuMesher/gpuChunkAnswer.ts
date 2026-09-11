import type { ChunkLipSegments, FlatCapPlan } from '../../terrain/capPlanFlat.ts';

/** The destination super-mesh buffers an emit writes into. */
export interface GpuEmitTarget {
  readonly positions: GPUBuffer;
  readonly colors: GPUBuffer;
  /** Super-mesh centre, world units; positions are quantized relative to it. */
  readonly localOriginX: number;
  readonly localOriginZ: number;
}

/** A counted chunk waiting for its arena slot; holds a GPU window entry until released. */
export interface GpuEmitHandle {
  /** World-unit y range of every vertex: caps of the lowest and highest level. */
  readonly minY: number;
  readonly maxY: number;
  /** The chunk's north-west corner in world units; its footprint bounds every vertex. */
  readonly originX: number;
  readonly originZ: number;
  /** Records the emit dispatch at `vertexOffset` of `target`; releases the entry. `false`
   *  when no dispatch was recorded, so the slot holds whatever it held before. */
  emit(encoder: GPUCommandEncoder, target: GpuEmitTarget, vertexOffset: number): boolean;
  /** Returns the window entry to the pool. Idempotent. */
  release(): void;
}

export interface ChunkGpuAnswer {
  readonly kind: 'gpu';
  readonly generation: number;
  readonly chunkIdx: number;
  readonly vertexCount: number;
  /** Level list only (thresholds, sample bands, cap heights); no polygons. */
  readonly plan: FlatCapPlan;
  /** Always empty: `topLevelIndexAt` has no consumer. */
  readonly topLevel: Int8Array;
  readonly lips: ChunkLipSegments;
  readonly gpu: GpuEmitHandle;
}

/** Positions: i16 units of 1/1024 world unit from the super-mesh centre. */
export const POSITION_XZ_UNITS_PER_WORLD_UNIT = 1024;

/** Heights: i16 units of BAND_WORLD_HEIGHT / 16, so every cap, sink and rim height is exact. */
export const POSITION_Y_UNITS_PER_WORLD_UNIT = 64;

/** snorm16 decode factor: the GPU hands the shader `units / SNORM16_MAX`. */
export const SNORM16_MAX = 32767;

export const GPU_POSITION_BYTES_PER_VERTEX = 8;

export const GPU_COLOR_BYTES_PER_VERTEX = 4;
