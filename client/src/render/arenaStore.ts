import type { BufferAttribute, BufferGeometry } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { ChunkAnswer } from './chunkBuildSource.ts';

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
  readonly positionAttribute: BufferAttribute;
  readonly colorAttribute: BufferAttribute;
  readonly normalAttribute: BufferAttribute | null;
  readonly triangleCapacity: number;
}

/** The arena's byte layer: vertex bytes, three attributes and the layout's material.
 *  Slots, holes, slack and scheduling stay in terrainMeshes.ts. */
export interface ArenaStore {
  readonly frame: ArenaFrame;
  /** Compaction cost model: ms per vertex moved, plus a fixed cost per move. */
  readonly transferMsPerVertex: number;
  readonly moveOverheadMs: number;
  /** GPU-time budget per frame for `write`; drain stops splicing when spent. CPU: Infinity. */
  readonly frameWriteBudgetMs: number;
  readonly material: MeshStandardNodeMaterial;
  /** Estimated GPU-time cost of `write(answer)`; 0 for the CPU store. */
  writeCostMs(answer: ChunkAnswer): number;
  /** `originX/originZ`: super-mesh corner, world units. A superLocal store positions the mesh. */
  createSuper(
    superIdx: number,
    originX: number,
    originZ: number,
    triangleCapacity: number,
  ): ArenaSuperBuffers;
  /** Reallocates, keeping the first `liveEnd` vertices; the caller disposes the old geometry. */
  grow(superIdx: number, triangleCapacity: number, liveEnd: number): ArenaSuperBuffers;
  /** Writes the answer at `vertexOffset`; returns slot bounds in `frame`. Releases a GPU answer. */
  write(superIdx: number, vertexOffset: number, answer: ChunkAnswer): ArenaSlotBounds;
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
