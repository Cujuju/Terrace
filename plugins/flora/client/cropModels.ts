// Crop plots, drawn as INSTANCES — card 28's visible half, following
// models.ts's own house pattern to the letter (see that file's header for the
// "why instancing, not per-object meshes" argument, which applies identically
// here and is not restated).
//
// TWO DRAW CALLS FOR THE WHOLE FIELD:
//
//   stalks CROP_STALKS_PER_PLOT wheat stems per plot, merged into ONE
//          geometry because they share one material
//   ears   the grain heads, merged into ONE geometry under their own
//          material — see EAR_COLOR for why the ear gets a second tone
//
// THERE IS NO TILLED BED ANY MORE (owner, 2026-08-24: "get rid of the brown
// plot on the bottom, so it looks more organic"). A plot used to be a shallow
// brown box with wheat standing on it, and it read as exactly that: a model
// placed on the ground rather than something growing out of it. What is left
// is wheat rooted straight in the terrain. That deleted a whole InstancedMesh
// and its material, which is why this file draws in two calls where it took
// three.
//
// THE STALK IS NOT AUTHORED HERE. It comes from wheatVariants.ts, which holds
// three designs; SHIPPED_WHEAT_VARIANT names the one a crop draws as (the
// owner picked harvest-heavy on 2026-08-24 — a bare arcing culm under a plump
// nodded head). The preview harness reaches the same builder through the same
// array, so what is reviewed and what ships cannot drift apart.
//
// EVERY STALK IS ITS OWN PLANT. A plot's four stalks each get their own yaw,
// height and nudge off the lattice (protocol.ts's cropStalkVariation) on top
// of the plot-wide yaw and scale. That is what keeps a field from reading as
// copies of one model on a grid — which matters far more now that the bed's
// own square no longer declares the grid deliberate. It costs nothing extra:
// the stalks are already instanced, so a per-stalk matrix is the same write a
// per-plot matrix was.

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

// ── Dimensions — authored as fractions of a crop CELL, then converted once
// through CELL_WORLD_SIZE. This is deliberate and load-bearing: when a cell
// was one world unit, this file hardcoded world-unit literals and read fine;
// WORLD_UNIT_CELLS = 4 silently turned a 0.82 plot into one 3.28 CELLS wide,
// overlapping its neighbours three deep. Expressing every dimension as "N of a
// cell" means the conversion has exactly one input and a future re-sample of
// WORLD_UNIT_CELLS cannot break the proportions again.

/** One crop CELL's worth of world units — the unit every dimension below speaks. */
const cells = (n: number): number => n * CELL_WORLD_SIZE;

/**
 * The square a plot's stalks are planted in. NOT chosen here: protocol.ts
 * derives it from the one cell a plot has to fit inside
 * (CROP_PLOT_CLUSTER_CELL_SPAN), because that same number is what stops plots
 * overlapping their neighbours. This module's job is to plant a cluster that
 * size, not to decide it.
 */
const CLUSTER_SPAN_IN_CELLS = CROP_PLOT_CLUSTER_CELL_SPAN;

/**
 * Colours picked to read as "farmed" against the grass ramp (see models.ts's
 * identical note on bandColors.ts): a golden wheat tone that has no equivalent
 * anywhere in the land ramp, so a field never reads as "slightly different
 * grass". With the tilled bed gone this contrast is the ONLY thing separating
 * a crop from the ground it stands on, so it carries more weight than it did.
 *
 * EAR_COLOR is the second tone, and it earns itself: at close range the camera
 * resolves individual stalks, and a stem and ear in the SAME gold fuse into
 * one shape — the lighter, riper ear against the darker stem is what makes a
 * wheat plant read as stalk-plus-head rather than as a plain spike.
 */
const STALK_COLOR = 0xd2b04a;
const EAR_COLOR = 0xe6c96a;

const UP = new Vector3(0, 1, 0);

/** Where one crop CELL stands and how its whole cluster varies. World units; y is the ground. */
export interface CropPlacement {
  readonly x: number;
  readonly z: number;
  /**
   * The CELL this plot stands on. It travels with the placement because the
   * per-stalk rolls hash integer CELL coordinates, and x/z above are world
   * units — a quarter of a cell each since the 2026-08-21 re-sample, so
   * hashing those would fold four cells onto one roll. Exactly the reason
   * structures' StructurePlacement carries cellX/cellY.
   */
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface CropModels {
  /** Parent of the instanced meshes; add this to the plugin's layer. */
  readonly root: Group;
  /**
   * How far one PLOT reaches around its own cell — the cluster spread out and
   * the tallest stalk up, at the biggest scale the variation rolls.
   *
   * Exposed for ./occupancy.ts (GH #252), which needs the same shape to answer
   * "what stands over this cell?" for the pointed-at pick. It is the very reach
   * the culling sphere is built from, so a crop is pointable exactly where it
   * is drawn.
   */
  readonly plotReach: InstanceReach;
  /** Replaces every drawn crop cluster with the given list. Order is irrelevant. */
  apply(placements: readonly CropPlacement[]): void;
  /** Frees every geometry and material. Call once, at plugin dispose. */
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

  // Scratch objects, reused across every instance of every rebuild — the
  // identical reasoning models.ts's own scratch objects give.
  const matrix = new Matrix4();
  const position = new Vector3();
  const plotRotation = new Quaternion();
  const stalkRotation = new Quaternion();
  const stalkScale = new Vector3();
  const stalkPosition = new Vector3();
  const stalkOffset = new Vector3();

  /** The box the plots stand in — the culling sphere's input (GH #257). */
  const extent = createPlacementExtent();

  // The horizontal room one plot needs around its own centre: the outermost
  // lattice point plus its jitter, in world units at unit scale.
  let plantedRadiusInSpans = 0;
  for (const [ox, oz] of CROP_STALK_OFFSETS) {
    plantedRadiusInSpans = Math.max(plantedRadiusInSpans, Math.hypot(ox, oz));
  }
  const clusterSpreadInWorld =
    cells(CLUSTER_SPAN_IN_CELLS) *
    (plantedRadiusInSpans + CROP_STALK_JITTER_IN_CLUSTER_SPANS * Math.SQRT2);

  /** One reach per mesh, in `meshes` order — all constants, so resolved once at build. */
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

  /**
   * The union of the per-mesh reaches: the ear geometry reaches higher than the
   * stalk it is mounted on, and either could be the widest, so one plot's
   * extent is the widest and tallest of them.
   */
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

        // The cluster's spread in WORLD units: the offsets are fractions of
        // the cluster span, and `position` is world units, so an unconverted
        // offset would plant the cluster several cells from its own plot.
        // Scaled by the plot's own roll so a bigger plot spreads wider as well
        // as growing bigger plants.
        const spread = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;

        // Safe without a per-iteration bound check: plotCount is capped at
        // FLORA_CROP_CAP above, so stalkCount can advance at most
        // FLORA_CROP_CAP * CROP_STALKS_PER_PLOT times here — exactly the stalk
        // and ear meshes' own shared instance allocation.
        for (let index = 0; index < CROP_STALKS_PER_PLOT; index++) {
          const [ox, oz] = CROP_STALK_OFFSETS[index]!;
          const stalk = cropStalkVariation(placement.cellX, placement.cellY, index);

          // Planted position: the lattice point plus this stalk's own wander,
          // both in cluster spans, then turned with the plot so the whole
          // clump rotates as one thing.
          stalkOffset
            .set((ox + stalk.jitterX) * spread, 0, (oz + stalk.jitterZ) * spread)
            .applyQuaternion(plotRotation);
          stalkPosition.copy(position).add(stalkOffset);

          // Facing: the stalk's OWN yaw, not the plot's. A plot-wide yaw on
          // four identical stalks turns a square of clones into a rotated
          // square of clones; a per-stalk yaw is what stops any two of them
          // presenting the same silhouette.
          stalkRotation.setFromAxisAngle(UP, stalk.yaw);

          // Height varies per stalk, girth does not: a wheat plant that grew
          // taller did not also grow fatter, and scaling all three axes would
          // read as "the same model, nearer the camera".
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
      // ONE RANGE PER BUFFER, sized by the live population (GH #262): three's
      // updateBuffer uploads the WHOLE array whenever the range list is empty
      // and never consults mesh.count, so a bare needsUpdate on a CAP-sized
      // buffer re-sends the cap however few instances are standing.
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
        // MANDATORY — see models.ts's identical note: an InstancedMesh's
        // frustum-culling bounding sphere is cached from the PREVIOUS set of
        // matrices, so skipping this makes a field vanish when the camera
        // moves past where the crops used to be. Only the DERIVATION changed
        // (GH #257) — see instanceBounds.ts.
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
