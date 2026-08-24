// Low-poly crop patches, drawn as INSTANCES — card 28's visible half,
// following models.ts's own house pattern to the letter (see that file's
// header for the "why instancing, not per-object meshes" argument, which
// applies identically here and is not restated).
//
// THREE DRAW CALLS FOR THE WHOLE FIELD:
//
//   beds   one shallow box per crop CELL — the tilled soil a field stands on
//   stalks CROP_STALKS_PER_CELL wheat stems + leaves per cell, merged into
//          ONE geometry because they share one material
//   ears   the grain heads, merged into ONE geometry under their own
//          material — see EAR_COLOR for why the ear gets a second tone
//
// A single cone per stalk used to read as a spike rather than wheat once the
// camera came close (WORLD_UNIT_CELLS = 4 shrank every plot to a quarter of
// its old span, putting the orbit camera well inside "close"), so each stalk
// is now an authored stem + two leaves + a nodded EAR of individual kernels.
// The authored pieces are merged into exactly two geometries at startup: the
// unit a thing is AUTHORED in is not the unit it is DRAWN in (parts.ts's
// mergeParts makes the same argument for structures; here three/addons'
// mergeGeometries does the collapsing, since the merge is one-time work).
//
// A "bed" cell reads as a furrow even from orbit distance; a single stalk per
// cell would read as sparse dots rather than a field, so each cell keeps a
// small fixed cluster — see CROP_STALK_OFFSETS. All three meshes share one
// instance-COUNT relationship (bedCount × STALKS = stalkCount) but are
// otherwise independent.

import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { CROP_PLOT_BED_CELL_COVERAGE, FLORA_CROP_CAP } from '../protocol.ts';

// ── Dimensions — authored as fractions of a crop CELL, then converted once
// through CELL_WORLD_SIZE. This is deliberate and load-bearing: when a cell
// was one world unit, this file hardcoded world-unit literals and read fine;
// WORLD_UNIT_CELLS = 4 silently turned BED_WIDTH = 0.82 into a bed 3.28 cells
// wide, overlapping its neighbours three deep. Expressing every dimension as
// "N of a cell" means the conversion has exactly one input and a future
// re-sample of WORLD_UNIT_CELLS cannot break the proportions again.

/** One crop CELL's worth of world units — the unit every dimension below speaks. */
const cells = (n: number): number => n * CELL_WORLD_SIZE;

/**
 * The bed's footprint is NOT chosen here. protocol.ts derives it from the one
 * cell the plot has to fit inside (CROP_PLOT_BED_CELL_COVERAGE), because that
 * is simultaneously the rule that plots never overlap and the rule that a plot
 * never stands on more ground than its cell was vouched for — see that file's
 * plot-footprint block. This module's job is to draw a plot that size, not to
 * decide it.
 *
 * The plot is SQUARE, so one constant serves both axes: a rectangle would have
 * two different reaches and the yaw roll would swing between them.
 */
const BED_WIDTH_IN_CELLS = CROP_PLOT_BED_CELL_COVERAGE;
const BED_DEPTH_IN_CELLS = CROP_PLOT_BED_CELL_COVERAGE;
const BED_HEIGHT_IN_CELLS = 0.05;

/** Slender stem: visibly thinner than the old spike's 0.05-cell base. */
const STEM_BASE_RADIUS_IN_CELLS = 0.018;
const STEM_TOP_RADIUS_IN_CELLS = 0.010;
const STEM_HEIGHT_IN_CELLS = 0.30;
/** Five sides — enough silhouette roundness to not read as a flat card. */
const STEM_RADIAL_SEGMENTS = 5;

const BLADE_LENGTH_IN_CELLS = 0.09;
const BLADE_WIDTH_IN_CELLS = 0.018;
/** Thinner than wide — a leaf blade, not a stick. */
const BLADE_THICKNESS_IN_CELLS = 0.005;
/** How far up the stem each leaf attaches, as a fraction of STEM_HEIGHT. */
const LEAF_ATTACH_FRACTIONS: readonly [number, number] = [0.4, 0.6];
/** Radians below horizontal — wheat leaves arch outward and droop. */
const LEAF_DROOP_RADIANS = 0.95;
/** Two leaves, yawed apart so the cluster reads from any quarter turn. */
const LEAF_YAW_RADIANS: readonly [number, number] = [0, Math.PI * 0.75];

const EAR_LENGTH_IN_CELLS = 0.11;
const EAR_RADIAL_SEGMENTS = 6;
const EAR_RADIUS_IN_CELLS = 0.022;
/** The ear tapers toward the tip — a wheat head swells at the base. */
const EAR_TIP_TAPER = 0.25;
/** The nod: ripe wheat leans the ear off vertical under its own grain weight. */
const EAR_NOD_RADIANS = 0.4;
/** A fixed yaw on the ear so the nod direction varies against the leaves'. */
const EAR_YAW_RADIANS = Math.PI * 0.35;

/** Kernel rows around the ear, and whorls (rings) up it. */
const KERNELS_PER_WHORL = 5;
const KERNEL_WHORLS = 2;
const KERNEL_SIZE_IN_CELLS = 0.014;
/** Kernels are longer than wide — plump grain, not beads. */
const KERNEL_ELONGATION = 1.8;

/**
 * Stalks per crop CELL, and their fixed offsets from the cell centre (a
 * small 2×2 spread, NOT randomised further — CropVariation's per-cell yaw
 * already rotates and scales the whole cluster together, exactly the way
 * one tree's single instance matrix places its whole trunk+crown, so a
 * second, per-stalk jitter would buy little for the extra bookkeeping of
 * tracking sub-cell positions independently). Four is the fewest that reads
 * as a clump rather than as isolated dots at this camera distance while
 * keeping the instance count a small, fixed multiple of FLORA_CROP_CAP.
 *
 * Offsets are fractions of the BED's own edge, not of a cell and not world
 * units, so a change to the bed's size moves the cluster with it and no stalk
 * can ever end up planted off the soil it is supposed to grow in. They are
 * converted to world units at the point of use, through the same `cells`
 * helper every other dimension here goes through.
 */
const STALK_OFFSET_IN_BED_EDGES = 0.22;
const CROP_STALK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-STALK_OFFSET_IN_BED_EDGES, -STALK_OFFSET_IN_BED_EDGES],
  [STALK_OFFSET_IN_BED_EDGES, -STALK_OFFSET_IN_BED_EDGES],
  [-STALK_OFFSET_IN_BED_EDGES, STALK_OFFSET_IN_BED_EDGES],
  [STALK_OFFSET_IN_BED_EDGES, STALK_OFFSET_IN_BED_EDGES],
];
const CROP_STALKS_PER_CELL = CROP_STALK_OFFSETS.length;

/**
 * Colours picked to read as "farmed" against the grass ramp (see
 * models.ts's identical note on bandColors.ts): tilled soil darker and
 * warmer than any bare-soil terrain stop, stalks a golden wheat tone that
 * has no equivalent anywhere in the land ramp, so a field never reads as
 * "slightly different grass".
 *
 * EAR_COLOR is the one new tone, and it earns itself: at close range the
 * camera resolves individual stalks, and a stem and ear in the SAME gold
 * fuse into one shape — the lighter, riper ear against the darker stem is
 * what makes a wheat plant read as stalk-plus-head rather than as a plain
 * spike, which is precisely the failure this rewrite exists to fix.
 */
const BED_COLOR = 0x5b4630;
const STALK_COLOR = 0xd2b04a;
const EAR_COLOR = 0xe6c96a;

/**
 * How far the outermost part of the stalk cluster reaches from the plot's
 * centre, as a fraction of a CELL — the cluster's own version of the bound
 * protocol.ts places on the bed.
 *
 * The far corner of the outermost stalk's offset, plus that stalk's own
 * widest horizontal part. A leaf is the widest: it reaches BLADE_LENGTH out
 * along its own yaw, foreshortened by its droop (an upright leaf reaches
 * nothing horizontally; a horizontal one reaches its full length). The ear's
 * nod is smaller than that and does not need its own term, but is included so
 * the bound cannot go stale if the nod is ever opened up.
 */
const STALK_CLUSTER_REACH_IN_CELLS =
  STALK_OFFSET_IN_BED_EDGES * BED_WIDTH_IN_CELLS * Math.SQRT2 +
  Math.max(
    BLADE_LENGTH_IN_CELLS * Math.cos(LEAF_DROOP_RADIANS),
    EAR_LENGTH_IN_CELLS * Math.sin(EAR_NOD_RADIANS),
  );

/**
 * The stalks must stand on their own soil — checked at load, not trusted, for
 * the same reason protocol.ts checks the bed against its cell: every input is
 * a constant, so this either always holds or never does, and a plot whose
 * wheat grows off the edge of its own tilled bed is a defect visible from the
 * first frame. This is also what keeps protocol.ts's reach bound honest, since
 * that bound measures the BED and would say nothing about a stalk hanging past
 * it.
 */
if (STALK_CLUSTER_REACH_IN_CELLS > BED_WIDTH_IN_CELLS / 2) {
  throw new RangeError(
    `crop stalks reach ${STALK_CLUSTER_REACH_IN_CELLS} cells, past the ${BED_WIDTH_IN_CELLS / 2}-cell edge of their own bed`,
  );
}

/** Where one crop CELL stands and how its whole cluster varies. World units; y is the ground. */
export interface CropPlacement {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface CropModels {
  /** Parent of the instanced meshes; add this to the plugin's layer. */
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

/**
 * Bakes `source` through `local` into a standalone non-indexed geometry ready
 * for mergeGeometries (which requires consistent attributes across inputs).
 * The source is disposed by the caller's loop over staging pieces — see
 * buildStalkGeometries — because it was never handed to the renderer; the
 * same contract parts.ts's bakeInto states for structures.
 */
function baked(source: BufferGeometry, local: Matrix4): BufferGeometry {
  const out = source.index === null ? source.clone() : source.toNonIndexed();
  out.applyMatrix4(local);
  return out;
}

/**
 * Builds ONE wheat stalk as two merged geometries sharing a root at the stem
 * base: the stem-and-leaves half, and the nodded ear. Authored once at
 * startup, then instanced FLORA_CROP_CAP × STALKS times — which is why the
 * per-stalk detail (~130 triangles) is affordable across 2048 plots.
 *
 * Every staging geometry here is disposed before return: each contributed its
 * baked copy to a merge, and the merges are what the InstancedMeshes hold.
 */
function buildStalkGeometries(): { stalk: BufferGeometry; ear: BufferGeometry } {
  const stalkHeight = cells(STEM_HEIGHT_IN_CELLS);
  const earLength = cells(EAR_LENGTH_IN_CELLS);
  const earRadius = cells(EAR_RADIUS_IN_CELLS);
  const kernelSize = cells(KERNEL_SIZE_IN_CELLS);

  // Scratch transform pieces, used only during this one-shot build.
  const m = new Matrix4();
  const q = new Quaternion();
  const v = new Vector3();

  // ── Stem: a tapered tube, open-ended — the bed hides the bottom rim and
  // the ear caps the top, so neither end cap earns its triangles.
  const stalkParts: BufferGeometry[] = [];
  const stem = new CylinderGeometry(
    cells(STEM_TOP_RADIUS_IN_CELLS), cells(STEM_BASE_RADIUS_IN_CELLS),
    stalkHeight, STEM_RADIAL_SEGMENTS, 1, true,
  );
  stem.translate(0, stalkHeight / 2, 0);
  stalkParts.push(baked(stem, m.identity()));
  stem.dispose();

  // ── Leaves: thin slabs reaching outward along +X from their attach point,
  // drooped below horizontal and fanned apart by each leaf's yaw.
  const blade = new BoxGeometry(
    cells(BLADE_LENGTH_IN_CELLS), cells(BLADE_THICKNESS_IN_CELLS), cells(BLADE_WIDTH_IN_CELLS),
  );
  blade.translate(cells(BLADE_LENGTH_IN_CELLS) / 2, 0, 0);
  for (let i = 0; i < LEAF_ATTACH_FRACTIONS.length; i++) {
    q.setFromEuler(new Euler(-LEAF_DROOP_RADIANS, LEAF_YAW_RADIANS[i], 0, 'YXZ'));
    v.set(0, stalkHeight * LEAF_ATTACH_FRACTIONS[i], 0);
    stalkParts.push(baked(blade, m.compose(v, q, new Vector3(1, 1, 1))));
  }
  blade.dispose();

  // ── Ear: a tapered cob plus whorls of individual kernels, assembled along
  // local +Y from the ear's base...
  const earParts: BufferGeometry[] = [];
  const cob = new CylinderGeometry(
    earRadius * EAR_TIP_TAPER, earRadius, earLength, EAR_RADIAL_SEGMENTS,
  );
  cob.translate(0, earLength / 2, 0);
  earParts.push(baked(cob, m.identity()));
  cob.dispose();

  const kernel = new OctahedronGeometry(kernelSize);
  const kernelScale = new Vector3(1, KERNEL_ELONGATION, 1);
  for (let w = 0; w < KERNEL_WHORLS; w++) {
    // Whorls sit near the base and near the middle; the tapered tip carries
    // none — that is where the awns would be, and they do not read at scale.
    const alongEar = kernelSize + (w / KERNEL_WHORLS) * earLength * 0.8;
    const taper = 1 - (alongEar / earLength) * (1 - EAR_TIP_TAPER);
    const whorlRadius = earRadius * taper;
    for (let k = 0; k < KERNELS_PER_WHORL; k++) {
      // Odd whorls sit half a step around, so kernels stagger instead of
      // stacking into columns.
      const angle =
        (Math.PI * 2 * k) / KERNELS_PER_WHORL + (w % 2) * (Math.PI / KERNELS_PER_WHORL);
      v.set(
        Math.cos(angle) * (whorlRadius + kernelSize * 0.4),
        alongEar,
        Math.sin(angle) * (whorlRadius + kernelSize * 0.4),
      );
      q.identity();
      earParts.push(baked(kernel, m.compose(v, q, kernelScale)));
    }
  }
  kernel.dispose();

  // ...then pivoted about the stem top by yaw-then-nod, so the whole head
  // leans off vertical the way ripe wheat hangs under its grain weight.
  const earPivot = new Matrix4()
    .makeTranslation(0, stalkHeight, 0)
    .multiply(new Matrix4().makeRotationFromEuler(new Euler(EAR_NOD_RADIANS, EAR_YAW_RADIANS, 0, 'YXZ')));
  for (const part of earParts) part.applyMatrix4(earPivot);

  return { stalk: mergeGeometries(stalkParts)!, ear: mergeGeometries(earParts)! };
}

export function createCropModels(): CropModels {
  const bedGeometry = new BoxGeometry(cells(BED_WIDTH_IN_CELLS), cells(BED_HEIGHT_IN_CELLS), cells(BED_DEPTH_IN_CELLS));
  bedGeometry.translate(0, cells(BED_HEIGHT_IN_CELLS) / 2, 0);

  const { stalk: stalkGeometry, ear: earGeometry } = buildStalkGeometries();

  const geometries: BufferGeometry[] = [bedGeometry, stalkGeometry, earGeometry];
  const materials: Material[] = [lambert(BED_COLOR), lambert(STALK_COLOR), lambert(EAR_COLOR)];

  const stalkCapacity = FLORA_CROP_CAP * CROP_STALKS_PER_CELL;
  const beds = new InstancedMesh(bedGeometry, materials[0], FLORA_CROP_CAP);
  const stalks = new InstancedMesh(stalkGeometry, materials[1], stalkCapacity);
  const ears = new InstancedMesh(earGeometry, materials[2], stalkCapacity);

  const meshes = [beds, stalks, ears];
  beds.name = 'flora:crop-beds';
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
        // stalk and ear meshes' own shared instance allocation.
        for (const [ox, oz] of CROP_STALK_OFFSETS) {
          // Two conversions, both load-bearing. `cells(… × BED_WIDTH_IN_CELLS)`
          // turns a fraction of the bed's edge into world units — the offsets
          // are added to `position`, which is world units, so an unconverted
          // offset would plant the cluster several cells away from its own
          // bed. `× placement.scale` then spreads the cluster WITH the bed,
          // because these offsets land in the matrix BEFORE placement.scale is
          // composed in: without it a scaled-up plot grew a wider bed under an
          // unscaled stalk cluster.
          const spread = cells(BED_WIDTH_IN_CELLS) * placement.scale;
          stalkOffset.set(ox * spread, 0, oz * spread).applyQuaternion(rotation);
          stalkPosition.copy(position).add(stalkOffset);
          matrix.compose(stalkPosition, rotation, scale);
          stalks.setMatrixAt(stalkCount, matrix);
          ears.setMatrixAt(stalkCount++, matrix);
        }
      }

      beds.count = bedCount;
      stalks.count = stalkCount;
      ears.count = stalkCount;

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
