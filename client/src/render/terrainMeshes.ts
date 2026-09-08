import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  SRGBColorSpace,
  Vector3,
  type Group,
} from 'three';
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
import { spliceShader } from './shaderSplice.ts';
import { applyGroundShade } from './groundShade.ts';

export const CHUNK_SPLICE_FRAME_BUDGET_MS = 1.5;

export const ARENA_TRANSFER_MS_PER_VERTEX = 19 / 1e6;

export const ARENA_COMPACT_STROKE_BUDGET_MS = 1.0;

export const ARENA_COMPACT_IDLE_BUDGET_MS = 3.0;

const ARENA_P90_RUN_TRIANGLES = 13_653;

export const ARENA_HEADROOM_RUN_MULTIPLE = 2;

export const ARENA_HEADROOM_FLOOR_TRIANGLES =
  ARENA_HEADROOM_RUN_MULTIPLE * ARENA_P90_RUN_TRIANGLES;

export const TERRAIN_QUIET_MS = 2 * SCULPT_REPEAT_DELAY_MS;

const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

const SELF_LIT_ATTRIBUTE = 'selfLit';

function makeSelfLitAware(material: MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        '#include <common>',
        `#include <common>\nattribute float ${SELF_LIT_ATTRIBUTE};\nvarying float vSelfLit;`,
        'terrain',
      ),
      '#include <begin_vertex>',
      `vSelfLit = ${SELF_LIT_ATTRIBUTE};\n#include <begin_vertex>`,
      'terrain',
    );
    shader.vertexShader = spliceShader(
      shader.vertexShader,
      '#include <color_vertex>',
      `#include <color_vertex>
      vColor.rgb = mix(
        vColor.rgb / 12.92,
        pow( ( vColor.rgb + 0.055 ) / 1.055, vec3( 2.4 ) ),
        step( vec3( 0.04045 ), vColor.rgb )
      );`,
      'terrain',
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        shader.fragmentShader,
        '#include <common>',
        '#include <common>\nvarying float vSelfLit;',
        'terrain',
      ),
      '#include <opaque_fragment>',
      'outgoingLight = mix( outgoingLight, diffuseColor.rgb, vSelfLit );\n#include <opaque_fragment>',
      'terrain',
    );
  };
}

function toLinearPalette(palette: readonly Rgb[]): readonly Rgb[] {
  const scratch = new Color();
  return palette.map((entry) => {
    scratch.setRGB(entry[0], entry[1], entry[2], SRGBColorSpace);
    return [scratch.r, scratch.g, scratch.b] as Rgb;
  });
}

export const SUPER_MESH_SPAN_CHUNKS = 8;

const VERTICES_PER_TRIANGLE = 3;

interface ChunkSlot {
  offset: number;
  count: number;
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
  deadVertices: number;
  holeCount: number;
  growths: number;
  strokeGrowths: number;
}

export interface ArenaLayout {
  slots: { chunkIdx: number; offset: number; count: number }[];
  holes: { offset: number; length: number }[];
}

interface SuperMesh {
  mesh: Mesh;
  buffers: ChunkGeometryBuffers;
  positionAttribute: BufferAttribute;
  normalAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  selfLitAttribute: BufferAttribute;
  slots: Map<number, ChunkSlot>;
  holes: Hole[];
  liveEnd: number;
  reallocatedThisPass: boolean;
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
): TerrainMeshes {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const superCols = Math.ceil(chunkCols / SUPER_MESH_SPAN_CHUNKS);
  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: TERRAIN_ROUGHNESS,
    metalness: TERRAIN_METALNESS,
    side: DoubleSide,
  });
  makeSelfLitAware(material);
  applyGroundShade(material, 'terrain');

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
    const positionAttribute = new BufferAttribute(sm.buffers.positions, 3);
    const normalAttribute = new BufferAttribute(sm.buffers.normals, 3, true);
    const colorAttribute = new BufferAttribute(sm.buffers.colors, 3, true);
    const selfLitAttribute = new BufferAttribute(sm.buffers.selfLit, 1, true);
    positionAttribute.setUsage(DynamicDrawUsage);
    normalAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);
    selfLitAttribute.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('normal', normalAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setAttribute(SELF_LIT_ATTRIBUTE, selfLitAttribute);
    geometry.setDrawRange(0, sm.liveEnd);

    const previous = sm.mesh.geometry;
    sm.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();

    sm.positionAttribute = positionAttribute;
    sm.normalAttribute = normalAttribute;
    sm.colorAttribute = colorAttribute;
    sm.selfLitAttribute = selfLitAttribute;

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
    grown.normals.set(sm.buffers.normals.subarray(0, sm.liveEnd * 3));
    grown.colors.set(sm.buffers.colors.subarray(0, sm.liveEnd * 3));
    grown.selfLit.set(sm.buffers.selfLit.subarray(0, sm.liveEnd));
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
    sm.selfLitAttribute.needsUpdate = true;
  };

  const addRange = (sm: SuperMesh, startVertex: number, vertexCount: number): void => {
    if (sm.reallocatedThisPass) return;
    const start = Math.max(0, startVertex);
    const end = Math.min(sm.liveEnd, startVertex + vertexCount);
    if (end <= start) return;
    addVertexRange(sm.positionAttribute, start, end - start);
    addVertexRange(sm.normalAttribute, start, end - start);
    addVertexRange(sm.colorAttribute, start, end - start);
    addVertexRange(sm.selfLitAttribute, start, end - start);
  };

  const zeroVertices = (sm: SuperMesh, startVertex: number, vertexCount: number): void => {
    if (vertexCount <= 0) return;
    const { positions, normals, colors, selfLit } = sm.buffers;
    positions.fill(0, startVertex * 3, (startVertex + vertexCount) * 3);
    normals.fill(0, startVertex * 3, (startVertex + vertexCount) * 3);
    colors.fill(0, startVertex * 3, (startVertex + vertexCount) * 3);
    selfLit.fill(0, startVertex, startVertex + vertexCount);
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

  const takeHole = (
    sm: SuperMesh,
    count: number,
  ): { offset: number; surplus: number } | null => {
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
      return { offset, surplus };
    }
    return null;
  };

  const runStartingAt = (sm: SuperMesh, offset: number): ChunkSlot | undefined => {
    for (const slot of sm.slots.values()) {
      if (slot.count > 0 && slot.offset === offset) return slot;
    }
    return undefined;
  };

  const moveRunDown = (sm: SuperMesh, hole: Hole, run: ChunkSlot): void => {
    const from = run.offset;
    const runEnd = from + run.count;
    const to = hole.offset;
    const { positions, normals, colors, selfLit } = sm.buffers;
    positions.copyWithin(to * 3, from * 3, runEnd * 3);
    normals.copyWithin(to * 3, from * 3, runEnd * 3);
    colors.copyWithin(to * 3, from * 3, runEnd * 3);
    selfLit.copyWithin(to, from, runEnd);
    run.offset = to;

    const vacated = to + run.count;
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
        const costMs = run.count * ARENA_TRANSFER_MS_PER_VERTEX;
        if (spentMs + costMs > budgetMs) continue;
        moveRunDown(sm, hole, run);
        spentMs += costMs;
        moved = true;
        break;
      }
      if (!moved) return spentMs;
    }
  };

  const compact = (budgetMs: number): void => {
    let spentMs = 0;
    for (const sm of superMeshes.values()) {
      if (sm.holes.length === 0) continue;
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
      selfLitAttribute: placeholder,
      slots: new Map(),
      holes: [],
      liveEnd: 0,
      reallocatedThisPass: false,
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
    if (slot === undefined) {
      slot = {
        offset: 0,
        count: 0,
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

    if (count <= old) {
      zeroVertices(sm, slot.offset + count, old - count);
      dirtied.push([slot.offset, old]);
      slot.count = count;
      insertHole(sm, slot.offset + count, old - count);
    } else if (slot.offset + old === sm.liveEnd) {
      ensureSuperCapacity(sm, slot.offset + count, 'splice');
      sm.liveEnd = slot.offset + count;
      slot.count = count;
      dirtied.push([slot.offset, count]);
    } else {
      const reused = takeHole(sm, count);
      let freedOffset: number;
      if (reused !== null) {
        freedOffset = slot.offset;
        slot.offset = reused.offset;
        dirtied.push([reused.offset, count]);
        if (reused.surplus > 0) dirtied.push([reused.offset + count, reused.surplus]);
      } else {
        if (sm.liveEnd + count > capacityVertices(sm) && sm.holes.length > 0) {
          compactSuperMesh(sm, Infinity);
        }
        ensureSuperCapacity(sm, sm.liveEnd + count, 'splice');
        freedOffset = slot.offset;
        slot.offset = sm.liveEnd;
        sm.liveEnd += count;
        dirtied.push([slot.offset, count]);
      }
      slot.count = count;
      zeroVertices(sm, freedOffset, old);
      dirtied.push([freedOffset, old]);
      insertHole(sm, freedOffset, old);
    }

    const { positions, normals, colors, selfLit } = sm.buffers;
    positions.set(answer.positions, slot.offset * 3);
    normals.set(answer.normals, slot.offset * 3);
    colors.set(answer.colors, slot.offset * 3);
    selfLit.set(answer.selfLit, slot.offset);

    slot.minX = answer.bounds[0]!;
    slot.minY = answer.bounds[1]!;
    slot.minZ = answer.bounds[2]!;
    slot.maxX = answer.bounds[3]!;
    slot.maxY = answer.bounds[4]!;
    slot.maxZ = answer.bounds[5]!;

    markDirty(sm);
    for (const [startVertex, vertexCount] of dirtied) addRange(sm, startVertex, vertexCount);

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

      while (inFlight.size + ready.length < buildSource.concurrency) {
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
    for (const sm of superMeshes.values()) sm.reallocatedThisPass = false;
    for (;;) {
      const chunkIdx = nextSubmittable();
      if (chunkIdx !== undefined) {
        pending.delete(chunkIdx);
        submit(chunkIdx);
      }
      if (ready.length > 0) spliceAnswer(ready.shift()!);
      else if (chunkIdx === undefined) break;
    }
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

  const settle = (options?: SettleOptions): void => {
    if (options?.assumeQuiet !== true && now() - lastUpdateMs < TERRAIN_QUIET_MS) return;
    for (const [superIdx, sm] of superMeshes) {
      if (capacityVertices(sm) - sm.liveEnd >= headroom(sm)) continue;
      if (superMeshHasChunkQueued(superIdx)) continue;
      ensureSuperCapacity(sm, sm.liveEnd + headroom(sm), 'settle');
      return;
    }
  };

  const stopDraining = scheduling?.onFrame(() => {
    for (const sm of superMeshes.values()) sm.reallocatedThisPass = false;
    const spliced = drain(CHUNK_SPLICE_FRAME_BUDGET_MS);
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
      if (spliceMs.length === 0) return null;
      const sorted = [...spliceMs].sort((a, b) => a - b);
      return sorted[sorted.length >> 1]!;
    },

    arenaStats(): ArenaStats[] {
      return Array.from(superMeshes.values(), (sm) => {
        const live = liveCount(sm);
        return {
          liveEnd: sm.liveEnd,
          liveCount: live,
          deadVertices: sm.liveEnd - live,
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
      material.dispose();
    },
  };
}
