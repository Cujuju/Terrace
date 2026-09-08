import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { FLORA_TREE_CAP, FLORA_TREE_SCALE_MAX, type FloraTreeKind } from '../protocol.ts';
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

export const TRUNK_HEIGHT = 0.45;
const TRUNK_TOP_RADIUS = 0.055;
export const TRUNK_BOTTOM_RADIUS = 0.085;
const TRUNK_SEGMENTS = 5;

export const CONIFER_CROWN_RADIUS = 0.38;
export const CONIFER_CROWN_HEIGHT = 1.05;
export const CONIFER_CROWN_SEGMENTS = 6;

export const BROADLEAF_CROWN_RADIUS = 0.46;
export const BROADLEAF_CROWN_SEGMENTS = 6;
const BROADLEAF_CROWN_RINGS = 4;

const BROADLEAF_CROWN_TRUNK_OVERLAP = 0.95;

const CONIFER_CROWN_CENTRE_Y = TRUNK_HEIGHT + CONIFER_CROWN_HEIGHT / 2;
export const BROADLEAF_CROWN_CENTRE_Y = TRUNK_HEIGHT + BROADLEAF_CROWN_RADIUS * BROADLEAF_CROWN_TRUNK_OVERLAP;

export const TRUNK_COLOR = 0x5a4632;
const CONIFER_CROWN_COLOR = 0x24503a;
const BROADLEAF_CROWN_COLOR = 0x3d6b2c;

export interface TreePlacement {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly kind: FloraTreeKind;
  readonly scale: number;
  readonly yaw: number;
}

export interface FloraModels {
  readonly root: Group;
  apply(placements: readonly TreePlacement[]): void;
  dispose(): void;
}

const UP = new Vector3(0, 1, 0);

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true });
}

export function createFloraModels(): FloraModels {
  const trunkGeometry = new CylinderGeometry(
    TRUNK_TOP_RADIUS,
    TRUNK_BOTTOM_RADIUS,
    TRUNK_HEIGHT,
    TRUNK_SEGMENTS,
  );
  trunkGeometry.translate(0, TRUNK_HEIGHT / 2, 0);

  const coniferGeometry = new ConeGeometry(
    CONIFER_CROWN_RADIUS,
    CONIFER_CROWN_HEIGHT,
    CONIFER_CROWN_SEGMENTS,
  );
  coniferGeometry.translate(0, CONIFER_CROWN_CENTRE_Y, 0);

  const broadleafGeometry = new SphereGeometry(
    BROADLEAF_CROWN_RADIUS,
    BROADLEAF_CROWN_SEGMENTS,
    BROADLEAF_CROWN_RINGS,
  );
  broadleafGeometry.translate(0, BROADLEAF_CROWN_CENTRE_Y, 0);

  const geometries: BufferGeometry[] = [trunkGeometry, coniferGeometry, broadleafGeometry];
  const materials: Material[] = [
    lambert(TRUNK_COLOR),
    lambert(CONIFER_CROWN_COLOR),
    lambert(BROADLEAF_CROWN_COLOR),
  ];

  const trunks = new InstancedMesh(trunkGeometry, materials[0], FLORA_TREE_CAP);
  const conifers = new InstancedMesh(coniferGeometry, materials[1], FLORA_TREE_CAP);
  const broadleaves = new InstancedMesh(broadleafGeometry, materials[2], FLORA_TREE_CAP);

  const meshes = [trunks, conifers, broadleaves];
  trunks.name = 'flora:trunks';
  conifers.name = 'flora:conifers';
  broadleaves.name = 'flora:broadleaves';

  const root = new Group();
  root.name = 'flora:trees';
  for (const mesh of meshes) {
    mesh.count = 0;
    root.add(mesh);
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  const extents = [createPlacementExtent(), createPlacementExtent(), createPlacementExtent()];
  const reaches: InstanceReach[] = geometries.map(
    (geometry): InstanceReach => scaledReach(geometryReach(geometry), FLORA_TREE_SCALE_MAX),
  );

  return {
    root,

    apply(placements: readonly TreePlacement[]): void {
      let trunkCount = 0;
      let coniferCount = 0;
      let broadleafCount = 0;
      for (const extent of extents) clearPlacementExtent(extent);

      for (const placement of placements) {
        if (trunkCount >= FLORA_TREE_CAP) break;

        position.set(placement.x, placement.groundY, placement.z);
        rotation.setFromAxisAngle(UP, placement.yaw);
        scale.setScalar(placement.scale);
        matrix.compose(position, rotation, scale);

        trunks.setMatrixAt(trunkCount++, matrix);
        includePlacement(extents[0]!, placement.x, placement.groundY, placement.z);
        if (placement.kind === 'conifer') {
          conifers.setMatrixAt(coniferCount++, matrix);
          includePlacement(extents[1]!, placement.x, placement.groundY, placement.z);
        } else {
          broadleaves.setMatrixAt(broadleafCount++, matrix);
          includePlacement(extents[2]!, placement.x, placement.groundY, placement.z);
        }
      }

      trunks.count = trunkCount;
      conifers.count = coniferCount;
      broadleaves.count = broadleafCount;

      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
        writeInstanceSphere(mesh, extents[i]!, reaches[i]!);
      }
    },

    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}
