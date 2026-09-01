// STUMPS, drawn as INSTANCES (GH #195) — what a fire leaves standing where a
// tree used to be. Follows models.ts and fringeModels.ts; see those headers for
// the "why instancing, not per-object meshes" argument, which applies
// identically here and is not restated.
//
// A STUMP IS THE BOTTOM OF A TRUNK, and that is a contract, not a resemblance:
// the radius and the colour below are IMPORTED from models.ts rather than
// chosen here (TRUNK_BOTTOM_RADIUS, TRUNK_COLOR). If the tree's trunk is ever
// retuned, the stump it leaves follows it — the alternative is two numbers that
// agree today, drift apart in one commit, and turn every burn scar into a field
// of little rocks.
//
// TWO DRAW CALLS:
//
//   bark   the charred outside — the trunk colour taken most of the way to
//          black, because this is the ONLY cause of a stump in the game (see
//          ../protocol.ts's stump section) and a stump that is not obviously
//          burnt would be a stump with no story
//   core   the splintered break across the top, in scorched pale heartwood —
//          the one bright face on the object, and the whole reason a stump
//          reads as "snapped off" rather than as a post
//
// The two-tone split is doing the same work BLADE_COLOR/TIP_COLOR does for
// grass: at the distance this camera looks at the ground from, a stump is a few
// pixels, and a dark blob on dark burnt ground is nothing at all. The pale
// break is what makes it an object.
//
// THE BREAK IS JAGGED, and cheaply: the side wall's top rim rises by
// SPLINTER_RISE on alternate radial steps and the cap is stitched to that same
// rim, so the silhouette is a broken edge rather than a sawn one for the cost
// of varying one Y per rim vertex. STUMP_RADIAL_SEGMENTS is ODD, which is what
// makes the alternation fail to close on itself — two adjacent high points meet
// at the seam, so the break does not read as a machined zigzag.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import { FLORA_STUMP_CAP, FLORA_STUMP_SCALE_MAX, STUMP_MAX_REACH_CELLS } from '../protocol.ts';
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
import { TRUNK_BOTTOM_RADIUS, TRUNK_COLOR, TRUNK_HEIGHT } from './models.ts';

// ── Dimensions, in WORLD UNITS — models.ts's unit, because every number here
// is derived from that file's trunk. (fringeModels.ts and grassModels.ts speak
// cells instead; both are correct, and each file states which it is using so a
// reader never has to guess.)

/**
 * How tall a stump stands: the bottom THIRD of TRUNK_HEIGHT — the height a fire
 * burns a trunk down to before the rest of it comes down. Derived from the
 * trunk rather than typed, for the header's reason.
 *
 * The fraction is bounded from BELOW by the meadow, and this is measured rather
 * than guessed: a blade of grass is BLADE_LENGTH_IN_CELLS (0.5 cells = 0.125
 * world units) tall, so a stump at a QUARTER of the trunk — the first value
 * this shipped with — stands 0.1125 units and sits UNDER the grass that grows
 * back around it, which is invisible in exactly the place fires happen. A third
 * gives 0.15, clear of the blade tips with the splinters clear above that.
 *
 * It is bounded from above by the terraces: anything much taller starts casting
 * the silhouette of a post and competing with the band edges the renderer
 * exists to show.
 */
const STUMP_HEIGHT = TRUNK_HEIGHT / 3;

/** How much of the rim rises into a splinter — a quarter of the stump's own height. */
const SPLINTER_RISE = STUMP_HEIGHT / 4;

/**
 * The stump narrows this much from base to break. Barely: over a tenth of a
 * world unit a real trunk hardly tapers at all, and the taper is here only so
 * the pale top face sits inside the silhouette rather than flush with it.
 */
const STUMP_TOP_RADIUS_FRACTION = 0.92;

/**
 * Seven sides. models.ts gives its trunk five ("a trunk is three pixels wide at
 * play distance; six would be waste") — a stump gets two more for one reason:
 * its top face is visible from the camera's usual angle where a standing
 * trunk's never is, and a five-sided pale pentagon reads as a drawn shape
 * rather than as a broken end. Odd, so the splinter alternation does not close
 * on itself (see the header).
 */
const STUMP_RADIAL_SEGMENTS = 7;

/**
 * How far the bark is taken toward black. 0.78 of the way, not all of it: a
 * pure-black stump loses its own shading under the scene's lambert lighting and
 * turns into a silhouette with no form, which is worse than one that is
 * slightly too brown.
 */
const CHAR_MIX = 0.78;

/**
 * The broken face. A scorched pale wood — desaturated and dimmed well below
 * fresh heartwood, because the fire that made this break also licked over it.
 * It is the brightest thing on the object by design; see the header.
 */
const CORE_COLOR = 0x8c7a63;

/** Where one stump stands and how it varies. World units; y is the ground. */
export interface StumpPlacement {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly scale: number;
  readonly yaw: number;
}

export interface StumpModels {
  /** Parent of the instanced meshes; add this to the plugin's layer. */
  readonly root: Group;
  /** Replaces every drawn stump with the given list. Order is irrelevant. */
  apply(placements: readonly StumpPlacement[]): void;
  /** Frees every geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** A flat, non-indexed triangle soup from a plain number list — fringeModels.ts's helper. */
function triangleSoup(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** The rim, shared by the wall and the cap so the two cannot disagree about the break. */
interface Rim {
  readonly cosines: number[];
  readonly sines: number[];
  /** Top Y per radial index — SPLINTER_RISE on the even ones, flat on the odd. */
  readonly topY: number[];
}

function buildRim(): Rim {
  const cosines: number[] = [];
  const sines: number[] = [];
  const topY: number[] = [];
  for (let i = 0; i < STUMP_RADIAL_SEGMENTS; i++) {
    const angle = (i / STUMP_RADIAL_SEGMENTS) * Math.PI * 2;
    cosines.push(Math.cos(angle));
    sines.push(Math.sin(angle));
    topY.push(STUMP_HEIGHT + (i % 2 === 0 ? SPLINTER_RISE : 0));
  }
  return { cosines, sines, topY };
}

/** The two geometries, and what the built stump actually reaches horizontally. */
interface StumpGeometries {
  readonly bark: BufferGeometry;
  readonly core: BufferGeometry;
  /** The furthest the built stump reaches from its own centre, in CELLS. */
  readonly horizontalReachInCells: number;
}

/**
 * Builds one stump: a side wall from the ground to a jagged rim, and a fan cap
 * stitched onto that same rim.
 *
 * WINDING IS EXPLICIT, unlike every other geometry this plugin builds. Grass,
 * crops and the fringe are ribbons drawn with `side: DoubleSide`, so which way
 * their triangles face never mattered; a stump is a closed solid drawn with
 * back-face culling on, and a reversed triangle is an invisible one. Both loops
 * below emit counter-clockwise-from-outside order, which is three's front face.
 */
function buildStump(): StumpGeometries {
  const rim = buildRim();
  const baseRadius = TRUNK_BOTTOM_RADIUS;
  const topRadius = TRUNK_BOTTOM_RADIUS * STUMP_TOP_RADIUS_FRACTION;

  const bark: number[] = [];
  const core: number[] = [];
  const push = (into: number[], ...points: Vector3[]): void => {
    for (const point of points) into.push(point.x, point.y, point.z);
  };

  const basePoint = (i: number): Vector3 =>
    new Vector3(rim.cosines[i]! * baseRadius, 0, rim.sines[i]! * baseRadius);
  const topPoint = (i: number): Vector3 =>
    new Vector3(rim.cosines[i]! * topRadius, rim.topY[i]!, rim.sines[i]! * topRadius);

  for (let i = 0; i < STUMP_RADIAL_SEGMENTS; i++) {
    const j = (i + 1) % STUMP_RADIAL_SEGMENTS;
    const a = basePoint(i);
    const b = basePoint(j);
    const c = topPoint(i);
    const d = topPoint(j);
    // (a, c, b) and (b, c, d) — the order that faces OUTWARD for an angle that
    // increases counter-clockwise about +Y.
    push(bark, a, c, b);
    push(bark, b, c, d);
  }

  // The cap's centre sits at the LOW rim height, not at the high one: the break
  // is a hollow with splinters standing around it, which is what a snapped
  // trunk looks like, rather than a cone with a peak in the middle.
  const centre = new Vector3(0, STUMP_HEIGHT, 0);
  for (let i = 0; i < STUMP_RADIAL_SEGMENTS; i++) {
    const j = (i + 1) % STUMP_RADIAL_SEGMENTS;
    // Descending angle order, which is counter-clockwise seen from ABOVE.
    push(core, centre, topPoint(j), topPoint(i));
  }

  return {
    bark: triangleSoup(bark),
    core: triangleSoup(core),
    horizontalReachInCells: baseRadius / CELL_WORLD_SIZE,
  };
}

/**
 * The lattice fit check — grassModels.ts's assertBladeFitsTuft, for an object
 * with no cluster: a stump is one solid on its own cell, so its whole footprint
 * is its base radius at the largest scale it can roll.
 *
 * Every input is a constant, so this either always holds or never does.
 */
function assertStumpFitsCell(horizontalReachInCells: number): void {
  const worstInCells = horizontalReachInCells * FLORA_STUMP_SCALE_MAX;
  if (worstInCells > STUMP_MAX_REACH_CELLS) {
    throw new RangeError(
      `a stump reaches ${worstInCells.toFixed(3)} cells from its centre, past the ${STUMP_MAX_REACH_CELLS} its cell guarantees`,
    );
  }
}

function lambert(color: number): MeshLambertMaterial {
  // No DoubleSide here, unlike the ribbon models: a stump is a closed solid and
  // back-face culling is half its triangles.
  return new MeshLambertMaterial({ color, flatShading: true });
}

/** TRUNK_COLOR taken CHAR_MIX of the way to black. */
function charred(): number {
  return new Color(TRUNK_COLOR).multiplyScalar(1 - CHAR_MIX).getHex();
}

export function createStumpModels(): StumpModels {
  const built = buildStump();
  assertStumpFitsCell(built.horizontalReachInCells);

  const barkMaterial = lambert(charred());
  const coreMaterial = lambert(CORE_COLOR);
  const bark = new InstancedMesh(built.bark, barkMaterial, FLORA_STUMP_CAP);
  const core = new InstancedMesh(built.core, coreMaterial, FLORA_STUMP_CAP);
  bark.name = 'flora:stump-bark';
  core.name = 'flora:stump-core';
  bark.count = 0;
  core.count = 0;

  const root = new Group();
  root.name = 'flora:stumps';
  root.add(bark);
  root.add(core);

  // Scratch objects, reused across every instance of every rebuild — the
  // identical reasoning models.ts's own scratch objects give.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const up = new Vector3(0, 1, 0);

  /** The box the stumps stand in — the culling sphere's input (GH #257). */
  const extent = createPlacementExtent();
  /** One reach per mesh, in `[bark, core]` order — constants, resolved once at build. */
  const reaches: readonly InstanceReach[] = [built.bark, built.core].map(
    (geometry): InstanceReach => scaledReach(geometryReach(geometry), FLORA_STUMP_SCALE_MAX),
  );

  return {
    root,

    apply(placements: readonly StumpPlacement[]): void {
      let written = 0;
      clearPlacementExtent(extent);
      for (const placement of placements) {
        if (written >= FLORA_STUMP_CAP) break;
        includePlacement(extent, placement.x, placement.groundY, placement.z);
        position.set(placement.x, placement.groundY, placement.z);
        rotation.setFromAxisAngle(up, placement.yaw);
        // Uniform: a stump that grew wider also grew taller, because it is a
        // cross-section of a whole tree that was scaled uniformly (models.ts).
        scale.set(placement.scale, placement.scale, placement.scale);
        matrix.compose(position, rotation, scale);
        bark.setMatrixAt(written, matrix);
        core.setMatrixAt(written++, matrix);
      }

      bark.count = written;
      core.count = written;
      const meshes = [bark, core];
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
      // ONE RANGE PER BUFFER, sized by the live population (GH #262): three's
      // updateBuffer uploads the WHOLE array whenever the range list is empty
      // and never consults mesh.count, so a bare needsUpdate on a CAP-sized
      // buffer re-sends the cap however few instances are standing.
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
        // MANDATORY — see models.ts's identical note: the cached bounding
        // sphere is from the PREVIOUS set of matrices, so skipping this makes
        // the burn scar vanish once the camera moves past where it used to be.
        // Only the DERIVATION changed (GH #257) — see instanceBounds.ts.
        writeInstanceSphere(mesh, extent, reaches[i]!);
      }
    },

    dispose(): void {
      bark.dispose();
      core.dispose();
      built.bark.dispose();
      built.core.dispose();
      barkMaterial.dispose();
      coreMaterial.dispose();
      root.clear();
    },
  };
}
