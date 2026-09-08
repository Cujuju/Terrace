import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import { CHUNK_SIZE, SEA_LEVEL, chunksPerEdge } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, WORLD_UNIT_HEIGHT_UNITS } from '../config.ts';
import {
  frontierEdgeKey,
  frontierEdgeSampling,
  frontierEdges,
  type FrontierEdge,
} from '../terrain/frontier.ts';
import { sampleHeight, type TerrainMirror } from '../terrain/mirror.ts';
import { SUPER_MESH_SPAN_CHUNKS } from './terrainMeshes.ts';
import { WATER_COLOR } from './water.ts';

const FOG_BANK_RISE = WORLD_UNIT_HEIGHT_UNITS * 1.25;

const FOG_BANK_KNEE = 0.45;

const FOG_BASE_DROP = WORLD_UNIT_HEIGHT_UNITS / 2;

const FOG_PLATEAU_ALPHA = 0.3;

const FOG_ROW_COUNT = 3;

const FOG_ROW_ALPHA: readonly number[] = [1, 1, 0];

const FOG_COLUMNS = CHUNK_SIZE + 1;

function fogRowColors(): readonly Color[] {
  const water = new Color(WATER_COLOR);
  const rows: Color[] = [];
  for (let r = 0; r < FOG_ROW_COUNT; r++) {
    rows.push(water.clone());
  }
  return rows;
}

const FOG_BREATH_PERIOD_S = 9;

const FOG_BREATH_AMPLITUDE_FRACTION = 0.15;

const FOG_BREATH_ANGULAR_FREQUENCY = (2 * Math.PI) / FOG_BREATH_PERIOD_S;

export const VERTICES_PER_SEGMENT = FOG_ROW_COUNT * FOG_COLUMNS;
const POSITION_COMPONENTS_PER_VERTEX = 3;
const COLOR_COMPONENTS_PER_VERTEX = 4;

export const INDICES_PER_SEGMENT = (FOG_ROW_COUNT - 1) * (FOG_COLUMNS - 1) * 6;

function writeSegmentArrays(
  mirror: TerrainMirror,
  edge: FrontierEdge,
  positions: Float32Array,
  colors: Float32Array,
  firstVertex: number,
): void {
  const s = frontierEdgeSampling(edge);
  const rowColors = fogRowColors();

  const cellHeights: number[] = [];
  const cellDry: boolean[] = [];
  for (let t = 0; t < CHUNK_SIZE; t++) {
    const h = sampleHeight(mirror, s.cellX + t * s.cellStepX, s.cellY + t * s.cellStepY);
    const dry = h > SEA_LEVEL;
    cellDry.push(dry);
    cellHeights.push(dry ? h : SEA_LEVEL);
  }
  const baseY = (SEA_LEVEL - FOG_BASE_DROP) * HEIGHT_WORLD_SCALE;

  let p = firstVertex * POSITION_COMPONENTS_PER_VERTEX;
  let c = firstVertex * COLOR_COMPONENTS_PER_VERTEX;
  for (let r = 0; r < FOG_ROW_COUNT; r++) {
    const alpha = FOG_ROW_ALPHA[r];
    const color = rowColors[r];
    for (let k = 0; k < FOG_COLUMNS; k++) {
      const leftCell = k - 1 < 0 ? 0 : k - 1;
      const rightCell = k >= CHUNK_SIZE ? CHUNK_SIZE - 1 : k;
      const left = cellHeights[leftCell];
      const right = cellHeights[rightCell];
      const ground = left > right ? left : right;
      const dry = cellDry[leftCell]! || cellDry[rightCell]!;
      const rise =
        !dry || r === 0 ? 0 : r === 1 ? FOG_BANK_RISE * FOG_BANK_KNEE : FOG_BANK_RISE;
      const y = r === 0 ? baseY : (ground + rise) * HEIGHT_WORLD_SCALE;
      positions[p++] = (s.lineX + k * s.lineStepX) * CELL_WORLD_SIZE;
      positions[p++] = y;
      positions[p++] = (s.lineZ + k * s.lineStepZ) * CELL_WORLD_SIZE;
      colors[c++] = color.r;
      colors[c++] = color.g;
      colors[c++] = color.b;
      colors[c++] = alpha;
    }
  }
}

const SEGMENT_INDEX_TEMPLATE: readonly number[] = (() => {
  const indices: number[] = [];
  for (let r = 0; r < FOG_ROW_COUNT - 1; r++) {
    for (let k = 0; k < FOG_COLUMNS - 1; k++) {
      const a = r * FOG_COLUMNS + k;
      const b = a + 1;
      const nextA = a + FOG_COLUMNS;
      const nextB = b + FOG_COLUMNS;
      indices.push(a, b, nextA, b, nextB, nextA);
    }
  }
  return indices;
})();

const INITIAL_SEGMENT_CAPACITY = 8;

interface FogSegment {
  edge: FrontierEdge;
  chunkIdx: number;
  superIdx: number;
  slot: number;
}

interface FogSuperMesh {
  mesh: Mesh;
  positions: Float32Array;
  colors: Float32Array;
  positionAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
  occupants: FogSegment[];
  segmentCapacity: number;
}

export type FrontierMistMode = 'off' | 'line' | 'waterline';

export interface FrontierFog {
  setMode(mode: FrontierMistMode): void;
  sync(mirror: TerrainMirror): void;
  refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void;
  segmentCount(): number;
  drawCallCount(): number;
  dispose(): void;
}

export function createFrontierFog(
  parent: Object3D,
  onFrame: (handler: (dt: number) => void) => () => void,
): FrontierFog {
  const group = new Group();
  group.visible = false;
  parent.add(group);

  const material = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });

  const segments = new Map<string, FogSegment>();
  const superMeshes = new Map<number, FogSuperMesh>();
  const dirtySupers = new Set<FogSuperMesh>();

  let elapsedS = 0;
  const stopAnimating = onFrame((dt: number) => {
    elapsedS += dt;
    const breathe =
      1 + FOG_BREATH_AMPLITUDE_FRACTION * Math.sin(elapsedS * FOG_BREATH_ANGULAR_FREQUENCY);
    material.opacity = FOG_PLATEAU_ALPHA * breathe;
  });

  const bindGeometry = (sm: FogSuperMesh): void => {
    const positionAttribute = new BufferAttribute(sm.positions, POSITION_COMPONENTS_PER_VERTEX);
    const colorAttribute = new BufferAttribute(sm.colors, COLOR_COMPONENTS_PER_VERTEX);

    const indices = new Uint32Array(sm.segmentCapacity * INDICES_PER_SEGMENT);
    for (let slot = 0; slot < sm.segmentCapacity; slot++) {
      const vertexBase = slot * VERTICES_PER_SEGMENT;
      const indexBase = slot * INDICES_PER_SEGMENT;
      for (let i = 0; i < INDICES_PER_SEGMENT; i++) {
        indices[indexBase + i] = SEGMENT_INDEX_TEMPLATE[i]! + vertexBase;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.setDrawRange(0, sm.occupants.length * INDICES_PER_SEGMENT);

    const previous = sm.mesh.geometry;
    sm.mesh.geometry = geometry;
    if (previous !== geometry) previous.dispose();

    sm.positionAttribute = positionAttribute;
    sm.colorAttribute = colorAttribute;
  };

  const ensureSegmentCapacity = (sm: FogSuperMesh, slots: number): void => {
    if (slots <= sm.segmentCapacity) return;
    let capacity = sm.segmentCapacity;
    while (capacity < slots) capacity *= 2;

    const positions = new Float32Array(capacity * VERTICES_PER_SEGMENT * POSITION_COMPONENTS_PER_VERTEX);
    const colors = new Float32Array(capacity * VERTICES_PER_SEGMENT * COLOR_COMPONENTS_PER_VERTEX);
    positions.set(sm.positions);
    colors.set(sm.colors);
    sm.positions = positions;
    sm.colors = colors;
    sm.segmentCapacity = capacity;
    bindGeometry(sm);
  };

  const createSuperMesh = (superIdx: number): FogSuperMesh => {
    const placeholder = new BufferAttribute(new Float32Array(0), POSITION_COMPONENTS_PER_VERTEX);
    const sm: FogSuperMesh = {
      mesh: new Mesh(new BufferGeometry(), material),
      positions: new Float32Array(
        INITIAL_SEGMENT_CAPACITY * VERTICES_PER_SEGMENT * POSITION_COMPONENTS_PER_VERTEX,
      ),
      colors: new Float32Array(
        INITIAL_SEGMENT_CAPACITY * VERTICES_PER_SEGMENT * COLOR_COMPONENTS_PER_VERTEX,
      ),
      positionAttribute: placeholder,
      colorAttribute: placeholder,
      occupants: [],
      segmentCapacity: INITIAL_SEGMENT_CAPACITY,
    };
    bindGeometry(sm);
    group.add(sm.mesh);
    superMeshes.set(superIdx, sm);
    return sm;
  };

  const recomputeBounds = (sm: FogSuperMesh): void => {
    const geometry = sm.mesh.geometry;
    const live = sm.occupants.length * VERTICES_PER_SEGMENT;
    if (live === 0) {
      geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 0);
      return;
    }
    const positions = sm.positions;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let v = 0; v < live; v++) {
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    let maxSquared = 0;
    for (let v = 0; v < live; v++) {
      const dx = positions[v * 3]! - centreX;
      const dy = positions[v * 3 + 1]! - centreY;
      const dz = positions[v * 3 + 2]! - centreZ;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared > maxSquared) maxSquared = squared;
    }
    geometry.boundingSphere = new Sphere(
      new Vector3(centreX, centreY, centreZ),
      Math.sqrt(maxSquared),
    );
  };

  const flush = (): void => {
    for (const sm of dirtySupers) {
      sm.positionAttribute.needsUpdate = true;
      sm.colorAttribute.needsUpdate = true;
      sm.mesh.geometry.setDrawRange(0, sm.occupants.length * INDICES_PER_SEGMENT);
      recomputeBounds(sm);
    }
    dirtySupers.clear();
  };

  const writeSlot = (mirror: TerrainMirror, sm: FogSuperMesh, segment: FogSegment): void => {
    writeSegmentArrays(
      mirror,
      segment.edge,
      sm.positions,
      sm.colors,
      segment.slot * VERTICES_PER_SEGMENT,
    );
    dirtySupers.add(sm);
  };

  const addSegment = (mirror: TerrainMirror, segment: FogSegment): void => {
    const sm = superMeshes.get(segment.superIdx) ?? createSuperMesh(segment.superIdx);
    ensureSegmentCapacity(sm, sm.occupants.length + 1);
    segment.slot = sm.occupants.length;
    sm.occupants.push(segment);
    writeSlot(mirror, sm, segment);
  };

  const removeSegment = (segment: FogSegment): void => {
    const sm = superMeshes.get(segment.superIdx);
    if (sm === undefined) return;
    const last = sm.occupants.length - 1;
    if (segment.slot !== last) {
      const moved = sm.occupants[last]!;
      const from = last * VERTICES_PER_SEGMENT;
      const to = segment.slot * VERTICES_PER_SEGMENT;
      sm.positions.copyWithin(
        to * POSITION_COMPONENTS_PER_VERTEX,
        from * POSITION_COMPONENTS_PER_VERTEX,
        (from + VERTICES_PER_SEGMENT) * POSITION_COMPONENTS_PER_VERTEX,
      );
      sm.colors.copyWithin(
        to * COLOR_COMPONENTS_PER_VERTEX,
        from * COLOR_COMPONENTS_PER_VERTEX,
        (from + VERTICES_PER_SEGMENT) * COLOR_COMPONENTS_PER_VERTEX,
      );
      moved.slot = segment.slot;
      sm.occupants[segment.slot] = moved;
    }
    sm.occupants.pop();

    if (sm.occupants.length === 0) {
      group.remove(sm.mesh);
      sm.mesh.geometry.dispose();
      superMeshes.delete(segment.superIdx);
      dirtySupers.delete(sm);
      return;
    }
    dirtySupers.add(sm);
  };

  return {
    setMode(mode: FrontierMistMode): void {
      group.visible = mode !== 'off';
    },

    sync(mirror: TerrainMirror): void {
      const chunkCols = chunksPerEdge(mirror.map.size);
      const superCols = Math.ceil(chunkCols / SUPER_MESH_SPAN_CHUNKS);
      const nextEdges = frontierEdges(mirror.received, chunkCols);
      const nextKeys = new Set(nextEdges.map(frontierEdgeKey));

      for (const [key, segment] of segments) {
        if (nextKeys.has(key)) continue;
        removeSegment(segment);
        segments.delete(key);
      }

      for (const edge of nextEdges) {
        const key = frontierEdgeKey(edge);
        const existing = segments.get(key);
        if (existing !== undefined) {
          writeSlot(mirror, superMeshes.get(existing.superIdx)!, existing);
          continue;
        }
        const sx = Math.floor(edge.cx / SUPER_MESH_SPAN_CHUNKS);
        const sy = Math.floor(edge.cy / SUPER_MESH_SPAN_CHUNKS);
        const segment: FogSegment = {
          edge,
          chunkIdx: edge.cy * chunkCols + edge.cx,
          superIdx: sy * superCols + sx,
          slot: 0,
        };
        addSegment(mirror, segment);
        segments.set(key, segment);
      }

      flush();
    },

    refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void {
      if (dirtyChunks.size === 0) return;
      for (const segment of segments.values()) {
        if (!dirtyChunks.has(segment.chunkIdx)) continue;
        writeSlot(mirror, superMeshes.get(segment.superIdx)!, segment);
      }
      flush();
    },

    segmentCount(): number {
      return segments.size;
    },

    drawCallCount(): number {
      return superMeshes.size;
    },

    dispose(): void {
      stopAnimating();
      for (const sm of superMeshes.values()) {
        group.remove(sm.mesh);
        sm.mesh.geometry.dispose();
      }
      superMeshes.clear();
      segments.clear();
      dirtySupers.clear();
      parent.remove(group);
      material.dispose();
    },
  };
}
