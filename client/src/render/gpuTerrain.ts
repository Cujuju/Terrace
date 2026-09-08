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
  drawnGroundLodError,
} from '@terrace/shared';
import { CHUNK_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { RENDER_HALO_CELLS, type TerrainMirror } from '../terrain/mirror.ts';
import { createDrawnGroundStore, type DrawnGroundStore } from '../terrain/drawnGroundStore.ts';
import type { ArenaLayout, ArenaStats, TerrainMeshes } from './terrainMeshes.ts';
import { createBandPaletteTexture, createHeightTexture } from './gpuTerrainTextures.ts';
import { createChunkTemplate, createGpuTerrainMaterial } from './gpuTerrainMaterial.ts';

export const GPU_TERRAIN_SMOOTH_DEFAULT = true;

/** The bilinear blend floors to a band, so a chunk can drop one band below its cells. */
const CHUNK_BOUND_SLACK_HEIGHT = BAND_HEIGHT;

const INSTANCE_COMPONENTS = 2;

interface LodLevel {
  readonly mesh: Mesh;
  readonly geometry: InstancedBufferGeometry;
  readonly material: MeshLambertMaterial;
  readonly origins: InstancedBufferAttribute;
  visible: number;
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
    uSubdiv: { value: subdivision },
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
  const palette = createBandPaletteTexture();
  const smooth: IUniform<number> = { value: GPU_TERRAIN_SMOOTH_DEFAULT ? 1 : 0 };
  const shared: Record<string, IUniform> = {
    uHeight: { value: height.texture },
    uPalette: { value: palette },
    uSizeCells: { value: map.size },
    uSmooth: smooth,
  };

  const near = createLevel(TERRAIN_LOD_NEAR_N, chunkCount, shared, 0);
  const far = createLevel(TERRAIN_LOD_FAR_N, chunkCount, shared, 1);
  const levels = [near, far];

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
      for (const handler of drawnHandlers) handler(chunkIdx);
    }
    pending.clear();
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
      const level =
        error * error > errorPerDistanceSq * (dx * dx + dy * dy + dz * dz) ? near : far;
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
      pending.clear();
      for (const level of levels) {
        level.visible = 0;
        level.geometry.instanceCount = 0;
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
      return levels.reduce((total, level) => total + (level.visible > 0 ? 1 : 0), 0);
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
      height.dispose();
      palette.dispose();
      drawnHandlers.clear();
    },
  };
}
