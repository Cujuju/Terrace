// Grass tufts, drawn as INSTANCES — the meadow's visible half (owner,
// 2026-08-24: "another texture just like the wheat, but green … spawn
// abundantly on all of the green or green-like bands"). Follows cropModels.ts
// to the letter, which follows models.ts; see those headers for the "why
// instancing, not per-object meshes" argument, which applies identically here
// and is not restated.
//
// TWO DRAW CALLS FOR THE WHOLE MEADOW, exactly as a wheat field takes two:
//
//   blades  the lower two thirds of every blade, merged into ONE geometry
//           under the deep green
//   tips    the top third, under a lighter, sun-bleached green — the second
//           tone that does for a blade what EAR_COLOR does for a stalk
//
// WHY A RIBBON AND NOT A BOX. A crop stalk is a culm — a round stem — so
// cropModels.ts's wheat is built from cylinders. A blade of grass is a flat
// tapering strip, and drawing one as a box costs 12 triangles to say something
// 4 can say. The whole blade here is FIVE triangles: a two-quad ribbon that
// narrows along an arc, plus a single triangle for the point. At the shipped
// cap that is 24 576 tufts × GRASS_BLADES_PER_TUFT × 5 ≈ 370k triangles in two
// draw calls, which is why grass can be an order of magnitude more numerous
// than wheat without costing an order of magnitude more.
//
// The ribbon is drawn DOUBLE-SIDED for the same reason it is a ribbon: it has
// no thickness, so a single-sided blade would vanish from half the compass.
// That is one material flag, not extra geometry.
//
// EVERY BLADE IS ITS OWN PLANT, exactly as every wheat stalk is: its own yaw
// (which is also which way it arcs, since the arc is authored in the blade's
// own local +X), its own height, its own nudge off the lattice
// (protocol.ts's grassBladeVariation) on top of the tuft-wide yaw and scale.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  FLORA_GRASS_CAP,
  GRASS_BLADES_PER_TUFT,
  GRASS_BLADE_JITTER_IN_CLUSTER_SPANS,
  GRASS_BLADE_OFFSETS,
  GRASS_SCALE_MAX,
  GRASS_TUFT_CLUSTER_CELL_SPAN,
  grassBladeVariation,
} from '../protocol.ts';

/** One crop CELL's worth of world units — the unit every dimension below speaks. */
const cells = (n: number): number => n * CELL_WORLD_SIZE;

/**
 * The square a tuft's blades are planted in. NOT chosen here: protocol.ts
 * derives it from the contour guard every green cell already carries, which is
 * what makes a tuft unable to overhang a terrace lip — see
 * GRASS_TUFT_CLUSTER_CELL_SPAN.
 */
const CLUSTER_SPAN_IN_CELLS = GRASS_TUFT_CLUSTER_CELL_SPAN;

/**
 * Colours picked the way cropModels.ts picks its gold: against the land ramp,
 * not in isolation. Wheat needed a tone with NO equivalent in the ramp so a
 * field never reads as slightly different grass — grass has the opposite job.
 * It has to sit close enough to the ramp's greens to read as the same
 * vegetation and far enough from any one band to stay visible as blades
 * standing on the ground rather than as a smear of it, which is what the
 * darker base and the lighter tip do between them: the tone CONTRAST is what
 * survives at distance once the individual blades stop resolving.
 */
const BLADE_COLOR = 0x4e7d33;
const TIP_COLOR = 0x8fb857;

/**
 * How tall one blade stands, in CELLS, before its per-blade height roll.
 *
 * Shorter than a wheat culm (4 × 0.075 = 0.3 cells in wheatVariants.ts) on
 * purpose: crops are a cultivated thing standing above the meadow they were
 * planted in, and grass that matched them would erase that difference from
 * every distance at once.
 */
const BLADE_LENGTH_IN_CELLS = 0.26;

/** How wide a blade is at the ground, in CELLS. It tapers to a point at the tip. */
const BLADE_BASE_WIDTH_IN_CELLS = 0.022;

/**
 * Cross-sections along a blade. THREE segments, which is the fewest that reads
 * as a curve rather than as a bent stick, and it is also what sets the
 * triangle count (2 per full-width segment, 1 for the point).
 */
const BLADE_SEGMENTS = 3;

/**
 * How many of those segments belong to the TIP geometry — the lighter tone.
 * One: the top third, which is roughly where a real blade dries out, and which
 * leaves the lower two segments as the quad ribbon under the base tone.
 */
const BLADE_TIP_SEGMENTS = 1;

/**
 * Total lean from vertical at the tip, in radians, accumulated evenly across
 * the segments — the arch.
 *
 * BOUNDED BY THE FOOTPRINT, not chosen for looks alone: every radian of arch
 * is horizontal reach, and a tuft may not reach further from its cell than
 * protocol.ts's GRASS_TUFT_MAX_REACH_CELLS. At 0.5 rad (~29°) the built
 * blade's measured reach leaves the planting lattice and its jitter room
 * inside that bound — which assertBladeFitsTuft checks against the geometry
 * this file actually built, rather than against an estimate of it.
 */
const BLADE_ARCH_RADIANS = 0.5;

/**
 * How sharply the blade narrows: width is (1 − t)^this along the blade. Above
 * 1 the blade holds its width through the middle and narrows late, which is
 * what a grass blade does and what stops the ribbon reading as a triangle.
 */
const BLADE_TAPER_EXPONENT = 1.6;

/**
 * Half the diagonal of a unit square — restated from protocol.ts's own
 * SQUARE_CIRCUMRADIUS_PER_EDGE (which is module-private there) because this
 * file needs the same edge→circumradius factor to check a built blade against
 * the square it has to stay inside.
 */
const SQUARE_CIRCUMRADIUS_PER_EDGE = Math.SQRT2 / 2;

const UP = new Vector3(0, 1, 0);
/** The axis the arch bends about: the arc is authored in the blade's local X-Y plane. */
const BEND_AXIS = new Vector3(0, 0, 1);
/** The blade's width runs along local Z, perpendicular to the plane it arcs in. */
const WIDTH_AXIS = new Vector3(0, 0, 1);

/** Where one tuft stands and how its whole cluster varies. World units; y is the ground. */
export interface GrassPlacement {
  readonly x: number;
  readonly z: number;
  /** The CELL this tuft stands on — the per-blade rolls hash integer cells, not world units (CropPlacement.cellX's reason). */
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface GrassModels {
  /** Parent of the instanced meshes; add this to the plugin's layer. */
  readonly root: Group;
  /** Replaces every drawn tuft with the given list. Order is irrelevant. */
  apply(placements: readonly GrassPlacement[]): void;
  /** Frees every geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** One blade, split into its base ribbon and its tip point. */
interface BladeGeometries {
  readonly blade: BufferGeometry;
  readonly tip: BufferGeometry;
  /** The furthest the built blade reaches from its own root, horizontally, in CELLS. */
  readonly horizontalReachInCells: number;
}

/** A flat, non-indexed triangle soup from a plain number list. */
function triangleSoup(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds one blade: walk the arc, emit a pair of edge vertices per
 * cross-section, then stitch consecutive pairs into triangles. Everything is
 * in WORLD units by the time it lands in the arrays (the `cells` conversion
 * happens once, here), and the root of the blade is the origin so a placement
 * can put it straight on the ground.
 */
function buildBlade(): BladeGeometries {
  const segmentLength = cells(BLADE_LENGTH_IN_CELLS) / BLADE_SEGMENTS;
  const bendPerSegment = BLADE_ARCH_RADIANS / BLADE_SEGMENTS;
  const halfBaseWidth = cells(BLADE_BASE_WIDTH_IN_CELLS) / 2;

  // The spine: one centre point per cross-section, walked segment by segment
  // so the blade sweeps a real curve instead of kinking at its joints (the
  // same walk buildHarvestWheat uses for its arcing culm).
  const centres: Vector3[] = [new Vector3(0, 0, 0)];
  const position = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 1, 0);
  for (let i = 0; i < BLADE_SEGMENTS; i++) {
    position.addScaledVector(direction, segmentLength);
    centres.push(position.clone());
    direction.applyAxisAngle(BEND_AXIS, -bendPerSegment).normalize();
  }

  const halfWidths: number[] = [];
  for (let i = 0; i <= BLADE_SEGMENTS; i++) {
    const t = i / BLADE_SEGMENTS;
    halfWidths.push(halfBaseWidth * Math.pow(1 - t, BLADE_TAPER_EXPONENT));
  }

  const left = (i: number): Vector3 =>
    centres[i]!.clone().addScaledVector(WIDTH_AXIS, halfWidths[i]!);
  const right = (i: number): Vector3 =>
    centres[i]!.clone().addScaledVector(WIDTH_AXIS, -halfWidths[i]!);

  const basePositions: number[] = [];
  const tipPositions: number[] = [];
  const push = (into: number[], ...points: Vector3[]): void => {
    for (const point of points) into.push(point.x, point.y, point.z);
  };

  const firstTipSegment = BLADE_SEGMENTS - BLADE_TIP_SEGMENTS;
  for (let i = 0; i < BLADE_SEGMENTS; i++) {
    const into = i >= firstTipSegment ? tipPositions : basePositions;
    const l0 = left(i);
    const r0 = right(i);
    const l1 = left(i + 1);
    const r1 = right(i + 1);
    // The last cross-section has zero width, so its two edge vertices are the
    // same point and the segment is ONE triangle, not two. Emitting the
    // degenerate second triangle anyway would be a wasted draw of nothing.
    if (halfWidths[i + 1] === 0) {
      push(into, l0, r0, l1);
    } else {
      push(into, l0, r0, l1);
      push(into, r0, r1, l1);
    }
  }

  let horizontalReach = 0;
  for (let i = 0; i <= BLADE_SEGMENTS; i++) {
    const reach = Math.hypot(centres[i]!.x, centres[i]!.z) + halfWidths[i]!;
    horizontalReach = Math.max(horizontalReach, reach);
  }

  return {
    blade: triangleSoup(basePositions),
    tip: triangleSoup(tipPositions),
    horizontalReachInCells: horizontalReach / CELL_WORLD_SIZE,
  };
}

/**
 * The cluster's worst-case reach from tuft centre, checked against the square
 * the tuft has to stay inside — wheatVariants.ts's assertClusterFitsBed, doing
 * the same job for the same reason: every input is a constant, so this either
 * always holds or never does, and grass hanging over a terrace lip is a defect
 * visible from the first frame.
 *
 * The worst case is the outermost planting point pushed further out along both
 * jitter axes at once, plus the blade's own horizontal run.
 */
function assertBladeFitsTuft(horizontalReachInCells: number): void {
  let plantedRadiusInSpans = 0;
  for (const [ox, oz] of GRASS_BLADE_OFFSETS) {
    plantedRadiusInSpans = Math.max(plantedRadiusInSpans, Math.hypot(ox, oz));
  }
  const worstInSpans =
    plantedRadiusInSpans +
    GRASS_BLADE_JITTER_IN_CLUSTER_SPANS * Math.SQRT2 +
    horizontalReachInCells / CLUSTER_SPAN_IN_CELLS;

  if (worstInSpans > SQUARE_CIRCUMRADIUS_PER_EDGE) {
    throw new RangeError(
      `a grass blade reaches ${worstInSpans.toFixed(3)} cluster spans from its tuft centre, past the ${SQUARE_CIRCUMRADIUS_PER_EDGE.toFixed(3)} its cell guarantees`,
    );
  }
}

function lambert(color: number): MeshLambertMaterial {
  // DoubleSide because a blade is a ribbon with no thickness — see the header.
  return new MeshLambertMaterial({ color, flatShading: true, side: DoubleSide });
}

export function createGrassModels(): GrassModels {
  const built = buildBlade();
  assertBladeFitsTuft(built.horizontalReachInCells);

  const geometries: BufferGeometry[] = [built.blade, built.tip];
  const materials: Material[] = [lambert(BLADE_COLOR), lambert(TIP_COLOR)];

  const bladeCapacity = FLORA_GRASS_CAP * GRASS_BLADES_PER_TUFT;
  const blades = new InstancedMesh(built.blade, materials[0], bladeCapacity);
  const tips = new InstancedMesh(built.tip, materials[1], bladeCapacity);

  const meshes = [blades, tips];
  blades.name = 'flora:grass-blades';
  tips.name = 'flora:grass-tips';

  const root = new Group();
  root.name = 'flora:grass';
  for (const mesh of meshes) {
    mesh.count = 0;
    root.add(mesh);
  }

  // Scratch objects, reused across every instance of every rebuild — the
  // identical reasoning cropModels.ts's own scratch objects give.
  const matrix = new Matrix4();
  const position = new Vector3();
  const tuftRotation = new Quaternion();
  const bladeRotation = new Quaternion();
  const bladeScale = new Vector3();
  const bladePosition = new Vector3();
  const bladeOffset = new Vector3();

  return {
    root,

    apply(placements: readonly GrassPlacement[]): void {
      let tuftCount = 0;
      let bladeCount = 0;

      for (const placement of placements) {
        if (tuftCount >= FLORA_GRASS_CAP) break;
        tuftCount++;

        position.set(placement.x, placement.groundY, placement.z);
        tuftRotation.setFromAxisAngle(UP, placement.yaw);

        // The cluster's spread in WORLD units: the offsets are fractions of
        // the cluster span, and `position` is world units (cropModels.ts's
        // identical conversion, and the identical bug if it is skipped).
        const spread = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;

        // Safe without a per-iteration bound check: tuftCount is capped at
        // FLORA_GRASS_CAP above, so bladeCount can advance at most
        // FLORA_GRASS_CAP * GRASS_BLADES_PER_TUFT times — exactly the two
        // meshes' shared instance allocation.
        for (let index = 0; index < GRASS_BLADES_PER_TUFT; index++) {
          const [ox, oz] = GRASS_BLADE_OFFSETS[index]!;
          const blade = grassBladeVariation(placement.cellX, placement.cellY, index);

          bladeOffset
            .set((ox + blade.jitterX) * spread, 0, (oz + blade.jitterZ) * spread)
            .applyQuaternion(tuftRotation);
          bladePosition.copy(position).add(bladeOffset);

          // The blade's OWN yaw, not the tuft's — and since the arch is
          // authored in the blade's local +X, its yaw is also WHICH WAY it
          // leans. That is what makes three blades out of one crown fan
          // outward instead of all falling the same way.
          bladeRotation.setFromAxisAngle(UP, blade.yaw);

          // Height varies per blade, width does not: a blade that grew taller
          // did not also grow wider, and scaling all three axes would read as
          // "the same blade, nearer the camera" (cropModels.ts's own note).
          bladeScale.set(placement.scale, placement.scale * blade.height, placement.scale);

          matrix.compose(bladePosition, bladeRotation, bladeScale);
          blades.setMatrixAt(bladeCount, matrix);
          tips.setMatrixAt(bladeCount++, matrix);
        }
      }

      blades.count = bladeCount;
      tips.count = bladeCount;

      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        // MANDATORY — see models.ts's identical note: the cached bounding
        // sphere is from the PREVIOUS set of matrices, so skipping this makes
        // the meadow vanish once the camera moves past where it used to be.
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
