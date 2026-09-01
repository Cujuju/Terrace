// Grass tufts, drawn as INSTANCES — the meadow's visible half (owner,
// 2026-08-24: "another texture just like the wheat, but green … spawn
// abundantly on all of the green or green-like bands"). Follows cropModels.ts
// to the letter, which follows models.ts; see those headers for the "why
// instancing, not per-object meshes" argument, which applies identically here
// and is not restated.
//
// THREE DRAW CALLS FOR THE WHOLE MEADOW — two for the grass, exactly as a wheat
// field takes two, and one for every flower in it whatever its colour:
//
//   blades    the lower two thirds of every blade, merged into ONE geometry
//             under the deep green
//   tips      the top third, under a lighter, sun-bleached green — the second
//             tone that does for a blade what EAR_COLOR does for a stalk
//   blossoms  the wildflowers (GH #190), white geometry tinted per instance —
//             see the WILDFLOWERS block below for why that is one call and not
//             one per colour
//
// WHY A RIBBON AND NOT A BOX. A crop stalk is a culm — a round stem — so
// cropModels.ts's wheat is built from cylinders. A blade of grass is a flat
// tapering strip, and drawing one as a box costs 12 triangles to say something
// 4 can say. The whole blade here is FIVE triangles: a two-quad ribbon that
// narrows along an arc, plus a single triangle for the point. At the shipped
// cap that is 40 960 tufts × GRASS_BLADES_PER_TUFT × 5 ≈ 1.0M triangles in two
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
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
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
  GRASS_BLADE_HEIGHT_SPREAD,
  GRASS_BLADE_JITTER_IN_CLUSTER_SPANS,
  GRASS_BLADE_OFFSETS,
  GRASS_SCALE_MAX,
  GRASS_TUFT_CLUSTER_CELL_SPAN,
  grassBladeVariation,
  grassFlowerOf,
  grassKey,
  type GrassCell,
} from '../protocol.ts';
import {
  COLOR_FLOATS_PER_INSTANCE,
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
const BLADE_COLOR = 0x3f7a26;
const TIP_COLOR = 0xc8e07a;

/**
 * How tall one blade stands, in CELLS, before its per-blade height roll.
 *
 * TALLER THAN A WHEAT CULM (4 × 0.075 = 0.3 cells in wheatVariants.ts), which
 * is not the relationship a real field has and is the right call anyway. The
 * first version was shorter than wheat on the "crops stand above the meadow
 * they were planted in" argument, and the result could not be seen at all
 * (protocol.ts's tuft-footprint block records the screenshot). What separates
 * a crop from grass in this game is the GOLD against the green, not two
 * centimetres of height, and half a cell is what makes a blade about a dozen
 * pixels tall at the closest zoom instead of two.
 */
const BLADE_LENGTH_IN_CELLS = 0.5;

/**
 * How wide a blade is at the ground, in CELLS. It tapers to a point at the tip.
 *
 * Four times the first version's, for the same reason the length is: at 0.022
 * cells a blade was 0.0055 world units across — well under one pixel at any
 * zoom the game offers, so the whole meadow rendered as faint noise on the
 * ground. A blade is the widest thing in this model at its base and it is what
 * has to catch the light.
 */
const BLADE_BASE_WIDTH_IN_CELLS = 0.09;

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
 * protocol.ts's GRASS_TUFT_MAX_REACH_CELLS. At 0.7 rad (~40°) the built
 * blade's measured reach leaves the planting lattice and its jitter room
 * inside that bound — which assertBladeFitsTuft checks against the geometry
 * this file actually built, rather than against an estimate of it.
 *
 * It is also the constant to REDUCE if a blade tip ever reads badly hanging
 * over a terrace lip — see protocol.ts's named residual on the footprint.
 */
const BLADE_ARCH_RADIANS = 0.7;

/**
 * How sharply the blade narrows: width is (1 − t)^this along the blade. Above
 * 1 the blade holds its width through the middle and narrows late, which is
 * what a grass blade does and what stops the ribbon reading as a triangle.
 */
const BLADE_TAPER_EXPONENT = 1.6;

// ─────────────────────────────────────────────────────────────────────────────
// WILDFLOWERS (GH #190). One more geometry, one more InstancedMesh, and no new
// wire traffic at all — ../protocol.ts's wildflower section is the record of
// why, and none of that argument is restated here.
//
// THE BLOSSOM IS AUTHORED IN BLADE-LOCAL SPACE, at the blade's own tip, which
// is the whole trick: a flowering blade's blossom reuses that blade's instance
// matrix verbatim. No second transform, no way for the flower to drift off its
// stem, and the per-blade height roll carries the flower up with the tip it
// sits on because it scales the identical local coordinates.
//
// ONE DRAW CALL FOR EVERY COLOUR. The petals are white geometry tinted per
// instance through InstancedMesh's instanceColor, so a meadow with five flower
// colours in it still costs exactly one more draw call than a meadow with none.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The flower palette. Tinted per instance, so the length of this list is free —
 * what it costs is legibility, and five is about where a meadow stops reading
 * as "wildflowers" and starts reading as confetti.
 *
 * Chosen against the meadow rather than in isolation, exactly as BLADE_COLOR is
 * chosen against the land ramp: every one of these is high-value and low-green,
 * because what has to survive at distance — once a single blossom is a pixel or
 * two — is VALUE contrast against the green, not hue.
 */
const FLOWER_COLORS: readonly number[] = [
  0xf2e9c4, // cream
  0xe8c25a, // buttercup
  0xd98ab0, // pink campion
  0x9d8ad6, // harebell violet
  0xe0704f, // poppy
];

/**
 * How far a blossom's petals reach from the tip they grow on, in CELLS.
 *
 * AN EIGHTH of the blade's own length, which makes a flower head a quarter of
 * the plant across — roughly a real one's proportion, and about three pixels at
 * the game's closest zoom, which is the same "can it actually be seen" bar the
 * blade's own width had to clear (see BLADE_BASE_WIDTH_IN_CELLS, and the
 * screenshot that forced it).
 *
 * BOUNDED BY THE FOOTPRINT, and it is the binding constraint here rather than a
 * formality. Every unit of this is horizontal reach at the far end of an
 * already-leaning blade, so it stacks on top of the arch, the planting radius
 * and the jitter — and assertBladeFitsTuft checks the BLOSSOM's reach, not just
 * the blade's. A first version at a FIFTH of the blade length was measured, by
 * running that assert against the built geometry, at 0.712 cluster spans
 * against a bound of 0.707: it threw at model construction and would have taken
 * the whole meadow with it. An eighth lands at 0.646, which is margin rather
 * than a near miss.
 */
const BLOSSOM_RADIUS_IN_CELLS = BLADE_LENGTH_IN_CELLS / 8;

/**
 * Where a petal starts, as a fraction of that radius — the flower's eye. Above
 * zero so the petals read as separate petals rather than as a solid disc.
 */
const BLOSSOM_EYE_FRACTION = 0.3;

/** Petals per blossom. Five, for the reason GRASS_BLADE_COUNT is five: an odd ring has no top-down alignment. */
const BLOSSOM_PETAL_COUNT = 5;

/**
 * How much of its own angular share each petal fills, in [0, 1]. Under one so
 * neighbouring petals do not touch, which is what stops the head reading as a
 * disc with notches cut in it.
 */
const BLOSSOM_PETAL_FILL = 0.62;

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
  /**
   * Adds and removes the named tufts, leaving every other tuft's instances
   * untouched (GH #256). The delta path: cost is proportional to the change,
   * not to the meadow, which is what a one-cell uproot arriving at the sculpt
   * rate needs it to be.
   *
   * A sprout for a cell that is already standing REPLACES it rather than
   * duplicating it, which is what makes this safe to call with whatever the
   * server sent without first diffing it against the drawn set.
   */
  applyDelta(sprouted: readonly GrassPlacement[], withered: readonly GrassCell[]): void;
  /** Frees every geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** One blade, split into its base ribbon and its tip point. */
interface BladeGeometries {
  readonly blade: BufferGeometry;
  readonly tip: BufferGeometry;
  /** The furthest the built blade reaches from its own root, horizontally, in CELLS. */
  readonly horizontalReachInCells: number;
  /**
   * Where the blade ENDS, in the blade's own local space — the point a blossom
   * is authored around. Taken from the built spine rather than re-derived from
   * BLADE_ARCH_RADIANS, so a change to the arch moves the flower with the tip
   * instead of leaving it hanging in the air.
   */
  readonly tipCentre: Vector3;
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
    tipCentre: centres[BLADE_SEGMENTS]!.clone(),
  };
}

/** One blossom, and how far it reaches from the blade's root. */
interface BlossomGeometry {
  readonly geometry: BufferGeometry;
  /** The furthest any petal reaches from the BLADE's root, horizontally, in CELLS. */
  readonly horizontalReachInCells: number;
}

/**
 * Builds a flower head around `tipCentre`, in the blade's own local space.
 *
 * The petals lie in the horizontal plane. That is a deliberate simplification
 * rather than a shortcut: this game's camera looks down at the ground from a
 * fixed pitch, so a horizontal head is the orientation that presents its full
 * area to the player at every yaw — and a head tilted to follow the blade's own
 * lean would present an ellipse that thins to nothing at half the compass
 * points, for two more transforms per instance and no visible gain.
 *
 * Each petal is a quad — an inner edge at the eye and an outer edge at the rim —
 * so a blossom is BLOSSOM_PETAL_COUNT × 2 triangles.
 */
function buildBlossom(tipCentre: Vector3): BlossomGeometry {
  const outer = cells(BLOSSOM_RADIUS_IN_CELLS);
  const inner = outer * BLOSSOM_EYE_FRACTION;
  const half = ((Math.PI * 2) / BLOSSOM_PETAL_COUNT) * BLOSSOM_PETAL_FILL * 0.5;

  const positions: number[] = [];
  const at = (radius: number, angle: number): Vector3 =>
    new Vector3(
      tipCentre.x + radius * Math.cos(angle),
      tipCentre.y,
      tipCentre.z + radius * Math.sin(angle),
    );

  for (let i = 0; i < BLOSSOM_PETAL_COUNT; i++) {
    const centre = ((Math.PI * 2) * i) / BLOSSOM_PETAL_COUNT;
    const i0 = at(inner, centre - half);
    const i1 = at(inner, centre + half);
    const o0 = at(outer, centre - half);
    const o1 = at(outer, centre + half);
    for (const point of [i0, o0, o1, i0, o1, i1]) {
      positions.push(point.x, point.y, point.z);
    }
  }

  return {
    geometry: triangleSoup(positions),
    horizontalReachInCells:
      (Math.hypot(tipCentre.x, tipCentre.z) + outer) / CELL_WORLD_SIZE,
  };
}

/** The furthest lattice point a blade is planted at, in cluster spans. */
function plantingRadiusInSpans(): number {
  let radius = 0;
  for (const [ox, oz] of GRASS_BLADE_OFFSETS) {
    radius = Math.max(radius, Math.hypot(ox, oz));
  }
  return radius;
}

/**
 * How far the outermost blade of a tuft is planted from the tuft's centre,
 * INCLUDING its jitter, in world units at unit scale — the horizontal term the
 * culling sphere has to add around the placement box, and the same quantity
 * assertBladeFitsTuft checks against the cell.
 */
function clusterSpreadInWorld(): number {
  return (
    cells(CLUSTER_SPAN_IN_CELLS) *
    (plantingRadiusInSpans() + GRASS_BLADE_JITTER_IN_CLUSTER_SPANS * Math.SQRT2)
  );
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
  const worstInSpans =
    plantingRadiusInSpans() +
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
  const blossom = buildBlossom(built.tipCentre);
  // The BLOSSOM's reach, not the blade's: a flower head sits at the far end of
  // an already-leaning blade, so it is the thing that decides whether a tuft
  // can overhang its cell. Checked against the built geometry, not an estimate
  // of it — assertBladeFitsTuft's own contract.
  assertBladeFitsTuft(Math.max(built.horizontalReachInCells, blossom.horizontalReachInCells));

  const geometries: BufferGeometry[] = [built.blade, built.tip, blossom.geometry];
  // The blossom material is WHITE and carries no colour of its own: every
  // flower's colour arrives per instance through instanceColor below, which is
  // what keeps five colours at one draw call.
  const materials: Material[] = [lambert(BLADE_COLOR), lambert(TIP_COLOR), lambert(0xffffff)];

  const bladeCapacity = FLORA_GRASS_CAP * GRASS_BLADES_PER_TUFT;
  const blades = new InstancedMesh(built.blade, materials[0], bladeCapacity);
  const tips = new InstancedMesh(built.tip, materials[1], bladeCapacity);

  // ONE BLOSSOM PER TUFT AT MOST, so the cap is the tuft cap rather than the
  // blade cap — a hard guarantee that needs no headroom constant and no
  // "skipped because the buffer was full" residual. It costs 40 960 × 64 B
  // ≈ 2.6 MB of matrices next to the meadow's own ≈ 26 MB, which is why the
  // guarantee is worth more than the saving would be.
  const blossoms = new InstancedMesh(blossom.geometry, materials[2], FLORA_GRASS_CAP);
  const blossomColors = new InstancedBufferAttribute(
    new Float32Array(FLORA_GRASS_CAP * COLOR_FLOATS_PER_INSTANCE),
    COLOR_FLOATS_PER_INSTANCE,
  );
  blossoms.instanceColor = blossomColors;

  const meshes = [blades, tips, blossoms];
  blades.name = 'flora:grass-blades';
  tips.name = 'flora:grass-tips';
  blossoms.name = 'flora:grass-blossoms';

  // Resolved once, at build: the palette is a list of literals, so turning it
  // into Colors per instance per rebuild would be pure garbage.
  const flowerColors = FLOWER_COLORS.map((hex) => new Color(hex));

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

  // ───────────────────────────────────────────────────────────────────────────
  // THE SLOT TABLE (GH #256) — what makes a one-cell uproot cost one cell.
  //
  // index.ts's header used to argue that wholesale rebuilds were cheaper than
  // this bookkeeping. That argument was made for the FOREST, where a rebuild is
  // 3 000 composes; it does not survive the meadow, where it is 205 000 matrix
  // writes plus a 28 MB upload, arriving at the sculpt rate. Measured before
  // this table existed (three 0.185.1, headless, median of 15): 5.4 ms at
  // 4 293 tufts, 12.6 ms at 10 846, and 64 ms at FLORA_GRASS_CAP. With it, one
  // uprooted cell is 0.003 ms and 640 B.
  //
  // A TUFT OWNS A CONTIGUOUS RUN of GRASS_BLADES_PER_TUFT blade instances, so
  // one tuft is one slot in every table here and one update range on the wire.
  // Removal is swap-with-last (the drawn ORDER of tufts is irrelevant — nothing
  // reads it), which keeps the live instances packed into [0, count) with no
  // holes, which is what lets `mesh.count` stay the whole story for drawing.
  //
  // The BLOSSOMS need their own slot space rather than sharing the tuft's:
  // only some tufts flower, and giving a flowerless tuft a slot would mean
  // drawing FLORA_GRASS_CAP degenerate flower heads instead of the few thousand
  // real ones. So there is a second swap-remove, and two maps between them.
  // ───────────────────────────────────────────────────────────────────────────

  /** No flower on this tuft — the absent value in `blossomOfSlot`. */
  const NO_BLOSSOM = -1;

  /** Tuft slot of every drawn cell, keyed by grassKey. The delta path's index. */
  const slotOfCell = new Map<number, number>();
  /** The inverse of slotOfCell: which cell each live tuft slot draws. */
  const cellOfSlot: number[] = [];
  /** Blossom slot of each live tuft slot, or NO_BLOSSOM. */
  const blossomOfSlot: number[] = [];
  /** The inverse: which tuft slot owns each live blossom slot. */
  const tuftOfBlossom: number[] = [];

  let tuftCount = 0;
  let blossomCount = 0;

  /**
   * The box the tufts stand in — the culling sphere's input, kept here instead
   * of being re-derived from 205 000 instance matrices (GH #257).
   *
   * GROWS ON A DELTA AND SHRINKS ONLY ON A FULL REBUILD. Uprooting the
   * westernmost tuft in the world leaves the box reaching west until the next
   * full grass message (at most one FLORA_KEEPALIVE_SECONDS away), which costs
   * a little culling and can never hide a tuft that is on screen — the error
   * that matters is the one in the other direction.
   */
  const extent = createPlacementExtent();

  const spread = clusterSpreadInWorld();
  const reachOf = (geometry: BufferGeometry): InstanceReach =>
    scaledReach(
      clusteredReach(geometryReach(geometry), spread, 1 + GRASS_BLADE_HEIGHT_SPREAD),
      GRASS_SCALE_MAX,
    );
  /** One reach per mesh, in `geometries`/`meshes` order — resolved once, at build. */
  const reaches: InstanceReach[] = geometries.map(reachOf);

  /**
   * Writes one tuft's blades and tips into `slot`, and — if this cell flowers —
   * its blossom into `blossomSlot`. Returns whether the blossom slot was used.
   *
   * Writes the ARRAYS only: the caller owns the counts, the tables and the
   * update ranges, because those differ between a full rebuild (one range for
   * everything) and a delta (one range per touched slot).
   */
  const writeTuft = (
    slot: number,
    placement: GrassPlacement,
    blossomSlot: number,
  ): boolean => {
    // Which blade — if any — of this tuft carries a flower. Derived from
    // the cell, never sent (../protocol.ts's wildflower section).
    const flower = grassFlowerOf(placement.cellX, placement.cellY);
    let flowered = false;

    position.set(placement.x, placement.groundY, placement.z);
    tuftRotation.setFromAxisAngle(UP, placement.yaw);

    // The cluster's spread in WORLD units: the offsets are fractions of
    // the cluster span, and `position` is world units (cropModels.ts's
    // identical conversion, and the identical bug if it is skipped).
    const clusterWidth = cells(CLUSTER_SPAN_IN_CELLS) * placement.scale;

    let blade = slot * GRASS_BLADES_PER_TUFT;
    for (let index = 0; index < GRASS_BLADES_PER_TUFT; index++) {
      const [ox, oz] = GRASS_BLADE_OFFSETS[index]!;
      const variation = grassBladeVariation(placement.cellX, placement.cellY, index);

      bladeOffset
        .set((ox + variation.jitterX) * clusterWidth, 0, (oz + variation.jitterZ) * clusterWidth)
        .applyQuaternion(tuftRotation);
      bladePosition.copy(position).add(bladeOffset);

      // The blade's OWN yaw, not the tuft's — and since the arch is
      // authored in the blade's local +X, its yaw is also WHICH WAY it
      // leans. That is what makes three blades out of one crown fan
      // outward instead of all falling the same way.
      bladeRotation.setFromAxisAngle(UP, variation.yaw);

      // Height varies per blade, width does not: a blade that grew taller
      // did not also grow wider, and scaling all three axes would read as
      // "the same blade, nearer the camera" (cropModels.ts's own note).
      bladeScale.set(placement.scale, placement.scale * variation.height, placement.scale);

      matrix.compose(bladePosition, bladeRotation, bladeScale);
      blades.setMatrixAt(blade, matrix);
      tips.setMatrixAt(blade++, matrix);

      // THE SAME MATRIX, not a second one built from the same parts: the
      // blossom's geometry is authored in this blade's local space, so
      // reusing the transform is what guarantees the flower sits on the
      // stem rather than merely near it.
      if (flower !== null && flower.bladeIndex === index) {
        blossoms.setMatrixAt(blossomSlot, matrix);
        const color = flowerColors[Math.floor((flower.tintRoll / 256) * flowerColors.length)]!;
        blossoms.setColorAt(blossomSlot, color);
        flowered = true;
      }
    }

    includePlacement(extent, placement.x, placement.groundY, placement.z);
    return flowered;
  };

  /** Copies one run of instances within an attribute's array — the swap half of swap-remove. */
  const moveInstances = (
    attribute: BufferAttribute,
    from: number,
    to: number,
    count: number,
    floatsPerInstance: number,
  ): void => {
    attribute.array.copyWithin(
      to * floatsPerInstance,
      from * floatsPerInstance,
      (from + count) * floatsPerInstance,
    );
  };

  /** Swap-removes one blossom slot, keeping the live blossoms packed. */
  const removeBlossom = (slot: number): void => {
    const last = blossomCount - 1;
    if (slot !== last) {
      moveInstances(blossoms.instanceMatrix, last, slot, 1, MATRIX_FLOATS_PER_INSTANCE);
      moveInstances(blossomColors, last, slot, 1, COLOR_FLOATS_PER_INSTANCE);
      const owner = tuftOfBlossom[last]!;
      tuftOfBlossom[slot] = owner;
      blossomOfSlot[owner] = slot;
      uploadInstanceRun(blossoms.instanceMatrix, slot, 1, MATRIX_FLOATS_PER_INSTANCE);
      uploadInstanceRun(blossomColors, slot, 1, COLOR_FLOATS_PER_INSTANCE);
    }
    blossomCount = last;
    tuftOfBlossom.length = last;
  };

  /** Swap-removes one cell's tuft. A cell that is not drawn is a no-op. */
  const removeCell = (key: number): void => {
    const slot = slotOfCell.get(key);
    if (slot === undefined) return;
    slotOfCell.delete(key);

    // The blossom goes FIRST, while blossomOfSlot still describes this slot —
    // and its own swap may rewrite the entry of the tuft that is about to move,
    // which the tuft swap below then reads and remaps.
    const blossom = blossomOfSlot[slot]!;
    if (blossom !== NO_BLOSSOM) removeBlossom(blossom);

    const last = tuftCount - 1;
    if (slot !== last) {
      const run = GRASS_BLADES_PER_TUFT;
      moveInstances(blades.instanceMatrix, last * run, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      moveInstances(tips.instanceMatrix, last * run, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);

      const movedKey = cellOfSlot[last]!;
      cellOfSlot[slot] = movedKey;
      slotOfCell.set(movedKey, slot);
      const movedBlossom = blossomOfSlot[last]!;
      blossomOfSlot[slot] = movedBlossom;
      if (movedBlossom !== NO_BLOSSOM) tuftOfBlossom[movedBlossom] = slot;

      uploadInstanceRun(blades.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
      uploadInstanceRun(tips.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
    }

    tuftCount = last;
    cellOfSlot.length = last;
    blossomOfSlot.length = last;
  };

  /**
   * Appends one tuft. Over the cap it is DROPPED, exactly as the wholesale
   * rebuild's `break` dropped it — with one named difference: the wholesale
   * path re-picked WHICH cells lose out on every rebuild, where this one keeps
   * dropping new arrivals until the next full grass message re-picks. The
   * FLORA_KEEPALIVE_SECONDS resend is that re-pick.
   */
  const addCell = (key: number, placement: GrassPlacement): void => {
    if (tuftCount >= FLORA_GRASS_CAP) return;
    const slot = tuftCount++;
    const flowered = writeTuft(slot, placement, blossomCount);

    slotOfCell.set(key, slot);
    cellOfSlot[slot] = key;
    blossomOfSlot[slot] = flowered ? blossomCount : NO_BLOSSOM;
    if (flowered) {
      tuftOfBlossom[blossomCount] = slot;
      uploadInstanceRun(blossoms.instanceMatrix, blossomCount, 1, MATRIX_FLOATS_PER_INSTANCE);
      uploadInstanceRun(blossomColors, blossomCount, 1, COLOR_FLOATS_PER_INSTANCE);
      blossomCount++;
    }

    const run = GRASS_BLADES_PER_TUFT;
    uploadInstanceRun(blades.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
    uploadInstanceRun(tips.instanceMatrix, slot * run, run, MATRIX_FLOATS_PER_INSTANCE);
  };

  /** Publishes the live counts and the culling spheres. Ends every apply, whole or partial. */
  const publish = (): void => {
    blades.count = tuftCount * GRASS_BLADES_PER_TUFT;
    tips.count = blades.count;
    blossoms.count = blossomCount;
    for (let i = 0; i < meshes.length; i++) {
      writeInstanceSphere(meshes[i]!, extent, reaches[i]!);
    }
  };

  return {
    root,

    apply(placements: readonly GrassPlacement[]): void {
      slotOfCell.clear();
      cellOfSlot.length = 0;
      blossomOfSlot.length = 0;
      tuftOfBlossom.length = 0;
      tuftCount = 0;
      blossomCount = 0;
      clearPlacementExtent(extent);

      for (const placement of placements) {
        if (tuftCount >= FLORA_GRASS_CAP) break;
        const key = grassKey(placement.cellX, placement.cellY);
        const slot = tuftCount++;
        const flowered = writeTuft(slot, placement, blossomCount);
        slotOfCell.set(key, slot);
        cellOfSlot[slot] = key;
        blossomOfSlot[slot] = flowered ? blossomCount : NO_BLOSSOM;
        if (flowered) tuftOfBlossom[blossomCount++] = slot;
      }

      publish();
      // ONE RANGE PER BUFFER, sized by the live population rather than by
      // FLORA_GRASS_CAP (GH #262): three uploads the WHOLE array whenever the
      // range list is empty and never consults mesh.count, so a bare
      // needsUpdate on these buffers is a 28 MB bufferSubData whatever is
      // standing. setColorAt writes through instanceColor, which carries its
      // own dirty flag — the matrix ranges do not cover it, and without this
      // every flower renders in whatever colour it had last rebuild.
      uploadAllInstances(blades.instanceMatrix, blades.count, MATRIX_FLOATS_PER_INSTANCE);
      uploadAllInstances(tips.instanceMatrix, tips.count, MATRIX_FLOATS_PER_INSTANCE);
      uploadAllInstances(blossoms.instanceMatrix, blossomCount, MATRIX_FLOATS_PER_INSTANCE);
      uploadAllInstances(blossomColors, blossomCount, COLOR_FLOATS_PER_INSTANCE);
    },

    applyDelta(
      sprouted: readonly GrassPlacement[],
      withered: readonly GrassCell[],
    ): void {
      // Withers first, for the reason index.ts's applyGrassChanges withers
      // first: a message that named the same cell in both ends up with the
      // tuft present, matching the server.
      for (const cell of withered) removeCell(grassKey(cell.x, cell.y));
      for (const placement of sprouted) {
        const key = grassKey(placement.cellX, placement.cellY);
        // A sprout for a cell already standing REPLACES it. Nothing on the
        // wire produces that today for grass, but the alternative is a
        // duplicate tuft that no later wither can ever remove.
        removeCell(key);
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
