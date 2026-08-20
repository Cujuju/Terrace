// Low-poly crop patches, drawn as INSTANCES — card 28's visible half,
// following models.ts's own house pattern to the letter (see that file's
// header for the "why instancing, not per-object meshes" argument, which
// applies identically here and is not restated).
//
// TWO DRAW CALLS FOR THE WHOLE FIELD, mirroring trees' trunk/crown split:
//
//   bed      one shallow box per crop CELL — the tilled soil a field stands on
//   stalks   CROP_STALKS_PER_CELL cones per crop cell — the crop itself
//
// A "bed" cell reads as a furrow even from the game's orbit-camera distance;
// a single stalk per cell would read as sparse dots rather than a field, so
// each cell gets a small fixed cluster instead — see CROP_STALK_OFFSETS.
// Both meshes share one instance-COUNT relationship (bedCount × STALKS =
// stalkCount) but are otherwise independent, exactly like trunks/crowns.

import {
  BoxGeometry,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { FLORA_CROP_CAP } from '../protocol.ts';

// ── Dimensions, in world units — CELL_WORLD_SIZE is 1 (client/src/config.ts),
// so these read directly as fractions of a cell, the same convention
// models.ts's tree dimensions use.

const BED_WIDTH = 0.82;
const BED_DEPTH = 0.82;
const BED_HEIGHT = 0.05;

const STALK_RADIUS = 0.05;
const STALK_HEIGHT = 0.3;
/** Four sides — a stalk is a couple of pixels wide at play distance. */
const STALK_SEGMENTS = 4;

/**
 * Stalks per crop CELL, and their fixed offsets from the cell centre (a
 * small 2×2 spread, NOT randomised further — CropVariation's per-cell yaw
 * already rotates and scales the whole cluster together, exactly the way
 * one tree's single instance matrix places its whole trunk+crown, so a
 * second, per-stalk jitter would buy little for the extra bookkeeping of
 * tracking sub-cell positions independently). Four is the fewest that reads
 * as a clump rather than as isolated dots at this camera distance while
 * keeping the instance count a small, fixed multiple of FLORA_CROP_CAP.
 */
const CROP_STALK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-0.18, -0.18],
  [0.18, -0.18],
  [-0.18, 0.18],
  [0.18, 0.18],
];
const CROP_STALKS_PER_CELL = CROP_STALK_OFFSETS.length;

/**
 * Colours picked to read as "farmed" against the grass ramp (see
 * models.ts's identical note on bandColors.ts): tilled soil darker and
 * warmer than any bare-soil terrain stop, stalks a golden wheat tone that
 * has no equivalent anywhere in the land ramp, so a field never reads as
 * "slightly different grass".
 */
const BED_COLOR = 0x5b4630;
const STALK_COLOR = 0xd2b04a;

/** Where one crop CELL stands and how its whole cluster varies. World units; y is the ground. */
export interface CropPlacement {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface CropModels {
  /** Parent of the two instanced meshes; add this to the plugin's layer. */
  readonly root: Group;
  /** Replaces every drawn crop cluster with the given list. Order is irrelevant. */
  apply(placements: readonly CropPlacement[]): void;
  /** Frees every geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

const UP = new Vector3(0, 1, 0);

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true });
}

export function createCropModels(): CropModels {
  const bedGeometry = new BoxGeometry(BED_WIDTH, BED_HEIGHT, BED_DEPTH);
  bedGeometry.translate(0, BED_HEIGHT / 2, 0);

  const stalkGeometry = new ConeGeometry(STALK_RADIUS, STALK_HEIGHT, STALK_SEGMENTS);
  stalkGeometry.translate(0, STALK_HEIGHT / 2, 0);

  const geometries: BufferGeometry[] = [bedGeometry, stalkGeometry];
  const materials: Material[] = [lambert(BED_COLOR), lambert(STALK_COLOR)];

  const beds = new InstancedMesh(bedGeometry, materials[0], FLORA_CROP_CAP);
  const stalks = new InstancedMesh(stalkGeometry, materials[1], FLORA_CROP_CAP * CROP_STALKS_PER_CELL);

  const meshes = [beds, stalks];
  beds.name = 'flora:crop-beds';
  stalks.name = 'flora:crop-stalks';

  const root = new Group();
  root.name = 'flora:crops';
  for (const mesh of meshes) {
    mesh.count = 0;
    root.add(mesh);
  }

  // Scratch objects, reused across every instance of every rebuild — the
  // identical reasoning models.ts's own scratch objects give.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const stalkPosition = new Vector3();
  const stalkOffset = new Vector3();

  return {
    root,

    apply(placements: readonly CropPlacement[]): void {
      let bedCount = 0;
      let stalkCount = 0;

      for (const placement of placements) {
        if (bedCount >= FLORA_CROP_CAP) break;

        position.set(placement.x, placement.groundY, placement.z);
        rotation.setFromAxisAngle(UP, placement.yaw);
        scale.setScalar(placement.scale);

        matrix.compose(position, rotation, scale);
        beds.setMatrixAt(bedCount++, matrix);

        // Safe without a per-iteration bound check: bedCount is capped at
        // FLORA_CROP_CAP above, so stalkCount can advance at most
        // FLORA_CROP_CAP * CROP_STALKS_PER_CELL times here — exactly the
        // stalks mesh's own instance allocation.
        for (const [ox, oz] of CROP_STALK_OFFSETS) {
          stalkOffset.set(ox, 0, oz).applyQuaternion(rotation);
          stalkPosition.copy(position).add(stalkOffset);
          matrix.compose(stalkPosition, rotation, scale);
          stalks.setMatrixAt(stalkCount++, matrix);
        }
      }

      beds.count = bedCount;
      stalks.count = stalkCount;

      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        // MANDATORY — see models.ts's identical note: an InstancedMesh's
        // frustum-culling bounding sphere is cached from the PREVIOUS set of
        // matrices, so skipping this makes a field vanish when the camera
        // moves past where the crops used to be.
        mesh.computeBoundingSphere();
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
