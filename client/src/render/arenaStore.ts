import { Vector3 } from 'three';
import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { ChunkAnswer } from './chunkBuildSource.ts';
import { COMPONENTS_PER_COLOR /* , COMPONENTS_PER_NORMAL */ } from '../terrain/capEmission.ts';
import {
  createChunkGeometryBuffers,
  type ChunkGeometryBuffers,
} from '../terrain/vertexGrid.ts';
import {
  createArenaGeometry,
  createTerrainMaterial,
  type TerrainVertexLayout,
} from './terrainMaterial.ts';

/** Where slot bounds and `mesh.position` live: world coordinates, or relative to the super-mesh centre. */
export type ArenaFrame = 'world' | 'superLocal';

export interface ArenaSlotBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface ArenaSuperBuffers {
  readonly geometry: BufferGeometry;
  readonly positionAttribute: BufferAttribute | InterleavedBufferAttribute;
  /** null when the layout carries colour as a palette key inside the position attribute. */
  readonly colorAttribute: BufferAttribute | null;
  readonly normalAttribute: BufferAttribute | null;
  readonly triangleCapacity: number;
  /** Where the arena puts `mesh.position`, so the slot bounds it stores read as local. */
  readonly localOrigin: Vector3;
}

/** The arena's byte layer: vertex bytes, three attributes and the layout's material.
 *  Slots, holes, slack and scheduling stay in terrainMeshes.ts. */
export interface ArenaStore {
  readonly frame: ArenaFrame;
  /** Compaction cost model: ms per vertex moved, plus a fixed cost per move. */
  readonly transferMsPerVertex: number;
  readonly moveOverheadMs: number;
  /** Compaction budgets in the store's own currency: wall-clock for CPU, GPU time for GPU. */
  readonly compactStrokeBudgetMs: number;
  readonly compactIdleBudgetMs: number;
  /** GPU-time budget per frame for `write`; drain stops splicing when spent. CPU: Infinity. */
  readonly frameWriteBudgetMs: number;
  readonly material: MeshStandardNodeMaterial;
  /** How the store stores vertex positions; the material is warmed against it. */
  readonly layout: TerrainVertexLayout;
  /** Whether `write` can take this answer's layout. A rejected answer never reaches a slot. */
  accepts(answer: ChunkAnswer): boolean;
  /** Estimated GPU-time cost of `write(answer)`; 0 for the CPU store. */
  writeCostMs(answer: ChunkAnswer): number;
  /** Vertex bytes the arena holds, capacity not live count; scratch included. */
  residentBytes(): number;
  /** `originX/originZ`: super-mesh corner, world units. A superLocal store positions the mesh. */
  createSuper(
    superIdx: number,
    originX: number,
    originZ: number,
    triangleCapacity: number,
  ): ArenaSuperBuffers;
  /** Reallocates, keeping the first `liveEnd` vertices; the caller disposes the old geometry. */
  grow(superIdx: number, triangleCapacity: number, liveEnd: number): ArenaSuperBuffers;
  /** Writes the answer at `vertexOffset`; returns slot bounds in `frame`. Releases a GPU
   *  answer. `null` when nothing was written: the slot range is left zeroed. */
  write(superIdx: number, vertexOffset: number, answer: ChunkAnswer): ArenaSlotBounds | null;
  copyWithin(superIdx: number, toVertex: number, fromVertex: number, vertexCount: number): void;
  zero(superIdx: number, startVertex: number, vertexCount: number): void;
  /** A changed vertex range, clamped to the live end. CPU: update ranges + needsUpdate. GPU: no-op. */
  markRange(superIdx: number, startVertex: number, vertexCount: number): void;
  /** End of the arena's frame callback and of `flush()`: the GPU store submits its encoder. */
  commit(): void;
  dispose(superIdx: number): void;
  disposeAll(): void;
  /** Frees the material. Called by whoever created the store. */
  destroy(): void;
}

/** A GPU answer holds a window entry until it is written or discarded. */
export function releaseAnswer(answer: ChunkAnswer): void {
  if (answer.kind === 'gpu') answer.gpu.release();
}

export const ARENA_TRANSFER_MS_PER_VERTEX = 19 / 1e6;

export const ARENA_COMPACT_STROKE_BUDGET_MS = 1.0;

export const ARENA_COMPACT_IDLE_BUDGET_MS = 3.0;

const COMPONENTS_PER_POSITION = 3;

/** A typed-array move has no fixed floor; its whole cost is linear in the vertices moved. */
const CPU_ARENA_MOVE_OVERHEAD_MS = 0;

/** A CPU splice is charged to the wall-clock splice budget, never to a GPU-time budget. */
const CPU_ARENA_WRITE_COST_MS = 0;

/** World-frame stores leave the mesh at the origin, so their bounds are world bounds. */
const WORLD_FRAME_ORIGIN = new Vector3(0, 0, 0);


interface CpuSuper {
  buffers: ChunkGeometryBuffers;
  positionAttribute: BufferAttribute;
  // normalAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
}

/** The CPU mesher writes world-unit floats; the GPU store brings the packed layout. */
const CPU_ARENA_VERTEX_LAYOUT: TerrainVertexLayout = 'float32';

export function createCpuArenaStore(
  material: MeshStandardNodeMaterial = createTerrainMaterial(CPU_ARENA_VERTEX_LAYOUT),
): ArenaStore {
  const supers = new Map<number, CpuSuper>();

  const superAt = (superIdx: number): CpuSuper => {
    const cpu = supers.get(superIdx);
    if (cpu === undefined) throw new Error(`arena super-mesh ${superIdx} has no buffers`);
    return cpu;
  };

  const bind = (superIdx: number, buffers: ChunkGeometryBuffers): ArenaSuperBuffers => {
    const { geometry, positionAttribute, /* normalAttribute, */ colorAttribute } =
      createArenaGeometry(buffers);
    supers.set(superIdx, { buffers, positionAttribute, /* normalAttribute, */ colorAttribute });
    return {
      geometry,
      positionAttribute,
      normalAttribute: null,
      colorAttribute,
      triangleCapacity: buffers.triangleCapacity,
      localOrigin: WORLD_FRAME_ORIGIN,
    };
  };

  const addVertexRange = (
    attribute: BufferAttribute,
    startVertex: number,
    vertexCount: number,
  ): void => {
    if (vertexCount <= 0) return;
    const stride = attribute.itemSize;
    attribute.addUpdateRange(startVertex * stride, vertexCount * stride);
  };

  return {
    frame: 'world',
    transferMsPerVertex: ARENA_TRANSFER_MS_PER_VERTEX,
    moveOverheadMs: CPU_ARENA_MOVE_OVERHEAD_MS,
    compactStrokeBudgetMs: ARENA_COMPACT_STROKE_BUDGET_MS,
    compactIdleBudgetMs: ARENA_COMPACT_IDLE_BUDGET_MS,
    frameWriteBudgetMs: Infinity,
    material,
    layout: CPU_ARENA_VERTEX_LAYOUT,

    accepts(answer): boolean {
      return answer.kind === 'cpu';
    },

    writeCostMs(): number {
      return CPU_ARENA_WRITE_COST_MS;
    },

    residentBytes(): number {
      let bytes = 0;
      for (const cpu of supers.values()) {
        const { positions, /* normals, */ colors } = cpu.buffers;
        bytes += positions.byteLength + /* normals.byteLength + */ colors.byteLength;
      }
      return bytes;
    },

    createSuper(superIdx, _originX, _originZ, triangleCapacity): ArenaSuperBuffers {
      return bind(superIdx, createChunkGeometryBuffers(triangleCapacity));
    },

    grow(superIdx, triangleCapacity, liveEnd): ArenaSuperBuffers {
      const previous = superAt(superIdx).buffers;
      const grown = createChunkGeometryBuffers(triangleCapacity);
      grown.positions.set(previous.positions.subarray(0, liveEnd * COMPONENTS_PER_POSITION));
      // grown.normals.set(previous.normals.subarray(0, liveEnd * COMPONENTS_PER_NORMAL));
      grown.colors.set(previous.colors.subarray(0, liveEnd * COMPONENTS_PER_COLOR));
      return bind(superIdx, grown);
    },

    // `accepts` turns a GPU answer away before the arena commits a slot to it, so this is a
    // type guard, not a failure path.
    write(superIdx, vertexOffset, answer): ArenaSlotBounds | null {
      if (answer.kind !== 'cpu') return null;
      const { positions, /* normals, */ colors } = superAt(superIdx).buffers;
      positions.set(answer.positions, vertexOffset * COMPONENTS_PER_POSITION);
      // normals.set(answer.normals, vertexOffset * COMPONENTS_PER_NORMAL);
      colors.set(answer.colors, vertexOffset * COMPONENTS_PER_COLOR);
      return {
        minX: answer.bounds[0]!,
        minY: answer.bounds[1]!,
        minZ: answer.bounds[2]!,
        maxX: answer.bounds[3]!,
        maxY: answer.bounds[4]!,
        maxZ: answer.bounds[5]!,
      };
    },

    copyWithin(superIdx, toVertex, fromVertex, vertexCount): void {
      const { positions, /* normals, */ colors } = superAt(superIdx).buffers;
      const fromEnd = fromVertex + vertexCount;
      positions.copyWithin(
        toVertex * COMPONENTS_PER_POSITION,
        fromVertex * COMPONENTS_PER_POSITION,
        fromEnd * COMPONENTS_PER_POSITION,
      );
      // normals.copyWithin(
      //   toVertex * COMPONENTS_PER_NORMAL,
      //   fromVertex * COMPONENTS_PER_NORMAL,
      //   fromEnd * COMPONENTS_PER_NORMAL,
      // );
      colors.copyWithin(
        toVertex * COMPONENTS_PER_COLOR,
        fromVertex * COMPONENTS_PER_COLOR,
        fromEnd * COMPONENTS_PER_COLOR,
      );
    },

    zero(superIdx, startVertex, vertexCount): void {
      if (vertexCount <= 0) return;
      const { positions, /* normals, */ colors } = superAt(superIdx).buffers;
      positions.fill(
        0,
        startVertex * COMPONENTS_PER_POSITION,
        (startVertex + vertexCount) * COMPONENTS_PER_POSITION,
      );
      // normals.fill(
      //   0,
      //   startVertex * COMPONENTS_PER_NORMAL,
      //   (startVertex + vertexCount) * COMPONENTS_PER_NORMAL,
      // );
      colors.fill(
        0,
        startVertex * COMPONENTS_PER_COLOR,
        (startVertex + vertexCount) * COMPONENTS_PER_COLOR,
      );
    },

    markRange(superIdx, startVertex, vertexCount): void {
      const cpu = superAt(superIdx);
      addVertexRange(cpu.positionAttribute, startVertex, vertexCount);
      // addVertexRange(cpu.normalAttribute, startVertex, vertexCount);
      addVertexRange(cpu.colorAttribute, startVertex, vertexCount);
      cpu.positionAttribute.needsUpdate = true;
      // cpu.normalAttribute.needsUpdate = true;
      cpu.colorAttribute.needsUpdate = true;
    },

    commit(): void {},

    dispose(superIdx): void {
      supers.delete(superIdx);
    },

    disposeAll(): void {
      supers.clear();
    },

    destroy(): void {
      material.dispose();
    },
  };
}
