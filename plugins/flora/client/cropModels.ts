import {
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
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
  cropStalkVariation,
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
  writeInstanceSphere,
  type InstanceReach,
} from './instanceBounds.ts';
import { SHIPPED_WHEAT_VARIANT, WHEAT_VARIANT_BUILDERS } from './wheatVariants.ts';

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
  dispose(): void;
}

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true });
}

export function createCropModels(): CropModels {
  const built = WHEAT_VARIANT_BUILDERS[SHIPPED_WHEAT_VARIANT]!();
  const geometries: BufferGeometry[] = [built.stalk, built.ear];
  const materials: Material[] = [lambert(STALK_COLOR), lambert(EAR_COLOR)];

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

  return {
    root,
    plotReach,

    apply(placements: readonly CropPlacement[]): void {
      let plotCount = 0;
      let stalkCount = 0;
      clearPlacementExtent(extent);

      for (const placement of placements) {
        if (plotCount >= FLORA_CROP_CAP) break;
        plotCount++;
        includePlacement(extent, placement.x, placement.groundY, placement.z);

        position.set(placement.x, placement.groundY, placement.z);
        plotRotation.setFromAxisAngle(UP, placement.yaw);

        const spread = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;

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
      }

      stalks.count = stalkCount;
      ears.count = stalkCount;

      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
        writeInstanceSphere(mesh, extent, reaches[i]!);
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
