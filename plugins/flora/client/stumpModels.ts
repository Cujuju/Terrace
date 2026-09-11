import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { weldFlatShaded } from '../../../client/src/render/weld.ts';
import { FLORA_STUMP_CAP, FLORA_STUMP_SCALE_MAX, STUMP_MAX_REACH_CELLS } from '../protocol.ts';
import {
  MATRIX_FLOATS_PER_INSTANCE,
  clearPlacementExtent,
  createPlacementExtent,
  geometryReach,
  includePlacement,
  scaledReach,
  uploadAllInstances,
  writeInstanceSphere,
  type InstanceReach,
} from './instanceBounds.ts';
import { TRUNK_BOTTOM_RADIUS, TRUNK_COLOR, TRUNK_HEIGHT } from './models.ts';

const STUMP_HEIGHT = TRUNK_HEIGHT / 3;

const SPLINTER_RISE = STUMP_HEIGHT / 4;

const STUMP_TOP_RADIUS_FRACTION = 0.92;

const STUMP_RADIAL_SEGMENTS = 7;

const CHAR_MIX = 0.78;

const CORE_COLOR = 0x8c7a63;

export interface StumpPlacement {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface StumpModels {
  readonly root: Group;
  apply(placements: readonly StumpPlacement[]): void;
  dispose(): void;
}

function triangleSoup(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return weldFlatShaded(geometry);
}

interface Rim {
  readonly cosines: number[];
  readonly sines: number[];
  readonly topY: number[];
}

function buildRim(): Rim {
  const cosines: number[] = [];
  const sines: number[] = [];
  const topY: number[] = [];
  for (let i = 0; i < STUMP_RADIAL_SEGMENTS; i++) {
    const angle = (i / STUMP_RADIAL_SEGMENTS) * Math.PI * 2;
    cosines.push(Math.cos(angle));
    sines.push(Math.sin(angle));
    topY.push(STUMP_HEIGHT + (i % 2 === 0 ? SPLINTER_RISE : 0));
  }
  return { cosines, sines, topY };
}

interface StumpGeometries {
  readonly bark: BufferGeometry;
  readonly core: BufferGeometry;
  readonly horizontalReachInCells: number;
}

function buildStump(): StumpGeometries {
  const rim = buildRim();
  const baseRadius = TRUNK_BOTTOM_RADIUS;
  const topRadius = TRUNK_BOTTOM_RADIUS * STUMP_TOP_RADIUS_FRACTION;

  const bark: number[] = [];
  const core: number[] = [];
  const push = (into: number[], ...points: Vector3[]): void => {
    for (const point of points) into.push(point.x, point.y, point.z);
  };

  const basePoint = (i: number): Vector3 =>
    new Vector3(rim.cosines[i]! * baseRadius, 0, rim.sines[i]! * baseRadius);
  const topPoint = (i: number): Vector3 =>
    new Vector3(rim.cosines[i]! * topRadius, rim.topY[i]!, rim.sines[i]! * topRadius);

  for (let i = 0; i < STUMP_RADIAL_SEGMENTS; i++) {
    const j = (i + 1) % STUMP_RADIAL_SEGMENTS;
    const a = basePoint(i);
    const b = basePoint(j);
    const c = topPoint(i);
    const d = topPoint(j);
    push(bark, a, c, b);
    push(bark, b, c, d);
  }

  const centre = new Vector3(0, STUMP_HEIGHT, 0);
  for (let i = 0; i < STUMP_RADIAL_SEGMENTS; i++) {
    const j = (i + 1) % STUMP_RADIAL_SEGMENTS;
    push(core, centre, topPoint(j), topPoint(i));
  }

  return {
    bark: triangleSoup(bark),
    core: triangleSoup(core),
    horizontalReachInCells: baseRadius / CELL_WORLD_SIZE,
  };
}

function assertStumpFitsCell(horizontalReachInCells: number): void {
  const worstInCells = horizontalReachInCells * FLORA_STUMP_SCALE_MAX;
  if (worstInCells > STUMP_MAX_REACH_CELLS) {
    throw new RangeError(
      `a stump reaches ${worstInCells.toFixed(3)} cells from its centre, past the ${STUMP_MAX_REACH_CELLS} its cell guarantees`,
    );
  }
}

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true });
}

function charred(): number {
  return new Color(TRUNK_COLOR).multiplyScalar(1 - CHAR_MIX).getHex();
}

export function createStumpModels(): StumpModels {
  const built = buildStump();
  assertStumpFitsCell(built.horizontalReachInCells);

  const barkMaterial = lambert(charred());
  const coreMaterial = lambert(CORE_COLOR);
  const bark = new InstancedMesh(built.bark, barkMaterial, FLORA_STUMP_CAP);
  const core = new InstancedMesh(built.core, coreMaterial, FLORA_STUMP_CAP);
  bark.name = 'flora:stump-bark';
  core.name = 'flora:stump-core';
  bark.count = 0;
  core.count = 0;

  const root = new Group();
  root.name = 'flora:stumps';
  root.add(bark);
  root.add(core);

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const up = new Vector3(0, 1, 0);

  const extent = createPlacementExtent();
  const reaches: readonly InstanceReach[] = [built.bark, built.core].map(
    (geometry): InstanceReach => scaledReach(geometryReach(geometry), FLORA_STUMP_SCALE_MAX),
  );

  return {
    root,

    apply(placements: readonly StumpPlacement[]): void {
      let written = 0;
      clearPlacementExtent(extent);
      for (const placement of placements) {
        if (written >= FLORA_STUMP_CAP) break;
        includePlacement(extent, placement.x, placement.groundY, placement.z);
        position.set(placement.x, placement.groundY, placement.z);
        rotation.setFromAxisAngle(up, placement.yaw);
        scale.set(placement.scale, placement.scale, placement.scale);
        matrix.compose(position, rotation, scale);
        bark.setMatrixAt(written, matrix);
        core.setMatrixAt(written++, matrix);
      }

      bark.count = written;
      core.count = written;
      const meshes = [bark, core];
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
        writeInstanceSphere(mesh, extent, reaches[i]!);
      }
    },

    dispose(): void {
      bark.dispose();
      core.dispose();
      built.bark.dispose();
      built.core.dispose();
      barkMaterial.dispose();
      coreMaterial.dispose();
      root.clear();
    },
  };
}
