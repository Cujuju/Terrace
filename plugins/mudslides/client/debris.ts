import {
  Color,
  DodecahedronGeometry,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';
import { BAND_HEIGHT, CELL_WORLD_SIZE } from '@terrace/shared';
import { MAX_ACTIVE_SLIDES } from '../protocol.ts';

const CLUMP_RADIUS_WORLD_UNITS = 0.12;

const CLUMP_DETAIL = 0;

const MUD_COLOR = 0x4a3a2a;

const DEBRIS_COLOR = 0x6b5740;

const CLUMPS_PER_FRONT_CELL = 6;

const FRONT_TAIL_CELLS = 12;

const MAX_FRONT_INSTANCES = MAX_ACTIVE_SLIDES * FRONT_TAIL_CELLS * CLUMPS_PER_FRONT_CELL;
const MAX_DEBRIS_INSTANCES = 1024;

const CLUMP_JITTER_WORLD_UNITS = 0.22;

const CLUMP_SINK_FRACTION = 0.4;

const CLUMP_FLATTEN = 0.45;

function jitter(x: number, y: number, index: number): { dx: number; dz: number } {
  let h = (x * 0x1f1f1f1f) ^ (y * 0x27d4eb2d) ^ (index * 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  const a = ((h ^ (h >>> 14)) >>> 0) / 0x100000000;
  const b = ((Math.imul(h, 0x9e3779b1) ^ (h >>> 9)) >>> 0) / 0x100000000;
  return {
    dx: (a - 0.5) * 2 * CLUMP_JITTER_WORLD_UNITS,
    dz: (b - 0.5) * 2 * CLUMP_JITTER_WORLD_UNITS,
  };
}

export interface Clump {
  readonly cellX: number;
  readonly cellY: number;
  readonly index: number;
  readonly scale: number;
}

export type GroundAt = (cellX: number, cellY: number) => number | null;

export interface ClumpField {
  readonly mesh: InstancedMesh;
  apply(clumps: readonly Clump[], groundAt: GroundAt): void;
  dispose(): void;
}

function createClumpField(color: number, capacity: number): ClumpField {
  const geometry: BufferGeometry = new DodecahedronGeometry(
    CLUMP_RADIUS_WORLD_UNITS,
    CLUMP_DETAIL,
  );
  const material: Material = new MeshLambertMaterial({ color: new Color(color) });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const scratch = new Object3D();

  return {
    mesh,
    apply(clumps: readonly Clump[], groundAt: GroundAt): void {
      if (clumps.length === 0 && mesh.count === 0) return;
      let drawn = 0;
      for (const clump of clumps) {
        if (drawn >= capacity) break;
        const groundY = groundAt(clump.cellX, clump.cellY);
        if (groundY === null) continue;

        const offset = jitter(clump.cellX, clump.cellY, clump.index);
        scratch.position.set(
          (clump.cellX + 0.5) * CELL_WORLD_SIZE + offset.dx,
          groundY - CLUMP_RADIUS_WORLD_UNITS * clump.scale * CLUMP_SINK_FRACTION,
          (clump.cellY + 0.5) * CELL_WORLD_SIZE + offset.dz,
        );
        scratch.rotation.set(offset.dx * Math.PI, offset.dz * Math.PI, 0);
        scratch.scale.set(clump.scale, clump.scale * CLUMP_FLATTEN, clump.scale);
        scratch.updateMatrix();
        mesh.setMatrixAt(drawn, scratch.matrix);
        drawn++;
      }
      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}

export function createFrontField(): ClumpField {
  return createClumpField(MUD_COLOR, MAX_FRONT_INSTANCES);
}

export function createDebrisField(): ClumpField {
  return createClumpField(DEBRIS_COLOR, MAX_DEBRIS_INSTANCES);
}

export { FRONT_TAIL_CELLS, CLUMPS_PER_FRONT_CELL, MAX_DEBRIS_INSTANCES };

const DEBRIS_MIN_SCALE = 0.6;
const DEBRIS_MAX_SCALE = 0.95;

export function debrisClumps(x: number, y: number, depthHeightUnits: number): Clump[] {
  const bands = Math.max(1, Math.round(depthHeightUnits / BAND_HEIGHT));
  const count = Math.min(CLUMPS_PER_FRONT_CELL, bands);
  const clumps: Clump[] = [];
  for (let index = 0; index < count; index++) {
    const t = count === 1 ? 0 : index / (count - 1);
    clumps.push({
      cellX: x,
      cellY: y,
      index,
      scale: DEBRIS_MIN_SCALE + t * (DEBRIS_MAX_SCALE - DEBRIS_MIN_SCALE),
    });
  }
  return clumps;
}
