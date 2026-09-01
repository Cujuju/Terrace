// Shore reeds and alpine heather, drawn as INSTANCES (GH #192, #194) — the
// fringe's visible half. Follows grassModels.ts to the letter, which follows
// cropModels.ts, which follows models.ts; see those headers for the "why
// instancing, not per-object meshes" argument, which applies identically here
// and is not restated.
//
// ONE BUILDER, TWO SPECIES. Both plants are the same thing geometrically — a
// tapering ribbon that arcs — and differ only in how long, how wide, how hard
// they bend and what colour they are. That is a parameter set, not a second
// builder, and buildStem takes it as one. What would justify a second builder
// is a second SHAPE (a woody stem, a berry, a leaf), and neither of these is.
//
// FOUR DRAW CALLS, two per species:
//
//   reed base / reed tip        tall, narrow, barely bent, dark blue-green,
//                               with a bleached seed-head tone at the top
//   heather base / heather tip  short, wide, hard-bent, dull olive, with a
//                               purple flowering tone at the top
//
// The two-tone split is not decoration: it is what makes either plant legible
// once a stem stops resolving into pixels, exactly as BLADE_COLOR against
// TIP_COLOR is for grass. The heather's purple is doing the most work of the
// four — it is the only strong hue above the treeline, and it is what stops the
// rock bands reading as bare.
//
// EVERY STEM IS ITS OWN PLANT, exactly as every blade of grass is: its own yaw
// (which is also which way it arcs), its own height, its own nudge off the
// lattice (../protocol.ts's fringeStemVariation) on top of the plant-wide yaw
// and scale.
//
// WHY THE INSTANCE BUFFERS ARE SIZED PER SPECIES, at FLORA_FRINGE_CAP × that
// species' own stem count, rather than from one shared pool: the two species
// cannot be told apart until the ground under a cell is known, so a shared pool
// would have to be sized for the worst case anyway — and a per-species buffer
// is the version where "the buffer cannot overrun" is arithmetic rather than a
// runtime bound check. The bill is in ../protocol.ts's fringe arithmetic.

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
  FLORA_FRINGE_CAP,
  FRINGE_CLUSTER_CELL_SPAN,
  FRINGE_SCALE_MAX,
  FRINGE_STEM_HEIGHT_SPREAD,
  FRINGE_STEM_JITTER_IN_SPANS,
  fringeKey,
  fringeStemOffsets,
  fringeStemVariation,
  type FringeCell,
  type FringeSpecies,
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
  type PlacementExtent,
} from './instanceBounds.ts';

/** One CELL's worth of world units — the unit every dimension below speaks. */
const cells = (n: number): number => n * CELL_WORLD_SIZE;

/** The square a plant's stems are planted in. Derived in ../protocol.ts, not here. */
const CLUSTER_SPAN_IN_CELLS = FRINGE_CLUSTER_CELL_SPAN;

/** Half the diagonal of a unit square — grassModels.ts's own restatement, for the same fit check. */
const SQUARE_CIRCUMRADIUS_PER_EDGE = Math.SQRT2 / 2;

const UP = new Vector3(0, 1, 0);
/** The axis a stem bends about: the arc is authored in the stem's local X-Y plane. */
const BEND_AXIS = new Vector3(0, 0, 1);
/** A stem's width runs along local Z, perpendicular to the plane it arcs in. */
const WIDTH_AXIS = new Vector3(0, 0, 1);

/** Everything that makes one species' stem its own shape. */
interface StemShape {
  /** How tall one stem stands, in CELLS, before its per-stem height roll. */
  readonly lengthInCells: number;
  /** How wide it is at the ground, in CELLS. It tapers to a point. */
  readonly baseWidthInCells: number;
  /** Cross-sections along it — also what sets the triangle count. */
  readonly segments: number;
  /** How many of those belong to the TIP geometry (the second tone). */
  readonly tipSegments: number;
  /** Total lean from vertical at the tip, in radians, spread evenly across the segments. */
  readonly archRadians: number;
  /** Width is (1 − t)^this along the stem. Above 1 narrows late, which is what a leaf does. */
  readonly taperExponent: number;
  readonly baseColor: number;
  readonly tipColor: number;
}

/**
 * A REED. Tall and nearly straight — a reed's whole silhouette is verticality,
 * and it is the one plant in this game that is meant to stand ABOVE the
 * waterline it grows in rather than hug the ground.
 *
 * Longer than a blade of grass (0.5 cells) at 0.85, because it has to read at
 * the same distance while standing on the flattest, most featureless ground in
 * the world — a beach has no silhouette of its own to be seen against. The arch
 * is a quarter of grass's for the same reason, and because every radian of it is
 * footprint (see assertStemFitsPlant).
 *
 * The tip tone is the seed head: two of six segments, bleached almost to straw,
 * which is what a reed bed actually looks like from any distance at which the
 * individual stems have stopped resolving.
 */
const REED: StemShape = {
  lengthInCells: 0.85,
  baseWidthInCells: 0.07,
  segments: 6,
  tipSegments: 2,
  archRadians: 0.18,
  taperExponent: 2.2,
  baseColor: 0x2f5d46,
  tipColor: 0xbfae74,
};

/**
 * HEATHER. Short, wide and hard-bent — a mound rather than a stand, which is the
 * whole difference between something growing on a mountainside and something
 * growing beside water.
 *
 * Shorter than grass at 0.3 cells and bent nearly twice as hard (1.1 rad, about
 * 63°), so a plant's seven sprigs splay outward into a cushion. That is what
 * exposed high ground does to a plant, and it is also what stops heather reading
 * as the meadow simply carrying on over the rock — the one artefact GH #194
 * exists to avoid.
 *
 * The tip tone is the flower: three of five segments, so better than half of
 * every sprig is purple. That is far more than a real plant and it is
 * deliberate — this is the only strong hue above the treeline, and at the
 * distance the camera sees the rock bands from, a thin purple fringe on an olive
 * cushion would simply disappear.
 */
const HEATHER: StemShape = {
  lengthInCells: 0.3,
  baseWidthInCells: 0.06,
  segments: 5,
  tipSegments: 3,
  archRadians: 1.1,
  taperExponent: 1.2,
  baseColor: 0x4a5637,
  tipColor: 0x9a5fa8,
};

const SHAPES: Readonly<Record<FringeSpecies, StemShape>> = { reed: REED, heather: HEATHER };

/** Where one fringe plant stands and how its whole cluster varies. World units; y is the ground. */
export interface FringePlacement {
  readonly x: number;
  readonly z: number;
  /** The CELL it stands on — the per-stem rolls hash integer cells, not world units. */
  readonly cellX: number;
  readonly cellY: number;
  readonly groundY: number;
  readonly species: FringeSpecies;
  readonly scale: number;
  readonly yaw: number;
}

export interface FringeModels {
  /** Parent of the instanced meshes; add this to the plugin's layer. */
  readonly root: Group;
  /** Replaces every drawn plant with the given list. Order is irrelevant. */
  apply(placements: readonly FringePlacement[]): void;
  /**
   * Adds and removes the named plants, leaving every other plant's instances
   * untouched (GH #260) — grassModels.ts's applyDelta, for the fringe, and for
   * the same reason: the shoreline delta that arrives at the sculpt rate is one
   * cell, and it was costing a whole rebuild.
   *
   * A sprout for a cell already standing REPLACES it, which is not a defensive
   * nicety here: a fringe cell changes SPECIES as a bare sprout with no
   * matching wither (server/fringe.ts's advance), so this is the only thing
   * that moves the plant out of the old species' buffer.
   */
  applyDelta(sprouted: readonly FringePlacement[], withered: readonly FringeCell[]): void;
  /** Frees every geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** One stem, split into its base ribbon and its tip. */
interface StemGeometries {
  readonly base: BufferGeometry;
  readonly tip: BufferGeometry;
  /** The furthest the built stem reaches from its own root, horizontally, in CELLS. */
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
 * Builds one stem: walk the arc, emit a pair of edge vertices per cross-section,
 * then stitch consecutive pairs into triangles. grassModels.ts's buildBlade,
 * parameterised — the shape argument is the only difference between a reed and a
 * sprig of heather.
 */
function buildStem(shape: StemShape): StemGeometries {
  const segmentLength = cells(shape.lengthInCells) / shape.segments;
  const bendPerSegment = shape.archRadians / shape.segments;
  const halfBaseWidth = cells(shape.baseWidthInCells) / 2;

  const centres: Vector3[] = [new Vector3(0, 0, 0)];
  const position = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 1, 0);
  for (let i = 0; i < shape.segments; i++) {
    position.addScaledVector(direction, segmentLength);
    centres.push(position.clone());
    direction.applyAxisAngle(BEND_AXIS, -bendPerSegment).normalize();
  }

  const halfWidths: number[] = [];
  for (let i = 0; i <= shape.segments; i++) {
    const t = i / shape.segments;
    halfWidths.push(halfBaseWidth * Math.pow(1 - t, shape.taperExponent));
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

  const firstTipSegment = shape.segments - shape.tipSegments;
  for (let i = 0; i < shape.segments; i++) {
    const into = i >= firstTipSegment ? tipPositions : basePositions;
    const l0 = left(i);
    const r0 = right(i);
    const l1 = left(i + 1);
    const r1 = right(i + 1);
    // The last cross-section has zero width, so its two edge vertices are the
    // same point and the segment is ONE triangle — buildBlade's own note.
    if (halfWidths[i + 1] === 0) {
      push(into, l0, r0, l1);
    } else {
      push(into, l0, r0, l1);
      push(into, r0, r1, l1);
    }
  }

  let horizontalReach = 0;
  for (let i = 0; i <= shape.segments; i++) {
    const reach = Math.hypot(centres[i]!.x, centres[i]!.z) + halfWidths[i]!;
    horizontalReach = Math.max(horizontalReach, reach);
  }

  return {
    base: triangleSoup(basePositions),
    tip: triangleSoup(tipPositions),
    horizontalReachInCells: horizontalReach / CELL_WORLD_SIZE,
  };
}

/** The furthest lattice point a stem is planted at, in cluster spans. */
function plantingRadiusInSpans(species: FringeSpecies): number {
  let radius = 0;
  for (const [ox, oz] of fringeStemOffsets(species)) {
    radius = Math.max(radius, Math.hypot(ox, oz));
  }
  return radius;
}

/**
 * How far the outermost stem of a plant is planted from its centre, INCLUDING
 * its jitter, in world units at unit scale — the horizontal term the culling
 * sphere adds around the placement box, and the same quantity
 * assertStemFitsPlant checks against the cell.
 */
function clusterSpreadInWorld(species: FringeSpecies): number {
  return (
    cells(CLUSTER_SPAN_IN_CELLS) *
    (plantingRadiusInSpans(species) + FRINGE_STEM_JITTER_IN_SPANS * Math.SQRT2)
  );
}

/**
 * The cluster's worst-case reach from the plant's centre, checked against the
 * square it has to stay inside — grassModels.ts's assertBladeFitsTuft, run once
 * per species because the two have different stem counts, different planting
 * radii and different arcs, so they clear the bound by different margins.
 *
 * Every input is a constant, so this either always holds or never does.
 */
function assertStemFitsPlant(species: FringeSpecies, horizontalReachInCells: number): void {
  const worstInSpans =
    plantingRadiusInSpans(species) +
    FRINGE_STEM_JITTER_IN_SPANS * Math.SQRT2 +
    horizontalReachInCells / CLUSTER_SPAN_IN_CELLS;

  if (worstInSpans > SQUARE_CIRCUMRADIUS_PER_EDGE) {
    throw new RangeError(
      `a ${species} stem reaches ${worstInSpans.toFixed(3)} cluster spans from its plant centre, past the ${SQUARE_CIRCUMRADIUS_PER_EDGE.toFixed(3)} its cell guarantees`,
    );
  }
}

function lambert(color: number): MeshLambertMaterial {
  // DoubleSide because a stem is a ribbon with no thickness — grassModels.ts's note.
  return new MeshLambertMaterial({ color, flatShading: true, side: DoubleSide });
}

/**
 * One species' pair of meshes, the stem lattice they are drawn on, and the slot
 * table that makes a one-cell delta cost one cell (GH #260).
 *
 * PER SPECIES because the buffers are per species: a plant owns a contiguous
 * run of `offsets.length` stem instances in ITS OWN species' base and tip
 * meshes, so a cell that changes species moves between two slot spaces rather
 * than within one. grassModels.ts's slot-table block is the full argument;
 * everything there applies here, minus the blossoms.
 */
interface SpeciesMeshes {
  readonly base: InstancedMesh;
  readonly tip: InstancedMesh;
  readonly offsets: ReadonlyArray<readonly [number, number]>;
  /** Slot of every drawn cell of this species, keyed by fringeKey. */
  readonly slotOfCell: Map<number, number>;
  /** The inverse: which cell each live slot draws. */
  readonly cellOfSlot: number[];
  /** The box this species' plants stand in — the culling sphere's input. */
  readonly extent: PlacementExtent;
  /** Reach of one plant around its own placement, for the base and tip meshes. */
  readonly reaches: readonly [InstanceReach, InstanceReach];
  /** Live plants of this species — the slot high-water mark, packed with no holes. */
  written: number;
}

/** Both species, in the order every loop over them uses. */
const SPECIES: readonly FringeSpecies[] = ['reed', 'heather'];

export function createFringeModels(): FringeModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const meshes: InstancedMesh[] = [];
  const bySpecies = {} as Record<FringeSpecies, SpeciesMeshes>;

  const root = new Group();
  root.name = 'flora:fringe';

  for (const species of SPECIES) {
    const shape = SHAPES[species];
    const built = buildStem(shape);
    assertStemFitsPlant(species, built.horizontalReachInCells);

    const offsets = fringeStemOffsets(species);
    // Per species, at the cap × ITS OWN stem count — see the header for why
    // this is arithmetic rather than a runtime bound check.
    const capacity = FLORA_FRINGE_CAP * offsets.length;

    const baseMaterial = lambert(shape.baseColor);
    const tipMaterial = lambert(shape.tipColor);
    const base = new InstancedMesh(built.base, baseMaterial, capacity);
    const tip = new InstancedMesh(built.tip, tipMaterial, capacity);
    base.name = `flora:fringe-${species}-base`;
    tip.name = `flora:fringe-${species}-tip`;

    geometries.push(built.base, built.tip);
    materials.push(baseMaterial, tipMaterial);
    meshes.push(base, tip);

    // Resolved once, at build: the reach is all constants (the stem geometry,
    // the planting lattice, the height and scale rolls' ceilings), so deriving
    // it per rebuild would be arithmetic on numbers that cannot have changed.
    const spread = clusterSpreadInWorld(species);
    const reachOf = (geometry: BufferGeometry): InstanceReach =>
      scaledReach(
        clusteredReach(geometryReach(geometry), spread, 1 + FRINGE_STEM_HEIGHT_SPREAD),
        FRINGE_SCALE_MAX,
      );
    bySpecies[species] = {
      base,
      tip,
      offsets,
      slotOfCell: new Map(),
      cellOfSlot: [],
      extent: createPlacementExtent(),
      reaches: [reachOf(built.base), reachOf(built.tip)],
      written: 0,
    };

    base.count = 0;
    tip.count = 0;
    root.add(base);
    root.add(tip);
  }

  // Scratch objects, reused across every instance of every rebuild — the
  // identical reasoning grassModels.ts's own scratch objects give.
  const matrix = new Matrix4();
  const position = new Vector3();
  const plantRotation = new Quaternion();
  const stemRotation = new Quaternion();
  const stemScale = new Vector3();
  const stemPosition = new Vector3();
  const stemOffset = new Vector3();

  /** Plants standing across BOTH species — what FLORA_FRINGE_CAP bounds. */
  const plantCount = (): number => bySpecies.reed.written + bySpecies.heather.written;

  /**
   * Writes one plant's stems into `slot` of its own species' meshes. Writes the
   * ARRAYS only: the caller owns the counts, the tables and the update ranges.
   */
  const writePlant = (target: SpeciesMeshes, slot: number, placement: FringePlacement): void => {
    position.set(placement.x, placement.groundY, placement.z);
    plantRotation.setFromAxisAngle(UP, placement.yaw);

    // The cluster's spread in WORLD units: the offsets are fractions of the
    // cluster span, and `position` is world units.
    const clusterWidth = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;

    let stemSlot = slot * target.offsets.length;
    for (let index = 0; index < target.offsets.length; index++) {
      const [ox, oz] = target.offsets[index]!;
      const stem = fringeStemVariation(placement.cellX, placement.cellY, index);

      stemOffset
        .set((ox + stem.jitterX) * clusterWidth, 0, (oz + stem.jitterZ) * clusterWidth)
        .applyQuaternion(plantRotation);
      stemPosition.copy(position).add(stemOffset);

      // The stem's OWN yaw, which — since the arch is authored in its local
      // +X — is also WHICH WAY it leans. That is what fans a heather cushion
      // outward instead of toppling every sprig the same way.
      stemRotation.setFromAxisAngle(UP, stem.yaw);

      // Height varies per stem, width does not: a stem that grew taller did
      // not also grow wider (grassModels.ts's own note).
      stemScale.set(placement.scale, placement.scale * stem.height, placement.scale);

      matrix.compose(stemPosition, stemRotation, stemScale);
      target.base.setMatrixAt(stemSlot, matrix);
      target.tip.setMatrixAt(stemSlot++, matrix);
    }

    includePlacement(target.extent, placement.x, placement.groundY, placement.z);
  };

  /** Copies one run of instances within an attribute's array — the swap half of swap-remove. */
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

  /** Swap-removes one cell from whichever species holds it. A cell not drawn is a no-op. */
  const removeCell = (key: number): void => {
    for (const species of SPECIES) {
      const target = bySpecies[species];
      const slot = target.slotOfCell.get(key);
      if (slot === undefined) continue;
      target.slotOfCell.delete(key);

      const last = target.written - 1;
      const run = target.offsets.length;
      if (slot !== last) {
        moveInstances(target.base.instanceMatrix, last * run, slot * run, run);
        moveInstances(target.tip.instanceMatrix, last * run, slot * run, run);

        const movedKey = target.cellOfSlot[last]!;
        target.cellOfSlot[slot] = movedKey;
        target.slotOfCell.set(movedKey, slot);

        uploadInstanceRun(
          target.base.instanceMatrix,
          slot * run,
          run,
          MATRIX_FLOATS_PER_INSTANCE,
        );
        uploadInstanceRun(target.tip.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      }

      target.written = last;
      target.cellOfSlot.length = last;
      return;
    }
  };

  /**
   * Appends one plant to its species. The CALLER checks the shared cap, because
   * only the caller knows whether it is mid-rebuild or mid-delta — over the cap
   * a plant is dropped, exactly as the wholesale rebuild's `break` dropped it
   * (grassModels.ts's addCell records the one named difference).
   */
  const addCell = (key: number, placement: FringePlacement): void => {
    const target = bySpecies[placement.species];
    const slot = target.written++;
    writePlant(target, slot, placement);
    target.slotOfCell.set(key, slot);
    target.cellOfSlot[slot] = key;

    const run = target.offsets.length;
    uploadInstanceRun(target.base.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
    uploadInstanceRun(target.tip.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
  };

  /** Publishes the live counts and the culling spheres. Ends every apply, whole or partial. */
  const publish = (): void => {
    for (const species of SPECIES) {
      const target = bySpecies[species];
      const drawn = target.written * target.offsets.length;
      target.base.count = drawn;
      target.tip.count = drawn;
      writeInstanceSphere(target.base, target.extent, target.reaches[0]);
      writeInstanceSphere(target.tip, target.extent, target.reaches[1]);
    }
  };

  return {
    root,

    apply(placements: readonly FringePlacement[]): void {
      for (const species of SPECIES) {
        const target = bySpecies[species];
        target.slotOfCell.clear();
        target.cellOfSlot.length = 0;
        target.written = 0;
        clearPlacementExtent(target.extent);
      }

      for (const placement of placements) {
        // ONE CAP ACROSS BOTH SPECIES, matching the server's own field: the two
        // share FLORA_FRINGE_CAP, so counting them together is what makes the
        // per-species buffers provably sufficient.
        if (plantCount() >= FLORA_FRINGE_CAP) break;
        addCell(fringeKey(placement.cellX, placement.cellY), placement);
      }

      publish();
      // ONE RANGE PER BUFFER, sized by the live population rather than by
      // FLORA_FRINGE_CAP (GH #262): three uploads the WHOLE array whenever the
      // range list is empty and never consults mesh.count, so a bare
      // needsUpdate on these four buffers is a 10.49 MB bufferSubData whatever
      // is standing.
      for (const mesh of meshes) {
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
      }
    },

    applyDelta(
      sprouted: readonly FringePlacement[],
      withered: readonly FringeCell[],
    ): void {
      // Withers first, for the reason index.ts's applyFringeChanges withers
      // first — and a sprout onto a standing cell removes it from whichever
      // species holds it before adding, which is how a species change lands.
      for (const cell of withered) removeCell(fringeKey(cell.x, cell.y));
      for (const placement of sprouted) {
        const key = fringeKey(placement.cellX, placement.cellY);
        removeCell(key);
        if (plantCount() >= FLORA_FRINGE_CAP) continue;
        addCell(key, placement);
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
