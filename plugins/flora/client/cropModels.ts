import {
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type Material,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  CROP_PLOT_CLUSTER_CELL_SPAN,
  CROP_SCALE_MAX,
  CROP_STALKS_PER_PLOT,
  CROP_STALK_HEIGHT_SPREAD,
  CROP_STALK_JITTER_IN_CLUSTER_SPANS,
  CROP_STALK_OFFSETS,
  FLORA_CROP_CAP,
  cropKey,
  cropStalkVariation,
  type CropCell,
} from '../protocol.ts';
import {
  MATRIX_FLOATS_PER_INSTANCE,
  clearPlacementExtent,
  clusteredReach,
  createPlacementExtent,
  geometryReach,
  includePlacement,
  scaledReach,
  uploadAllInstances,
  uploadInstanceRun,
  writeInstanceSphere,
  type InstanceReach,
} from './instanceBounds.ts';
import { SHIPPED_WHEAT_VARIANT, WHEAT_VARIANT_BUILDERS } from './wheatVariants.ts';
import { bakeSolidColor } from '../../../client/src/render/bakeSolidColor.ts';

const cells = (n: number): number => n * CELL_WORLD_SIZE;

const CLUSTER_SPAN_IN_CELLS = CROP_PLOT_CLUSTER_CELL_SPAN;

const STALK_COLOR = 0xd2b04a;
const EAR_COLOR = 0xe6c96a;

const UP = new Vector3(0, 1, 0);

export interface CropPlacement {
  readonly x: number;
  readonly z: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface CropModels {
  readonly root: Group;
  readonly plotReach: InstanceReach;
  apply(placements: readonly CropPlacement[]): void;
  applyDelta(sprouted: readonly CropPlacement[], withered: readonly CropCell[]): void;
  dispose(): void;
}

function lambert(): MeshLambertMaterial {
  return new MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

export function createCropModels(): CropModels {
  const built = WHEAT_VARIANT_BUILDERS[SHIPPED_WHEAT_VARIANT]!();
  const geometries: BufferGeometry[] = [built.stalk, built.ear];
  bakeSolidColor(built.stalk, STALK_COLOR);
  bakeSolidColor(built.ear, EAR_COLOR);
  const sharedMaterial = lambert();
  const materials: Material[] = [sharedMaterial, sharedMaterial];

  const stalkCapacity = FLORA_CROP_CAP * CROP_STALKS_PER_PLOT;
  const stalks = new InstancedMesh(built.stalk, materials[0], stalkCapacity);
  const ears = new InstancedMesh(built.ear, materials[1], stalkCapacity);

  const meshes = [stalks, ears];
  stalks.name = 'flora:crop-stalks';
  ears.name = 'flora:crop-ears';

  const root = new Group();
  root.name = 'flora:crops';
  for (const mesh of meshes) {
    mesh.count = 0;
    root.add(mesh);
  }

  const matrix = new Matrix4();
  const position = new Vector3();
  const plotRotation = new Quaternion();
  const stalkRotation = new Quaternion();
  const stalkScale = new Vector3();
  const stalkPosition = new Vector3();
  const stalkOffset = new Vector3();

  const extent = createPlacementExtent();

  let plantedRadiusInSpans = 0;
  for (const [ox, oz] of CROP_STALK_OFFSETS) {
    plantedRadiusInSpans = Math.max(plantedRadiusInSpans, Math.hypot(ox, oz));
  }
  const clusterSpreadInWorld =
    cells(CLUSTER_SPAN_IN_CELLS) *
    (plantedRadiusInSpans + CROP_STALK_JITTER_IN_CLUSTER_SPANS * Math.SQRT2);

  const reaches: InstanceReach[] = geometries.map(
    (geometry): InstanceReach =>
      scaledReach(
        clusteredReach(
          geometryReach(geometry),
          clusterSpreadInWorld,
          1 + CROP_STALK_HEIGHT_SPREAD,
        ),
        CROP_SCALE_MAX,
      ),
  );

  const plotReach: InstanceReach = {
    horizontal: Math.max(...reaches.map((r) => r.horizontal)),
    up: Math.max(...reaches.map((r) => r.up)),
    down: Math.max(...reaches.map((r) => r.down)),
  };

  const slotOfCell = new Map<number, number>();
  const cellOfSlot: number[] = [];
  let plotCount = 0;

  const writePlot = (slot: number, placement: CropPlacement): void => {
    position.set(placement.x, placement.groundY, placement.z);
    plotRotation.setFromAxisAngle(UP, placement.yaw);

    const spread = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;
    let stalkCount = slot * CROP_STALKS_PER_PLOT;

    for (let index = 0; index < CROP_STALKS_PER_PLOT; index++) {
      const [ox, oz] = CROP_STALK_OFFSETS[index]!;
      const stalk = cropStalkVariation(placement.cellX, placement.cellY, index);

      stalkOffset
        .set((ox + stalk.jitterX) * spread, 0, (oz + stalk.jitterZ) * spread)
        .applyQuaternion(plotRotation);
      stalkPosition.copy(position).add(stalkOffset);

      stalkRotation.setFromAxisAngle(UP, stalk.yaw);

      stalkScale.set(placement.scale, placement.scale * stalk.height, placement.scale);

      matrix.compose(stalkPosition, stalkRotation, stalkScale);
      stalks.setMatrixAt(stalkCount, matrix);
      ears.setMatrixAt(stalkCount++, matrix);
    }

    includePlacement(extent, placement.x, placement.groundY, placement.z);
  };

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

  const insertCell = (key: number, placement: CropPlacement): boolean => {
    if (plotCount >= FLORA_CROP_CAP) return false;
    const slot = plotCount++;
    writePlot(slot, placement);
    slotOfCell.set(key, slot);
    cellOfSlot[slot] = key;
    return true;
  };

  const removeCell = (key: number): void => {
    const slot = slotOfCell.get(key);
    if (slot === undefined) return;
    slotOfCell.delete(key);

    const last = plotCount - 1;
    const run = CROP_STALKS_PER_PLOT;
    if (slot !== last) {
      moveInstances(stalks.instanceMatrix, last * run, slot * run, run);
      moveInstances(ears.instanceMatrix, last * run, slot * run, run);
      const movedKey = cellOfSlot[last]!;
      cellOfSlot[slot] = movedKey;
      slotOfCell.set(movedKey, slot);
      uploadInstanceRun(stalks.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      uploadInstanceRun(ears.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
    }
    plotCount = last;
    cellOfSlot.length = last;
  };

  const publish = (): void => {
    const stalkCount = plotCount * CROP_STALKS_PER_PLOT;
    stalks.count = stalkCount;
    ears.count = stalkCount;
  };

  return {
    root,
    plotReach,

    apply(placements: readonly CropPlacement[]): void {
      slotOfCell.clear();
      cellOfSlot.length = 0;
      plotCount = 0;
      clearPlacementExtent(extent);

      for (const placement of placements) {
        if (!insertCell(cropKey(placement.cellX, placement.cellY), placement)) break;
      }

      publish();
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
        writeInstanceSphere(mesh, extent, reaches[i]!);
      }
    },

    applyDelta(sprouted: readonly CropPlacement[], withered: readonly CropCell[]): void {
      for (const cell of withered) removeCell(cropKey(cell.x, cell.y));
      for (const placement of sprouted) {
        const key = cropKey(placement.cellX, placement.cellY);
        if (plotCount >= FLORA_CROP_CAP && !slotOfCell.has(key)) continue;
        removeCell(key);
        if (!insertCell(key, placement)) continue;
        const run = CROP_STALKS_PER_PLOT;
        const slot = slotOfCell.get(key)!;
        uploadInstanceRun(stalks.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
        uploadInstanceRun(ears.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      }
      publish();
      for (let i = 0; i < meshes.length; i++) {
        writeInstanceSphere(meshes[i]!, extent, reaches[i]!);
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
