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
  type BufferAttribute,
  type BufferGeometry,
  type Material,
} from 'three';
import { FLORA_TREE_CAP, FLORA_TREE_SCALE_MAX, treeKey, type FloraTreeKind, type TreeCell } from '../protocol.ts';
import { bakeSolidColor } from '../../../client/src/render/bakeSolidColor.ts';
import {
  MATRIX_FLOATS_PER_INSTANCE,
  clearPlacementExtent,
  createPlacementExtent,
  geometryReach,
  includePlacement,
  scaledReach,
  uploadAllInstances,
  uploadInstanceRun,
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

export const PINE_CROWN_RADIUS = 0.3;
export const PINE_CROWN_HEIGHT = 1.3;
export const PINE_CROWN_SEGMENTS = 6;

export const BROADLEAF_CROWN_RADIUS = 0.46;
export const BROADLEAF_CROWN_SEGMENTS = 6;
const BROADLEAF_CROWN_RINGS = 4;

const BROADLEAF_CROWN_TRUNK_OVERLAP = 0.95;

const CONIFER_CROWN_CENTRE_Y = TRUNK_HEIGHT + CONIFER_CROWN_HEIGHT / 2;
export const PINE_CROWN_CENTRE_Y = TRUNK_HEIGHT + PINE_CROWN_HEIGHT / 2;
export const BROADLEAF_CROWN_CENTRE_Y = TRUNK_HEIGHT + BROADLEAF_CROWN_RADIUS * BROADLEAF_CROWN_TRUNK_OVERLAP;

export const TRUNK_COLOR = 0x5a4632;
const CONIFER_CROWN_COLOR = 0x24503a;
const PINE_CROWN_COLOR = 0x1f5140;
const BROADLEAF_CROWN_COLOR = 0x3d6b2c;

export interface TreePlacement {
  readonly x: number;
  readonly z: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly kind: FloraTreeKind;
  readonly scale: number;
  readonly yaw: number;
}

export interface FloraModels {
  readonly root: Group;
  apply(placements: readonly TreePlacement[]): void;
  applyDelta(sprouted: readonly TreePlacement[], felled: readonly TreeCell[]): void;
  dispose(): void;
}

const UP = new Vector3(0, 1, 0);

function lambert(): MeshLambertMaterial {
  return new MeshLambertMaterial({ vertexColors: true, flatShading: true });
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

  const pineGeometry = new ConeGeometry(
    PINE_CROWN_RADIUS,
    PINE_CROWN_HEIGHT,
    PINE_CROWN_SEGMENTS,
  );
  pineGeometry.translate(0, PINE_CROWN_CENTRE_Y, 0);

  const broadleafGeometry = new SphereGeometry(
    BROADLEAF_CROWN_RADIUS,
    BROADLEAF_CROWN_SEGMENTS,
    BROADLEAF_CROWN_RINGS,
  );
  broadleafGeometry.translate(0, BROADLEAF_CROWN_CENTRE_Y, 0);

  const geometries: BufferGeometry[] = [trunkGeometry, coniferGeometry, pineGeometry, broadleafGeometry];
  bakeSolidColor(trunkGeometry, TRUNK_COLOR);
  bakeSolidColor(coniferGeometry, CONIFER_CROWN_COLOR);
  bakeSolidColor(pineGeometry, PINE_CROWN_COLOR);
  bakeSolidColor(broadleafGeometry, BROADLEAF_CROWN_COLOR);
  const sharedMaterial = lambert();
  const materials: Material[] = [sharedMaterial, sharedMaterial, sharedMaterial, sharedMaterial];

  const trunks = new InstancedMesh(trunkGeometry, materials[0], FLORA_TREE_CAP);
  const conifers = new InstancedMesh(coniferGeometry, materials[1], FLORA_TREE_CAP);
  const pines = new InstancedMesh(pineGeometry, materials[2], FLORA_TREE_CAP);
  const broadleaves = new InstancedMesh(broadleafGeometry, materials[3], FLORA_TREE_CAP);

  const meshes = [trunks, conifers, pines, broadleaves];
  trunks.name = 'flora:trunks';
  conifers.name = 'flora:conifers';
  pines.name = 'flora:pines';
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

  const extents = geometries.map(() => createPlacementExtent());
  const reaches: InstanceReach[] = geometries.map(
    (geometry): InstanceReach => scaledReach(geometryReach(geometry), FLORA_TREE_SCALE_MAX),
  );

  const kindMeshIndex = (kind: FloraTreeKind): number =>
    kind === 'conifer' ? 1 : kind === 'pine' ? 2 : 3;

  const trunkOfCell = new Map<number, number>();
  const cellOfTrunk: number[] = [];
  const kindOfTrunk: FloraTreeKind[] = [];
  const kindSlotOfTrunk: number[] = [];
  const cellOfKindSlot: Record<FloraTreeKind, number[]> = {
    conifer: [],
    pine: [],
    broadleaf: [],
  };
  const kindCounts: Record<FloraTreeKind, number> = { conifer: 0, pine: 0, broadleaf: 0 };
  let trunkCount = 0;

  const moveInstances = (
    attribute: BufferAttribute,
    from: number,
    to: number,
    count: number,
  ): void => {
    attribute.array.copyWithin(
      to * MATRIX_FLOATS_PER_INSTANCE,
      from * MATRIX_FLOATS_PER_INSTANCE,
      (from + count) * MATRIX_FLOATS_PER_INSTANCE,
    );
  };

  const insertCell = (key: number, placement: TreePlacement): boolean => {
    if (trunkCount >= FLORA_TREE_CAP) return false;
    const kind = placement.kind;
    const trunkSlot = trunkCount++;
    const kindSlot = kindCounts[kind]!++;

    position.set(placement.x, placement.groundY, placement.z);
    rotation.setFromAxisAngle(UP, placement.yaw);
    scale.setScalar(placement.scale);
    matrix.compose(position, rotation, scale);
    trunks.setMatrixAt(trunkSlot, matrix);
    meshes[kindMeshIndex(kind)]!.setMatrixAt(kindSlot, matrix);
    includePlacement(extents[0]!, placement.x, placement.groundY, placement.z);
    includePlacement(extents[kindMeshIndex(kind)]!, placement.x, placement.groundY, placement.z);

    trunkOfCell.set(key, trunkSlot);
    cellOfTrunk[trunkSlot] = key;
    kindOfTrunk[trunkSlot] = kind;
    kindSlotOfTrunk[trunkSlot] = kindSlot;
    cellOfKindSlot[kind][kindSlot] = key;
    return true;
  };

  const removeCell = (key: number): void => {
    const trunkSlot = trunkOfCell.get(key);
    if (trunkSlot === undefined) return;
    trunkOfCell.delete(key);

    const kind = kindOfTrunk[trunkSlot]!;
    const kindSlot = kindSlotOfTrunk[trunkSlot]!;
    const kindMesh = meshes[kindMeshIndex(kind)]!;

    const kindLast = kindCounts[kind]! - 1;
    if (kindSlot !== kindLast) {
      moveInstances(kindMesh.instanceMatrix, kindLast, kindSlot, 1);
      const movedKey = cellOfKindSlot[kind][kindLast]!;
      cellOfKindSlot[kind][kindSlot] = movedKey;
      kindSlotOfTrunk[trunkOfCell.get(movedKey)!] = kindSlot;
      uploadInstanceRun(kindMesh.instanceMatrix, kindSlot, 1, MATRIX_FLOATS_PER_INSTANCE);
    }
    kindCounts[kind] = kindLast;
    cellOfKindSlot[kind].length = kindLast;

    const trunkLast = trunkCount - 1;
    if (trunkSlot !== trunkLast) {
      moveInstances(trunks.instanceMatrix, trunkLast, trunkSlot, 1);
      const movedKey = cellOfTrunk[trunkLast]!;
      cellOfTrunk[trunkSlot] = movedKey;
      trunkOfCell.set(movedKey, trunkSlot);
      kindOfTrunk[trunkSlot] = kindOfTrunk[trunkLast]!;
      kindSlotOfTrunk[trunkSlot] = kindSlotOfTrunk[trunkLast]!;
      uploadInstanceRun(trunks.instanceMatrix, trunkSlot, 1, MATRIX_FLOATS_PER_INSTANCE);
    }
    trunkCount = trunkLast;
    cellOfTrunk.length = trunkLast;
    kindOfTrunk.length = trunkLast;
    kindSlotOfTrunk.length = trunkLast;
  };

  const publish = (): void => {
    trunks.count = trunkCount;
    conifers.count = kindCounts.conifer;
    pines.count = kindCounts.pine;
    broadleaves.count = kindCounts.broadleaf;
    for (let i = 0; i < meshes.length; i++) {
      writeInstanceSphere(meshes[i]!, extents[i]!, reaches[i]!);
    }
  };

  return {
    root,

    apply(placements: readonly TreePlacement[]): void {
      trunkOfCell.clear();
      cellOfTrunk.length = 0;
      kindOfTrunk.length = 0;
      kindSlotOfTrunk.length = 0;
      cellOfKindSlot.conifer.length = 0;
      cellOfKindSlot.pine.length = 0;
      cellOfKindSlot.broadleaf.length = 0;
      kindCounts.conifer = 0;
      kindCounts.pine = 0;
      kindCounts.broadleaf = 0;
      trunkCount = 0;
      for (const extent of extents) clearPlacementExtent(extent);

      for (const placement of placements) {
        if (!insertCell(treeKey(placement.cellX, placement.cellY), placement)) break;
      }

      publish();
      for (const mesh of meshes) {
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
      }
    },

    applyDelta(sprouted: readonly TreePlacement[], felled: readonly TreeCell[]): void {
      for (const cell of felled) removeCell(treeKey(cell.x, cell.y));
      for (const placement of sprouted) {
        const key = treeKey(placement.cellX, placement.cellY);
        if (trunkCount >= FLORA_TREE_CAP && !trunkOfCell.has(key)) continue;
        removeCell(key);
        if (!insertCell(key, placement)) continue;
        const trunkSlot = trunkOfCell.get(key)!;
        uploadInstanceRun(trunks.instanceMatrix, trunkSlot, 1, MATRIX_FLOATS_PER_INSTANCE);
        const kind = kindOfTrunk[trunkSlot]!;
        uploadInstanceRun(
          meshes[kindMeshIndex(kind)]!.instanceMatrix,
          kindSlotOfTrunk[trunkSlot]!,
          1,
          MATRIX_FLOATS_PER_INSTANCE,
        );
      }
      publish();
    },

    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}
