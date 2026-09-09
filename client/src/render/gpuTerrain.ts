import {
  Box3,
  DynamicDrawUsage,
  Frustum,
  InstancedBufferAttribute,
  Matrix4,
  Mesh,
  Vector2,
  type InstancedBufferGeometry,
  type MeshLambertMaterial,
  type Camera,
  type Group,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  TERRAIN_LOD_FAR_N,
  TERRAIN_LOD_MAX_SCREEN_ERROR_PIXELS,
  TERRAIN_LOD_NEAR_N,
  cellCoordToWorld,
  chunksPerEdge,
  drawnGroundChunkBandSpans,
  drawnGroundLodError,
  drawnGroundSubcellIsLayered,
} from '@terrace/shared';
import { CHUNK_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { RENDER_HALO_CELLS, type TerrainMirror } from '../terrain/mirror.ts';
import { createDrawnGroundStore, type DrawnGroundStore } from '../terrain/drawnGroundStore.ts';
import type { ArenaLayout, ArenaStats, TerrainMeshes } from './terrainMeshes.ts';
import {
  createBandPaletteTexture,
  createColumnSpanTextures,
  createHeightTexture,
} from './gpuTerrainTextures.ts';
import {
  BASE_CLASS_STEPS,
  CLASS_STEPS_UNIFORM,
  DRAWS_LAYERED_UNIFORM,
  LAYERED_OVERLAY_CLASS,
  SUBDIVISION_UNIFORM,
  createChunkTemplate,
  createGpuTerrainMaterial,
  overlayClassCap,
} from './gpuTerrainMaterial.ts';

export const GPU_TERRAIN_SMOOTH_DEFAULT = true;

/** The bilinear blend floors to a band, so a chunk can drop one band below its cells. */
const CHUNK_BOUND_SLACK_HEIGHT = BAND_HEIGHT;

const INSTANCE_COMPONENTS = 2;

/** Near sub-cells per chunk side, the row stride of `drawnGroundChunkBandSpans`. */
const SUBCELLS_PER_CHUNK = CHUNK_SIZE * TERRAIN_LOD_NEAR_N;

/** Overlays draw after both base levels, so a shared edge resolves the same way. */
const OVERLAY_RENDER_ORDER = 2;

/** First instance buffer a class takes; it doubles from here as chunks arrive. */
const OVERLAY_INITIAL_INSTANCES = 64;

const OVERLAY_CAPACITY_GROWTH = 2;

interface LodLevel {
  readonly mesh: Mesh;
  readonly geometry: InstancedBufferGeometry;
  readonly material: MeshLambertMaterial;
  readonly origins: InstancedBufferAttribute;
  visible: number;
}

/** One sub-cell class: every sub-cell whose band span needs `cap` thresholds. */
interface OverlayClass {
  readonly mesh: Mesh;
  readonly geometry: InstancedBufferGeometry;
  readonly material: MeshLambertMaterial;
  origins: InstancedBufferAttribute;
  capacity: number;
  visible: number;
}

/** A chunk's sub-cells that the base pass leaves to an overlay, grouped by class. */
interface OverlayEntry {
  readonly cap: number;
  readonly origins: Float32Array;
}

function createLevel(
  subdivision: number,
  chunkCount: number,
  uniforms: Record<string, IUniform>,
  renderOrder: number,
): LodLevel {
  const { geometry } = createChunkTemplate(subdivision);
  const origins = new InstancedBufferAttribute(
    new Float32Array(chunkCount * INSTANCE_COMPONENTS),
    INSTANCE_COMPONENTS,
  );
  origins.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aChunk', origins);
  geometry.instanceCount = 0;
  const material = createGpuTerrainMaterial({
    ...uniforms,
    [SUBDIVISION_UNIFORM]: { value: subdivision },
    [CLASS_STEPS_UNIFORM]: { value: BASE_CLASS_STEPS },
    [DRAWS_LAYERED_UNIFORM]: { value: 0 },
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  return { mesh, geometry, material, origins, visible: 0 };
}

export function createGpuTerrainMeshes(group: Group, mirror: TerrainMirror): TerrainMeshes {
  const map = mirror.renderMap;
  const chunkCols = chunksPerEdge(map.size);
  const chunkCount = chunkCols * chunkCols;

  const height = createHeightTexture(map);
  const columnSpans = createColumnSpanTextures(map);
  const palette = createBandPaletteTexture();
  const smooth: IUniform<number> = { value: GPU_TERRAIN_SMOOTH_DEFAULT ? 1 : 0 };
  const shared: Record<string, IUniform> = {
    uHeight: { value: height.texture },
    uPalette: { value: palette },
    uSizeCells: { value: map.size },
    uSmooth: smooth,
    ...columnSpans.uniforms,
  };

  const near = createLevel(TERRAIN_LOD_NEAR_N, chunkCount, shared, 0);
  const far = createLevel(TERRAIN_LOD_FAR_N, chunkCount, shared, 1);
  const levels = [near, far];

  /** Built lazily, one per power-of-two class a sub-cell has actually asked for. */
  const overlayClasses = new Map<number, OverlayClass>();
  const overlayByChunk = new Map<number, OverlayEntry[]>();
  const nearChunks: number[] = [];

  const built = new Uint8Array(chunkCount);
  const builtChunks: number[] = [];
  const minY = new Float32Array(chunkCount);
  const maxY = new Float32Array(chunkCount);
  /** Height a chunk loses at the far level, in world units. */
  const lodError = new Float32Array(chunkCount);
  const pending = new Set<number>();
  const drawnHandlers = new Set<(chunkIdx: number) => void>();
  const drawnGroundStore = createDrawnGroundStore(map.size);

  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  const bounds = new Box3();
  const viewport = new Vector2();

  const overlayClassFor = (cap: number): OverlayClass => {
    const held = overlayClasses.get(cap);
    if (held !== undefined) return held;
    // A class instance is one sub-cell, so its template spans one sub-cell.
    const { geometry } = createChunkTemplate(TERRAIN_LOD_NEAR_N, cap, 1 / TERRAIN_LOD_NEAR_N);
    const origins = new InstancedBufferAttribute(
      new Float32Array(OVERLAY_INITIAL_INSTANCES * INSTANCE_COMPONENTS),
      INSTANCE_COMPONENTS,
    );
    origins.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aChunk', origins);
    geometry.instanceCount = 0;
    const material = createGpuTerrainMaterial({
      ...shared,
      [SUBDIVISION_UNIFORM]: { value: TERRAIN_LOD_NEAR_N },
      [CLASS_STEPS_UNIFORM]: { value: cap },
      [DRAWS_LAYERED_UNIFORM]: { value: cap === LAYERED_OVERLAY_CLASS ? 1 : 0 },
    });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = OVERLAY_RENDER_ORDER;
    group.add(mesh);
    const created: OverlayClass = {
      mesh,
      geometry,
      material,
      origins,
      capacity: OVERLAY_INITIAL_INSTANCES,
      visible: 0,
    };
    overlayClasses.set(cap, created);
    return created;
  };

  const growOverlay = (overlay: OverlayClass, needed: number): void => {
    if (needed <= overlay.capacity) return;
    let capacity = overlay.capacity;
    while (capacity < needed) capacity *= OVERLAY_CAPACITY_GROWTH;
    const origins = new InstancedBufferAttribute(
      new Float32Array(capacity * INSTANCE_COMPONENTS),
      INSTANCE_COMPONENTS,
    );
    origins.setUsage(DynamicDrawUsage);
    overlay.geometry.setAttribute('aChunk', origins);
    overlay.origins = origins;
    overlay.capacity = capacity;
  };

  /** Which sub-cells of a chunk the base pass cannot draw, and the class each needs. */
  const classifyChunk = (cx: number, cy: number, chunkIdx: number): void => {
    const spans = drawnGroundChunkBandSpans(map, cx, cy);
    const lists = new Map<number, number[]>();
    for (let j = 0; j < SUBCELLS_PER_CHUNK; j++) {
      for (let i = 0; i < SUBCELLS_PER_CHUNK; i++) {
        const subX = cx * SUBCELLS_PER_CHUNK + i;
        const subY = cy * SUBCELLS_PER_CHUNK + j;
        const bands = spans[j * SUBCELLS_PER_CHUNK + i]!;
        const layered = drawnGroundSubcellIsLayered(map, subX, subY);
        if (!layered && bands <= BASE_CLASS_STEPS) continue;
        const cap = layered ? LAYERED_OVERLAY_CLASS : overlayClassCap(bands);
        let list = lists.get(cap);
        if (list === undefined) {
          list = [];
          lists.set(cap, list);
        }
        list.push(subX / TERRAIN_LOD_NEAR_N, subY / TERRAIN_LOD_NEAR_N);
      }
    }
    if (lists.size === 0) {
      overlayByChunk.delete(chunkIdx);
      return;
    }
    const entries: OverlayEntry[] = [];
    for (const [cap, list] of lists) {
      overlayClassFor(cap);
      entries.push({ cap, origins: Float32Array.from(list) });
    }
    overlayByChunk.set(chunkIdx, entries);
  };

  const measureChunk = (cx: number, cy: number, chunkIdx: number): void => {
    const x0 = Math.max(0, cx * CHUNK_SIZE - RENDER_HALO_CELLS);
    const y0 = Math.max(0, cy * CHUNK_SIZE - RENDER_HALO_CELLS);
    const x1 = Math.min(map.size - 1, (cx + 1) * CHUNK_SIZE + RENDER_HALO_CELLS - 1);
    const y1 = Math.min(map.size - 1, (cy + 1) * CHUNK_SIZE + RENDER_HALO_CELLS - 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = y0; y <= y1; y++) {
      const row = y * map.size;
      for (let x = x0; x <= x1; x++) {
        const h = map.cells[row + x];
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    minY[chunkIdx] = (lo - CHUNK_BOUND_SLACK_HEIGHT) * HEIGHT_WORLD_SCALE;
    maxY[chunkIdx] = hi * HEIGHT_WORLD_SCALE;
    lodError[chunkIdx] = drawnGroundLodError(map, cx, cy) * HEIGHT_WORLD_SCALE;
    classifyChunk(cx, cy, chunkIdx);
  };

  const flushUploads = (renderer: WebGLRenderer): void => {
    if (pending.size === 0) return;
    for (const chunkIdx of pending) {
      const cx = chunkIdx % chunkCols;
      const cy = (chunkIdx - cx) / chunkCols;
      const x0 = Math.max(0, cx * CHUNK_SIZE - RENDER_HALO_CELLS);
      const y0 = Math.max(0, cy * CHUNK_SIZE - RENDER_HALO_CELLS);
      const x1 = Math.min(map.size, (cx + 1) * CHUNK_SIZE + RENDER_HALO_CELLS);
      const y1 = Math.min(map.size, (cy + 1) * CHUNK_SIZE + RENDER_HALO_CELLS);
      height.uploadRect(renderer, x0, y0, x1 - x0, y1 - y0);
      columnSpans.uploadChunk(renderer, cx, cy);
      for (const handler of drawnHandlers) handler(chunkIdx);
    }
    pending.clear();
  };

  /** Overlay instances ride the chunk they belong to, at the level that draws them. */
  const selectOverlays = (): void => {
    for (const overlay of overlayClasses.values()) overlay.visible = 0;
    for (const chunkIdx of nearChunks) {
      const entries = overlayByChunk.get(chunkIdx);
      if (entries === undefined) continue;
      for (const entry of entries) {
        overlayClassFor(entry.cap).visible += entry.origins.length / INSTANCE_COMPONENTS;
      }
    }
    for (const overlay of overlayClasses.values()) {
      growOverlay(overlay, overlay.visible);
      overlay.visible = 0;
    }
    for (const chunkIdx of nearChunks) {
      const entries = overlayByChunk.get(chunkIdx);
      if (entries === undefined) continue;
      for (const entry of entries) {
        const overlay = overlayClassFor(entry.cap);
        overlay.origins.array.set(entry.origins, overlay.visible * INSTANCE_COMPONENTS);
        overlay.visible += entry.origins.length / INSTANCE_COMPONENTS;
      }
    }
    for (const overlay of overlayClasses.values()) {
      overlay.origins.clearUpdateRanges();
      overlay.origins.addUpdateRange(0, overlay.visible * INSTANCE_COMPONENTS);
      overlay.origins.needsUpdate = true;
      overlay.geometry.instanceCount = overlay.visible;
    }
  };

  const selectChunks = (renderer: WebGLRenderer, camera: Camera): void => {
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    const eye = camera.matrixWorld;
    const eyeX = eye.elements[12]!;
    const eyeY = eye.elements[13]!;
    const eyeZ = eye.elements[14]!;
    // Perspective row that scales view-space Y into clip space: 1 / tan(fov / 2).
    const clipScaleY = camera.projectionMatrix.elements[5]!;
    renderer.getSize(viewport);
    const pixelsPerWorldAtUnitDistance = (clipScaleY * viewport.y) / 2;
    // Error and distance both scale linearly, so compare their squares and skip the roots.
    const errorPerDistanceSq =
      (TERRAIN_LOD_MAX_SCREEN_ERROR_PIXELS / pixelsPerWorldAtUnitDistance) ** 2;
    near.visible = 0;
    far.visible = 0;
    nearChunks.length = 0;
    for (const chunkIdx of builtChunks) {
      const cx = chunkIdx % chunkCols;
      const cy = (chunkIdx - cx) / chunkCols;
      const originX = cellCoordToWorld(cx * CHUNK_SIZE);
      const originZ = cellCoordToWorld(cy * CHUNK_SIZE);
      bounds.min.set(originX, minY[chunkIdx]!, originZ);
      bounds.max.set(originX + CHUNK_WORLD_SIZE, maxY[chunkIdx]!, originZ + CHUNK_WORLD_SIZE);
      if (!frustum.intersectsBox(bounds)) continue;
      const dx = eyeX - (originX + CHUNK_WORLD_SIZE / 2);
      const dy = eyeY - (minY[chunkIdx]! + maxY[chunkIdx]!) / 2;
      const dz = eyeZ - (originZ + CHUNK_WORLD_SIZE / 2);
      const error = lodError[chunkIdx]!;
      const isNear = error * error > errorPerDistanceSq * (dx * dx + dy * dy + dz * dz);
      const level = isNear ? near : far;
      if (isNear) nearChunks.push(chunkIdx);
      const slot = level.visible * INSTANCE_COMPONENTS;
      level.origins.array[slot] = cx * CHUNK_SIZE;
      level.origins.array[slot + 1] = cy * CHUNK_SIZE;
      level.visible++;
    }
    for (const level of levels) {
      level.origins.clearUpdateRanges();
      level.origins.addUpdateRange(0, level.visible * INSTANCE_COMPONENTS);
      level.origins.needsUpdate = true;
      level.geometry.instanceCount = level.visible;
    }
    selectOverlays();
  };

  near.mesh.onBeforeRender = (renderer, _scene, camera): void => {
    flushUploads(renderer);
    selectChunks(renderer, camera);
  };

  group.add(near.mesh, far.mesh);

  return {
    update(dirty: Iterable<number>): void {
      for (const chunkIdx of dirty) {
        if (chunkIdx < 0 || chunkIdx >= chunkCount) continue;
        if (!mirror.received.has(chunkIdx)) continue;
        const cx = chunkIdx % chunkCols;
        const cy = (chunkIdx - cx) / chunkCols;
        measureChunk(cx, cy, chunkIdx);
        if (built[chunkIdx] === 0) builtChunks.push(chunkIdx);
        built[chunkIdx] = 1;
        pending.add(chunkIdx);
      }
    },
    flush(): void {},
    settle(): void {},
    pendingCount(): number {
      return pending.size;
    },
    clear(): void {
      built.fill(0);
      builtChunks.length = 0;
      nearChunks.length = 0;
      pending.clear();
      overlayByChunk.clear();
      for (const level of levels) {
        level.visible = 0;
        level.geometry.instanceCount = 0;
      }
      for (const overlay of overlayClasses.values()) {
        overlay.visible = 0;
        overlay.geometry.instanceCount = 0;
      }
    },
    pickables(): Mesh[] {
      return [];
    },
    drawnGround(): DrawnGroundStore {
      return drawnGroundStore;
    },
    onChunkDrawn(handler: (chunkIdx: number) => void): () => void {
      drawnHandlers.add(handler);
      return () => drawnHandlers.delete(handler);
    },
    drawCallCount(): number {
      let calls = 0;
      for (const level of levels) if (level.visible > 0) calls++;
      for (const overlay of overlayClasses.values()) if (overlay.visible > 0) calls++;
      return calls;
    },
    medianSpliceMs(): number | null {
      return null;
    },
    arenaStats(): ArenaStats[] {
      return [];
    },
    arenaLayout(): ArenaLayout[] {
      return [];
    },
    builtChunkCount(): number {
      return builtChunks.length;
    },
    dispose(): void {
      for (const level of levels) {
        group.remove(level.mesh);
        level.geometry.dispose();
        level.material.dispose();
      }
      for (const overlay of overlayClasses.values()) {
        group.remove(overlay.mesh);
        overlay.geometry.dispose();
        overlay.material.dispose();
      }
      overlayClasses.clear();
      overlayByChunk.clear();
      height.dispose();
      columnSpans.dispose();
      palette.dispose();
      drawnHandlers.clear();
    },
  };
}
