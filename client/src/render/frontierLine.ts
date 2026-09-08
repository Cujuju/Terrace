import {
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  Sphere,
  Vector3,
  type Object3D,
} from 'three';
import { CHUNK_SIZE, SEA_LEVEL, chunksPerEdge } from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE, WORLD_UNIT_HEIGHT_UNITS } from '../config.ts';
import {
  frontierEdgeCellGround,
  frontierEdgeSampling,
  frontierEdges,
  neighbourChunkIndex,
  type FrontierEdge,
} from '../terrain/frontier.ts';
import { type TerrainMirror } from '../terrain/mirror.ts';

const FRONTIER_LINE_COLOR = 0xe03127;

const FRONTIER_LINE_LIFT = WORLD_UNIT_HEIGHT_UNITS / 8;

const POINTS_PER_EDGE = CHUNK_SIZE + 1;

const VERTICES_PER_EDGE = (POINTS_PER_EDGE - 1) * 2;
const POSITION_COMPONENTS_PER_VERTEX = 3;

const INITIAL_EDGE_CAPACITY = 64;

export interface FrontierLine {
  setVisible(visible: boolean): void;
  sync(mirror: TerrainMirror): void;
  refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void;
  edgeCount(): number;
  drawCallCount(): number;
  dispose(): void;
}

export function createFrontierLine(parent: Object3D): FrontierLine {
  const material = new LineBasicMaterial({ color: new Color(FRONTIER_LINE_COLOR) });
  let capacity = INITIAL_EDGE_CAPACITY;
  let positions = new Float32Array(capacity * VERTICES_PER_EDGE * POSITION_COMPONENTS_PER_VERTEX);
  let attribute = new BufferAttribute(positions, POSITION_COMPONENTS_PER_VERTEX);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', attribute);
  geometry.setDrawRange(0, 0);
  geometry.boundingSphere = new Sphere(new Vector3(), 0);

  const line = new LineSegments(geometry, material);
  line.frustumCulled = false;
  line.visible = false;
  parent.add(line);

  let drawnEdges: FrontierEdge[] = [];

  const grow = (edges: number): void => {
    if (edges <= capacity) return;
    while (capacity < edges) capacity *= 2;
    positions = new Float32Array(capacity * VERTICES_PER_EDGE * POSITION_COMPONENTS_PER_VERTEX);
    attribute = new BufferAttribute(positions, POSITION_COMPONENTS_PER_VERTEX);
    geometry.setAttribute('position', attribute);
  };

  const groundAt = (mirror: TerrainMirror, edge: FrontierEdge, k: number): number => {
    const s = frontierEdgeSampling(edge);
    const left = k - 1 < 0 ? 0 : k - 1;
    const right = k >= CHUNK_SIZE ? CHUNK_SIZE - 1 : k;
    const a = frontierEdgeCellGround(mirror, s, left);
    const b = frontierEdgeCellGround(mirror, s, right);
    const higher = a > b ? a : b;
    return higher > SEA_LEVEL ? higher : SEA_LEVEL;
  };

  const write = (mirror: TerrainMirror): void => {
    grow(drawnEdges.length);

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let p = 0;

    for (const edge of drawnEdges) {
      const s = frontierEdgeSampling(edge);
      let prevX = 0;
      let prevY = 0;
      let prevZ = 0;
      for (let k = 0; k < POINTS_PER_EDGE; k++) {
        const x = (s.lineX + k * s.lineStepX) * CELL_WORLD_SIZE;
        const y = (groundAt(mirror, edge, k) + FRONTIER_LINE_LIFT) * HEIGHT_WORLD_SCALE;
        const z = (s.lineZ + k * s.lineStepZ) * CELL_WORLD_SIZE;
        if (k > 0) {
          positions[p++] = prevX;
          positions[p++] = prevY;
          positions[p++] = prevZ;
          positions[p++] = x;
          positions[p++] = y;
          positions[p++] = z;
        }
        prevX = x;
        prevY = y;
        prevZ = z;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }

    attribute.needsUpdate = true;
    geometry.setDrawRange(0, drawnEdges.length * VERTICES_PER_EDGE);
    const sphere = geometry.boundingSphere ?? new Sphere();
    if (drawnEdges.length === 0) {
      sphere.center.set(0, 0, 0);
      sphere.radius = 0;
    } else {
      sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      sphere.radius = sphere.center.distanceTo(new Vector3(maxX, maxY, maxZ));
    }
    geometry.boundingSphere = sphere;
  };

  return {
    setVisible(visible: boolean): void {
      line.visible = visible;
    },

    sync(mirror: TerrainMirror): void {
      const cols = chunksPerEdge(mirror.map.size);
      drawnEdges = frontierEdges(mirror.received, cols).filter(
        (edge) => neighbourChunkIndex(edge, cols) !== null,
      );
      write(mirror);
    },

    refresh(mirror: TerrainMirror, dirtyChunks: ReadonlySet<number>): void {
      if (drawnEdges.length === 0 || dirtyChunks.size === 0) return;
      const cols = chunksPerEdge(mirror.map.size);
      const touched = drawnEdges.some((edge) => dirtyChunks.has(edge.cy * cols + edge.cx));
      if (!touched) return;
      write(mirror);
    },

    edgeCount(): number {
      return drawnEdges.length;
    },

    drawCallCount(): number {
      return drawnEdges.length === 0 ? 0 : 1;
    },

    dispose(): void {
      parent.remove(line);
      geometry.dispose();
      material.dispose();
      drawnEdges = [];
    },
  };
}
