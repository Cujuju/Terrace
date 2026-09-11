import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  Sphere,
  SRGBColorSpace,
  Vector3,
  type Group,
} from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import { chunksPerEdge } from '@terrace/shared';
import { SCULPT_REPEAT_DELAY_MS } from '../config.ts';
import {
  createDirectChunkBuildSource,
  type ChunkBuildSource,
} from './chunkBuildSource.ts';
import type { ChunkJobAnswer } from '../terrain/chunkJob.ts';
import { type Rgb } from '../terrain/bandColors.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  createChunkGeometryBuffers,
  type ChunkGeometryBuffers,
} from '../terrain/vertexGrid.ts';
import {
  createDrawnGroundStore,
  type DrawnGroundStore,
} from '../terrain/drawnGroundStore.ts';
import { COMPONENTS_PER_COLOR, COMPONENTS_PER_NORMAL } from '../terrain/capEmission.ts';
import { createArenaGeometry, createTerrainMaterial } from './terrainMaterial.ts';

export const CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5;

/** Built-or-building answers held at once: two frames of splices (~4 per 1.5 ms) at ~1.6 MB each. */
export const CHUNK_ANSWER_BACKLOG_CAP = 8;

export const ARENA_TRANSFER_MS_PER_VERTEX = 19 / 1e6;

export const ARENA_COMPACT_STROKE_BUDGET_MS = 1.0;

export const ARENA_COMPACT_IDLE_BUDGET_MS = 3.0;

const ARENA_P90_RUN_TRIANGLES = 13_653;

export const ARENA_HEADROOM_RUN_MULTIPLE = 2;

export const ARENA_HEADROOM_FLOOR_TRIANGLES =
  ARENA_HEADROOM_RUN_MULTIPLE * ARENA_P90_RUN_TRIANGLES;

export const TERRAIN_QUIET_MS = 2 * SCULPT_REPEAT_DELAY_MS;

function toLinearPalette(palette: readonly Rgb[]): readonly Rgb[] {
  const scratch = new Color();
  return palette.map((entry) => {
    scratch.setRGB(entry[0], entry[1], entry[2], SRGBColorSpace);
    return [scratch.r, scratch.g, scratch.b] as Rgb;
  });
}

/** Chunks per side of one super-mesh. WebGPU writeBuffer is charged by the range, not the
 *  buffer, so a larger arena splices no dearer and halves the draws and bindings per frame. */
export const SUPER_MESH_SPAN_CHUNKS = 8;

const VERTICES_PER_TRIANGLE = 3;

/** Spare capacity a reallocated slot reserves, so a chunk that keeps growing under a held
 *  stroke re-meshes in place instead of relocating. */
export const SLOT_SLACK_FACTOR = 1.25;

const slackCapacity = (count: number): number =>
  Math.ceil((count * SLOT_SLACK_FACTOR) / VERTICES_PER_TRIANGLE) * VERTICES_PER_TRIANGLE;

interface ChunkSlot {
  offset: number;
  count: number;
  capacity: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface Hole {
  offset: number;
  length: number;
}

export interface ArenaStats {
  liveEnd: number;
  liveCount: number;
  paddingVertices: number;
  deadVertices: number;
  holeCount: number;
  growths: number;
  strokeGrowths: number;
}

export interface ArenaLayout {
  slots: { chunkIdx: number; offset: number; count: number; capacity: number }[];
  holes: { offset: number; length: number }[];
}

interface SuperMesh {
  mesh: Mesh;
  buffers: ChunkGeometryBuffers;
  positionAttribute: BufferAttribute;
  normalAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  slots: Map<number, ChunkSlot>;
  holes: Hole[];
  liveEnd: number;
  reallocatedThisPass: boolean;
  splicedThisPass: boolean;
  growths: number;
  strokeGrowths: number;
}

type GrowthSite =
  | 'splice'
  | 'settle';

export interface MeshScheduling {
  onFrame: (handler: (dt: number) => void) => () => void;
  now?: () => number;
}

export interface SettleOptions {
  readonly assumeQuiet?: boolean;
}

export interface TerrainLoadTrace {
  readonly firstUpdateMs: number | null;
  readonly queueEmptyAfterMs: number | null;
  readonly chunksAtQueueEmpty: number | null;
  readonly chunksSpliced: number;
  readonly spliceWallMs: number;
  readonly medianSpliceMs: number | null;
  readonly maxSpliceMs: number | null;
}

export interface TerrainMeshes {
  update(dirty: Iterable<number>): void;
  flush(): void;
  settle(options?: SettleOptions): void;
  pendingCount(): number;
  clear(): void;
  pickables(): Mesh[];
  drawnGround(): DrawnGroundStore;
  onChunkDrawn(handler: (chunkIdx: number) => void): () => void;
  drawCallCount(): number;
  medianSpliceMs(): number | null;
  loadTrace(): TerrainLoadTrace;
  arenaStats(): ArenaStats[];
  arenaLayout(): ArenaLayout[];
  builtChunkCount(): number;
  dispose(): void;
}

export function createTerrainMeshes(
  group: Group,
  mirror: TerrainMirror,
  scheduling?: MeshScheduling,
  buildSource: ChunkBuildSource = createDirectChunkBuildSource(),
  sharedMaterial?: MeshStandardNodeMaterial,
): TerrainMeshes {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const superCols = Math.ceil(chunkCols / SUPER_MESH_SPAN_CHUNKS);
  const material = sharedMaterial ?? createTerrainMaterial();
  const ownsMaterial = sharedMaterial === undefined;

  const superMeshes = new Map<number, SuperMesh>();

  const drawnGroundStore = createDrawnGroundStore(worldSize);

  const chunkDrawnHandlers = new Set<(chunkIdx: number) => void>();

  const superIndexOf = (chunkIdx: number): number => {
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;
    const sx = Math.floor(cx / SUPER_MESH_SPAN_CHUNKS);
    const sy = Math.floor(cy / SUPER_MESH_SPAN_CHUNKS);
    return sy * superCols + sx;
  };

  const bindGeometry = (sm: SuperMesh): void => {
    sm.reallocatedThisPass = true;
    const { geometry, positionAttribute, normalAttribute, colorAttribute } =
      createArenaGeometry(sm.buffers);
    geometry.setDrawRange(0, sm.liveEnd);

    const previous = sm.mesh.geometry;
    sm.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();

    sm.positionAttribute = positionAttribute;
    sm.normalAttribute = normalAttribute;
    sm.colorAttribute = colorAttribute;

    updateBounds(sm);
  };

  const capacityVertices = (sm: SuperMesh): number =>
    sm.buffers.triangleCapacity * VERTICES_PER_TRIANGLE;

  const ensureSuperCapacity = (
    sm: SuperMesh,
    vertices: number,
    site: GrowthSite,
  ): boolean => {
    if (vertices <= capacityVertices(sm)) return false;
    let triangles = Math.max(sm.buffers.triangleCapacity, 1);
    while (triangles * VERTICES_PER_TRIANGLE < vertices) triangles *= 2;

    const grown = createChunkGeometryBuffers(triangles);
    grown.positions.set(sm.buffers.positions.subarray(0, sm.liveEnd * 3));
    grown.normals.set(sm.buffers.normals.subarray(0, sm.liveEnd * COMPONENTS_PER_NORMAL));
    grown.colors.set(sm.buffers.colors.subarray(0, sm.liveEnd * COMPONENTS_PER_COLOR));
    sm.buffers = grown;
    sm.growths++;
    if (site === 'splice') sm.strokeGrowths++;
    bindGeometry(sm);
    return true;
  };

  const updateBounds = (sm: SuperMesh): void => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const slot of sm.slots.values()) {
      if (slot.count === 0) continue;
      if (slot.minX < minX) minX = slot.minX;
      if (slot.minY < minY) minY = slot.minY;
      if (slot.minZ < minZ) minZ = slot.minZ;
      if (slot.maxX > maxX) maxX = slot.maxX;
      if (slot.maxY > maxY) maxY = slot.maxY;
      if (slot.maxZ > maxZ) maxZ = slot.maxZ;
    }
    const geometry = sm.mesh.geometry;
    if (minX > maxX) {
      geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
      geometry.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(0, 0, 0));
      return;
    }
    geometry.boundingBox = new Box3(
      new Vector3(minX, minY, minZ),
      new Vector3(maxX, maxY, maxZ),
    );
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    geometry.boundingSphere = new Sphere(
      new Vector3(centreX, centreY, centreZ),
      Math.hypot(maxX - centreX, maxY - centreY, maxZ - centreZ),
    );
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

  const markDirty = (sm: SuperMesh): void => {
    sm.positionAttribute.needsUpdate = true;
    sm.normalAttribute.needsUpdate = true;
    sm.colorAttribute.needsUpdate = true;
  };

  const addRange = (sm: SuperMesh, startVertex: number, vertexCount: number): void => {
    if (sm.reallocatedThisPass) return;
    const start = Math.max(0, startVertex);
    const end = Math.min(sm.liveEnd, startVertex + vertexCount);
    if (end <= start) return;
    addVertexRange(sm.positionAttribute, start, end - start);
    addVertexRange(sm.normalAttribute, start, end - start);
    addVertexRange(sm.colorAttribute, start, end - start);
  };

  const zeroVertices = (sm: SuperMesh, startVertex: number, vertexCount: number): void => {
    if (vertexCount <= 0) return;
    const { positions, normals, colors } = sm.buffers;
    positions.fill(0, startVertex * 3, (startVertex + vertexCount) * 3);
    normals.fill(0, startVertex * COMPONENTS_PER_NORMAL, (startVertex + vertexCount) * COMPONENTS_PER_NORMAL);
    colors.fill(0, startVertex * COMPONENTS_PER_COLOR, (startVertex + vertexCount) * COMPONENTS_PER_COLOR);
  };

  const retreatFromLiveEnd = (sm: SuperMesh): void => {
    for (;;) {
      const last = sm.holes[sm.holes.length - 1];
      if (last === undefined || last.offset + last.length !== sm.liveEnd) break;
      sm.holes.pop();
      sm.liveEnd = last.offset;
    }
    sm.mesh.geometry.setDrawRange(0, sm.liveEnd);
  };

  const insertHole = (sm: SuperMesh, offset: number, length: number): void => {
    if (length <= 0) return;
    let at = 0;
    while (at < sm.holes.length && sm.holes[at]!.offset < offset) at++;
    sm.holes.splice(at, 0, { offset, length });
    const next = sm.holes[at + 1];
    const here = sm.holes[at]!;
    if (next !== undefined && here.offset + here.length === next.offset) {
      here.length += next.length;
      sm.holes.splice(at + 1, 1);
    }
    const previous = sm.holes[at - 1];
    if (previous !== undefined && previous.offset + previous.length === here.offset) {
      previous.length += here.length;
      sm.holes.splice(at, 1);
    }
    retreatFromLiveEnd(sm);
  };

  // What the taker does not use stays a hole, already zero on the GPU, so never re-sent.
  const takeHole = (sm: SuperMesh, count: number): number | null => {
    for (let i = 0; i < sm.holes.length; i++) {
      const hole = sm.holes[i]!;
      if (hole.length < count) continue;
      const offset = hole.offset;
      const surplus = hole.length - count;
      if (surplus === 0) sm.holes.splice(i, 1);
      else {
        hole.offset = offset + count;
        hole.length = surplus;
      }
      return offset;
    }
    return null;
  };

  const runStartingAt = (sm: SuperMesh, offset: number): ChunkSlot | undefined => {
    for (const slot of sm.slots.values()) {
      if (slot.capacity > 0 && slot.offset === offset) return slot;
    }
    return undefined;
  };

  // A run is its whole slot, padding included: the move overlaps, so the padding landing
  // on vacated live vertices has to reach the GPU as zeros.
  const moveRunDown = (sm: SuperMesh, hole: Hole, run: ChunkSlot): void => {
    const from = run.offset;
    const runEnd = from + run.capacity;
    const to = hole.offset;
    const { positions, normals, colors } = sm.buffers;
    positions.copyWithin(to * 3, from * 3, runEnd * 3);
    normals.copyWithin(to * COMPONENTS_PER_NORMAL, from * COMPONENTS_PER_NORMAL, runEnd * COMPONENTS_PER_NORMAL);
    colors.copyWithin(to * COMPONENTS_PER_COLOR, from * COMPONENTS_PER_COLOR, runEnd * COMPONENTS_PER_COLOR);
    run.offset = to;

    const vacated = to + run.capacity;
    zeroVertices(sm, vacated, runEnd - vacated);
    sm.holes.splice(sm.holes.indexOf(hole), 1);
    insertHole(sm, vacated, runEnd - vacated);
    markDirty(sm);
    addRange(sm, to, runEnd - to);
  };

  const compactSuperMesh = (sm: SuperMesh, budgetMs: number): number => {
    let spentMs = 0;
    for (;;) {
      let moved = false;
      for (const hole of sm.holes) {
        const run = runStartingAt(sm, hole.offset + hole.length);
        if (run === undefined) continue;
        const costMs = (hole.length + run.capacity) * ARENA_TRANSFER_MS_PER_VERTEX;
        if (spentMs + costMs > budgetMs) continue;
        moveRunDown(sm, hole, run);
        spentMs += costMs;
        moved = true;
        break;
      }
      if (!moved) return spentMs;
    }
  };

  const busy = (superIdx: number, sm: SuperMesh): boolean =>
    sm.splicedThisPass || superMeshHasChunkQueued(superIdx);

  // Compaction re-uploads every vertex it moves. While chunks are still arriving it
  // runs only to keep the headroom a growth would otherwise need; growth re-uploads
  // the whole arena.
  const compact = (budgetMs: number): void => {
    let spentMs = 0;
    for (const [superIdx, sm] of superMeshes) {
      if (sm.holes.length === 0) continue;
      if (busy(superIdx, sm) && capacityVertices(sm) - sm.liveEnd >= headroom(sm)) continue;
      spentMs += compactSuperMesh(sm, budgetMs - spentMs);
      if (spentMs >= budgetMs) return;
    }
  };

  const liveCount = (sm: SuperMesh): number => {
    let total = 0;
    for (const slot of sm.slots.values()) total += slot.count;
    return total;
  };

  const createSuperMesh = (superIdx: number): SuperMesh => {
    const placeholder = new BufferAttribute(new Float32Array(0), 3);
    const sm: SuperMesh = {
      mesh: new Mesh(new BufferGeometry(), material),
      buffers: createChunkGeometryBuffers(),
      positionAttribute: placeholder,
      normalAttribute: placeholder,
      colorAttribute: placeholder,
      slots: new Map(),
      holes: [],
      liveEnd: 0,
      reallocatedThisPass: false,
      splicedThisPass: false,
      growths: 0,
      strokeGrowths: 0,
    };
    bindGeometry(sm);
    group.add(sm.mesh);
    superMeshes.set(superIdx, sm);
    return sm;
  };

  const spliceChunk = (sm: SuperMesh, chunkIdx: number, answer: ChunkJobAnswer): void => {
    const count = answer.vertexCount;
    let slot = sm.slots.get(chunkIdx);
    // A chunk's first build takes no slack: load-time layout and residency stay as they were.
    const firstBuild = slot === undefined;
    if (slot === undefined) {
      slot = {
        offset: 0,
        count: 0,
        capacity: 0,
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
      };
      sm.slots.set(chunkIdx, slot);
    }

    const old = slot.count;
    const dirtied: [number, number][] = [];

    if (count <= slot.capacity) {
      zeroVertices(sm, slot.offset + count, old - count);
      slot.count = count;
      dirtied.push([slot.offset, Math.max(count, old)]);
    } else if (slot.offset + slot.capacity === sm.liveEnd) {
      const capacity = firstBuild ? count : slackCapacity(count);
      ensureSuperCapacity(sm, slot.offset + capacity, 'splice');
      sm.liveEnd = slot.offset + capacity;
      slot.count = count;
      slot.capacity = capacity;
      // The padding lay beyond the old live end, where the GPU may hold stale vertices.
      zeroVertices(sm, slot.offset + count, capacity - count);
      dirtied.push([slot.offset, capacity]);
    } else {
      const capacity = firstBuild ? count : slackCapacity(count);
      const reusedOffset = takeHole(sm, capacity);
      let freedOffset: number;
      if (reusedOffset !== null) {
        freedOffset = slot.offset;
        slot.offset = reusedOffset;
        // A hole is zero on the GPU already, so the padding taken from it is not sent.
        dirtied.push([reusedOffset, count]);
      } else {
        if (sm.liveEnd + capacity > capacityVertices(sm) && sm.holes.length > 0) {
          compactSuperMesh(sm, Infinity);
        }
        ensureSuperCapacity(sm, sm.liveEnd + capacity, 'splice');
        freedOffset = slot.offset;
        slot.offset = sm.liveEnd;
        sm.liveEnd += capacity;
        zeroVertices(sm, slot.offset + count, capacity - count);
        dirtied.push([slot.offset, capacity]);
      }
      const freedCapacity = slot.capacity;
      slot.count = count;
      slot.capacity = capacity;
      zeroVertices(sm, freedOffset, old);
      dirtied.push([freedOffset, old]);
      insertHole(sm, freedOffset, freedCapacity);
    }

    const { positions, normals, colors } = sm.buffers;
    positions.set(answer.positions, slot.offset * 3);
    normals.set(answer.normals, slot.offset * COMPONENTS_PER_NORMAL);
    colors.set(answer.colors, slot.offset * COMPONENTS_PER_COLOR);

    slot.minX = answer.bounds[0]!;
    slot.minY = answer.bounds[1]!;
    slot.minZ = answer.bounds[2]!;
    slot.maxX = answer.bounds[3]!;
    slot.maxY = answer.bounds[4]!;
    slot.maxZ = answer.bounds[5]!;

    markDirty(sm);
    for (const [startVertex, vertexCount] of dirtied) addRange(sm, startVertex, vertexCount);

    sm.splicedThisPass = true;
    sm.mesh.geometry.setDrawRange(0, sm.liveEnd);
    updateBounds(sm);
  };

  const pending = new Set<number>();

  const inFlight = new Set<number>();

  const ready: ChunkJobAnswer[] = [];

  const retry = new Set<number>();

  const SPLICE_SAMPLE_WINDOW = 64;
  const spliceMs: number[] = [];
  let spliceMsNext = 0;
  let firstUpdateMs: number | null = null;
  let queueEmptyAfterMs: number | null = null;
  let chunksAtQueueEmpty: number | null = null;
  let chunksSpliced = 0;
  let spliceWallMs = 0;

  const medianSplice = (): number | null => {
    if (spliceMs.length === 0) return null;
    const sorted = [...spliceMs].sort((a, b) => a - b);
    return sorted[sorted.length >> 1]!;
  };

  let generation = 0;

  const receive = (chunkIdx: number, answer: ChunkJobAnswer | null): void => {
    inFlight.delete(chunkIdx);
    if (answer === null) {
      if (mirror.received.has(chunkIdx)) retry.add(chunkIdx);
      return;
    }
    if (answer.generation !== generation) return;
    if (!mirror.received.has(answer.chunkIdx)) return;
    ready.push(answer);
  };

  const submit = (chunkIdx: number): void => {
    if (!mirror.received.has(chunkIdx)) return;
    inFlight.add(chunkIdx);
    const answer = buildSource.build(mirror, chunkIdx, generation);
    if (answer instanceof Promise) void answer.then((settled) => receive(chunkIdx, settled));
    else receive(chunkIdx, answer);
  };

  const spliceAnswer = (answer: ChunkJobAnswer): void => {
    const startedMs = now();
    drawnGroundStore.publishRastered(
      answer.chunkIdx,
      answer.plan,
      answer.topLevel,
      answer.lips,
    );
    const superIdx = superIndexOf(answer.chunkIdx);
    const sm = superMeshes.get(superIdx) ?? createSuperMesh(superIdx);
    spliceChunk(sm, answer.chunkIdx, answer);
    for (const handler of chunkDrawnHandlers) handler(answer.chunkIdx);
    const elapsedMs = now() - startedMs;
    chunksSpliced++;
    spliceWallMs += elapsedMs;
    if (spliceMs.length < SPLICE_SAMPLE_WINDOW) spliceMs.push(elapsedMs);
    else {
      spliceMs[spliceMsNext] = elapsedMs;
      spliceMsNext = (spliceMsNext + 1) % SPLICE_SAMPLE_WINDOW;
    }
  };

  const now = scheduling?.now ?? (() => performance.now());

  const nextSubmittable = (): number | undefined => {
    for (const chunkIdx of pending) {
      if (!inFlight.has(chunkIdx)) return chunkIdx;
    }
    return undefined;
  };

  const takeRetries = (): void => {
    if (retry.size === 0) return;
    for (const chunkIdx of retry) pending.add(chunkIdx);
    retry.clear();
  };

  const drain = (budgetMs: number): number => {
    takeRetries();
    let spliced = 0;
    if (pending.size === 0 && ready.length === 0) return spliced;
    const startedMs = now();
    for (;;) {

      while (
        inFlight.size < buildSource.concurrency &&
        inFlight.size + ready.length < CHUNK_ANSWER_BACKLOG_CAP
      ) {
        const chunkIdx = nextSubmittable();
        if (chunkIdx === undefined) break;
        pending.delete(chunkIdx);
        submit(chunkIdx);
      }
      if (ready.length === 0) return spliced;
      spliceAnswer(ready.shift()!);
      spliced++;
      if (now() - startedMs >= budgetMs) return spliced;
    }
  };

  const flush = (): void => {
    takeRetries();
    for (const sm of superMeshes.values()) {
      sm.reallocatedThisPass = false;
      sm.splicedThisPass = false;
    }
    for (;;) {
      const chunkIdx = nextSubmittable();
      if (chunkIdx !== undefined) {
        pending.delete(chunkIdx);
        submit(chunkIdx);
      }
      if (ready.length > 0) spliceAnswer(ready.shift()!);
      else if (chunkIdx === undefined) break;
    }
    for (const sm of superMeshes.values()) sm.splicedThisPass = false;
    compact(Infinity);
  };

  const clear = (): void => {
    for (const sm of superMeshes.values()) {
      group.remove(sm.mesh);
      sm.mesh.geometry.dispose();
    }
    superMeshes.clear();
    drawnGroundStore.clear();
    pending.clear();
    retry.clear();
    inFlight.clear();
    ready.length = 0;
    generation++;
  };

  let lastUpdateMs = Number.NEGATIVE_INFINITY;

  const largestRunVertices = (sm: SuperMesh): number => {
    let largest = 0;
    for (const slot of sm.slots.values()) {
      if (slot.count > largest) largest = slot.count;
    }
    return largest;
  };

  const headroom = (sm: SuperMesh): number =>
    Math.max(
      ARENA_HEADROOM_RUN_MULTIPLE * largestRunVertices(sm),
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );

  const superMeshHasChunkQueued = (superIdx: number): boolean => {
    for (const chunkIdx of pending) {
      if (superIndexOf(chunkIdx) === superIdx) return true;
    }
    for (const chunkIdx of inFlight) {
      if (superIndexOf(chunkIdx) === superIdx) return true;
    }
    for (const chunkIdx of retry) {
      if (superIndexOf(chunkIdx) === superIdx) return true;
    }
    for (const answer of ready) {
      if (superIndexOf(answer.chunkIdx) === superIdx) return true;
    }
    return false;
  };

  // Slack is transient. Once the terrain is quiet the padding goes back on the free list,
  // for compaction and the live end to reclaim.
  const reclaimSlack = (sm: SuperMesh): boolean => {
    let reclaimed = false;
    for (const slot of sm.slots.values()) {
      const padding = slot.capacity - slot.count;
      if (padding <= 0) continue;
      slot.capacity = slot.count;
      insertHole(sm, slot.offset + slot.count, padding);
      reclaimed = true;
    }
    return reclaimed;
  };

  const settle = (options?: SettleOptions): void => {
    if (options?.assumeQuiet !== true && now() - lastUpdateMs < TERRAIN_QUIET_MS) return;
    for (const [superIdx, sm] of superMeshes) {
      if (superMeshHasChunkQueued(superIdx)) continue;
      // One super-mesh per call, the bound a growth already takes.
      if (reclaimSlack(sm)) return;
      if (capacityVertices(sm) - sm.liveEnd >= headroom(sm)) continue;
      ensureSuperCapacity(sm, sm.liveEnd + headroom(sm), 'settle');
      return;
    }
  };

  const stopDraining = scheduling?.onFrame(() => {
    for (const sm of superMeshes.values()) {
      sm.reallocatedThisPass = false;
      sm.splicedThisPass = false;
    }
    const spliced = drain(CHUNK_SPLICE_FRAME_BUDGET_MS);
    if (
      firstUpdateMs !== null &&
      queueEmptyAfterMs === null &&
      pending.size === 0 &&
      inFlight.size === 0 &&
      ready.length === 0
    ) {
      queueEmptyAfterMs = now() - firstUpdateMs;
      chunksAtQueueEmpty = chunksSpliced;
    }
    compact(spliced > 0 ? ARENA_COMPACT_STROKE_BUDGET_MS : ARENA_COMPACT_IDLE_BUDGET_MS);
    settle();
  });

  return {
    update(dirty: Iterable<number>): void {
      lastUpdateMs = now();
      for (const chunkIdx of dirty) {
        if (!mirror.received.has(chunkIdx)) continue;
        pending.add(chunkIdx);
      }
      if (firstUpdateMs === null && pending.size > 0) firstUpdateMs = now();
      if (stopDraining === undefined) flush();
    },
    flush,
    settle,
    pendingCount(): number {
      return pending.size + inFlight.size + ready.length + retry.size;
    },
    clear,
    pickables(): Mesh[] {
      return Array.from(superMeshes.values(), (sm) => sm.mesh);
    },
    drawnGround(): DrawnGroundStore {
      return drawnGroundStore;
    },
    onChunkDrawn(handler: (chunkIdx: number) => void): () => void {
      chunkDrawnHandlers.add(handler);
      return () => chunkDrawnHandlers.delete(handler);
    },

    medianSpliceMs(): number | null {
      return medianSplice();
    },

    loadTrace(): TerrainLoadTrace {
      return {
        firstUpdateMs,
        queueEmptyAfterMs,
        chunksAtQueueEmpty,
        chunksSpliced,
        spliceWallMs,
        medianSpliceMs: medianSplice(),
        maxSpliceMs: spliceMs.length === 0 ? null : Math.max(...spliceMs),
      };
    },

    arenaStats(): ArenaStats[] {
      return Array.from(superMeshes.values(), (sm) => {
        const live = liveCount(sm);
        let padding = 0;
        for (const slot of sm.slots.values()) padding += slot.capacity - slot.count;
        return {
          liveEnd: sm.liveEnd,
          liveCount: live,
          paddingVertices: padding,
          deadVertices: sm.liveEnd - live - padding,
          holeCount: sm.holes.length,
          growths: sm.growths,
          strokeGrowths: sm.strokeGrowths,
        };
      });
    },
    arenaLayout(): ArenaLayout[] {
      return Array.from(superMeshes.values(), (sm) => ({
        slots: Array.from(sm.slots, ([chunkIdx, slot]) => ({
          chunkIdx,
          offset: slot.offset,
          count: slot.count,
          capacity: slot.capacity,
        })),
        holes: sm.holes.map((hole) => ({ offset: hole.offset, length: hole.length })),
      }));
    },

    drawCallCount(): number {
      return superMeshes.size;
    },
    builtChunkCount(): number {
      let built = 0;
      for (const sm of superMeshes.values()) built += sm.slots.size;
      return built;
    },
    dispose(): void {
      stopDraining?.();
      clear();
      if (ownsMaterial) material.dispose();
    },
  };
}
