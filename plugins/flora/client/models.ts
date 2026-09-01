// Low-poly procedural trees, drawn as INSTANCES.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE DRAW CALLS FOR THREE THOUSAND TREES.
//
// wildlife builds a Group of 2–6 Meshes per creature, which is fine for a
// hundred and fifty of them and would be catastrophic here: at the 3000-tree cap
// that shape is ~9000 draw calls, an order of magnitude past the entire rest of
// the frame. So a tree is not an object at all. There are exactly three
// InstancedMeshes for the whole world —
//
//   trunk            every tree, both kinds
//   conifer crown    the ~60% that are firs
//   broadleaf crown  the rest
//
// — and a tree is one 4×4 matrix written into two of them. The trunk is shared
// between the kinds on purpose: it is the same trunk either way, and sharing it
// turns four instanced meshes into three.
//
// The parts are pre-TRANSLATED into place at build time (a crown sits at its own
// height above the origin inside its geometry), which is what lets one instance
// matrix — position, yaw, uniform scale — place a whole tree consistently across
// two meshes. Without that the crown would need its own matrix with the trunk's
// scale folded into its offset, i.e. the same arithmetic done twice.
//
// COST OF THE CAP: each mesh is allocated for FLORA_TREE_CAP instances up front,
// because either crown could in principle be every tree in the world. That is
// 3 × 3000 × 16 floats × 4 B ≈ 576 KB of instance matrices, held once for the
// life of the plugin. `count` is then set to what is actually in use, so a world
// with nine trees draws nine.
//
// The rules wildlife's models.ts keeps, kept here too: no textures, no per-object
// lights, no external assets, everything generated in this file, flat shading so
// a 6-segment cone reads as a deliberate faceted style rather than as low detail.
// ─────────────────────────────────────────────────────────────────────────────

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
  type BufferGeometry,
  type Material,
} from 'three';
import { FLORA_TREE_CAP, FLORA_TREE_SCALE_MAX, type FloraTreeKind } from '../protocol.ts';
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

// ── Dimensions, in world units. CELL_WORLD_SIZE is 1 (client/src/config.ts) and
// one terrace band is one world unit (MAX_HEIGHT / BAND_HEIGHT = 16 units of
// relief), so these numbers are readable as BOTH cells and bands: a 1.5-unit
// tree is one and a half terraces tall and two thirds of a cell wide. That is
// the proportion the style wants — clearly taller than the step it stands on,
// clearly narrower than the cell it stands in, so a stand of trees never hides
// the terrace edges the renderer exists to show.

/**
 * EXPORTED for ./stumpModels.ts alongside TRUNK_BOTTOM_RADIUS below: a stump is
 * a FRACTION of this, so retuning the tree retunes what fire leaves of it.
 */
export const TRUNK_HEIGHT = 0.45;
const TRUNK_TOP_RADIUS = 0.055;
/**
 * EXPORTED for ./stumpModels.ts (GH #195), which is the one other module that
 * has to agree with this number: a stump is the bottom of a trunk, so a stump
 * drawn at any other radius reads as a rock rather than as the remains of the
 * tree that stood there. Promoted from a local const on the ≥2-modules rule.
 */
export const TRUNK_BOTTOM_RADIUS = 0.085;
/** Five sides. A trunk is three pixels wide at play distance; six would be waste. */
const TRUNK_SEGMENTS = 5;

/**
 * Cone crown: 6-sided, so a fir has a silhouette instead of a circle.
 *
 * EXPORTED alongside the broadleaf pair below for ./occupancy.ts, which
 * evaluates the same cone and sphere ANALYTICALLY to answer "what stands over
 * this cell?" without a raycast (GH #252). One set of numbers, two readers —
 * the drawn tree and the pointable tree cannot be different trees.
 */
export const CONIFER_CROWN_RADIUS = 0.38;
export const CONIFER_CROWN_HEIGHT = 1.05;
export const CONIFER_CROWN_SEGMENTS = 6;

/**
 * Sphere crown, at the same tessellation wildlife's bodies use (6 around, 4
 * tall). Faceted enough to read as a low-poly canopy rather than a ball.
 */
export const BROADLEAF_CROWN_RADIUS = 0.46;
export const BROADLEAF_CROWN_SEGMENTS = 6;
const BROADLEAF_CROWN_RINGS = 4;

/**
 * The broadleaf crown sinks slightly below where its radius would place it, so
 * the sphere overlaps the trunk top instead of balancing tangent to it — a
 * bare sphere-on-cylinder join reads as a seam, and the overlap hides it.
 */
const BROADLEAF_CROWN_TRUNK_OVERLAP = 0.95;

/** Total height either kind reaches at scale 1: 1.5 and ~1.36 world units. */
const CONIFER_CROWN_CENTRE_Y = TRUNK_HEIGHT + CONIFER_CROWN_HEIGHT / 2;
export const BROADLEAF_CROWN_CENTRE_Y = TRUNK_HEIGHT + BROADLEAF_CROWN_RADIUS * BROADLEAF_CROWN_TRUNK_OVERLAP;

/**
 * Colours, picked against the ground each kind stands on rather than in
 * isolation. The land ramp's grass stops are 0x8fc25a / 0x69a244 / 0x467a33
 * (client/src/terrain/bandColors.ts), so a crown has to be darker and bluer than
 * the brightest of them and darker than the darkest, or a tree on band 3 reads
 * as a bump and a tree on band 5 disappears entirely.
 */
/** EXPORTED for ./stumpModels.ts, which chars this exact colour rather than picking its own brown. */
export const TRUNK_COLOR = 0x5a4632;
const CONIFER_CROWN_COLOR = 0x24503a;
const BROADLEAF_CROWN_COLOR = 0x3d6b2c;

/** Where one tree stands and how it varies. World units; y is the ground. */
export interface TreePlacement {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly kind: FloraTreeKind;
  readonly scale: number;
  readonly yaw: number;
}

export interface FloraModels {
  /** Parent of the three instanced meshes; add this to the plugin's layer. */
  readonly root: Group;
  /** Replaces every drawn tree with the given list. Order is irrelevant. */
  apply(placements: readonly TreePlacement[]): void;
  /** Frees every geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** Y axis, for the yaw quaternion. Module-level: it is never mutated. */
const UP = new Vector3(0, 1, 0);

function lambert(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true });
}

export function createFloraModels(): FloraModels {
  // Geometries are built once and pre-translated so the tree's ORIGIN IS ITS
  // FOOT — the same convention wildlife's walkers use, and the one that makes
  // "stand it on the terrain height" a single assignment at the call site.
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

  const broadleafGeometry = new SphereGeometry(
    BROADLEAF_CROWN_RADIUS,
    BROADLEAF_CROWN_SEGMENTS,
    BROADLEAF_CROWN_RINGS,
  );
  broadleafGeometry.translate(0, BROADLEAF_CROWN_CENTRE_Y, 0);

  const geometries: BufferGeometry[] = [trunkGeometry, coniferGeometry, broadleafGeometry];
  const materials: Material[] = [
    lambert(TRUNK_COLOR),
    lambert(CONIFER_CROWN_COLOR),
    lambert(BROADLEAF_CROWN_COLOR),
  ];

  const trunks = new InstancedMesh(trunkGeometry, materials[0], FLORA_TREE_CAP);
  const conifers = new InstancedMesh(coniferGeometry, materials[1], FLORA_TREE_CAP);
  const broadleaves = new InstancedMesh(broadleafGeometry, materials[2], FLORA_TREE_CAP);

  const meshes = [trunks, conifers, broadleaves];
  trunks.name = 'flora:trunks';
  conifers.name = 'flora:conifers';
  broadleaves.name = 'flora:broadleaves';

  const root = new Group();
  root.name = 'flora:trees';
  for (const mesh of meshes) {
    // Nothing is drawn until the first apply(); an InstancedMesh with count 0 is
    // skipped by the renderer entirely.
    mesh.count = 0;
    root.add(mesh);
  }

  // Scratch objects, reused across every instance of every rebuild. Allocating
  // per tree would be 9000 short-lived objects per rebuild, which is exactly the
  // kind of churn a rebuild-on-every-sculpt design cannot afford.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  /**
   * The box each mesh's trees stand in — the culling sphere's input (GH #257).
   * THREE boxes, not one: a valley of conifers and a ridge of broadleaves are
   * different regions, and a shared box would give each crown mesh the other's
   * extent for nothing.
   */
  const extents = [createPlacementExtent(), createPlacementExtent(), createPlacementExtent()];
  /** One reach per mesh, in `meshes` order — all constants, so resolved once at build. */
  const reaches: InstanceReach[] = geometries.map(
    (geometry): InstanceReach => scaledReach(geometryReach(geometry), FLORA_TREE_SCALE_MAX),
  );

  return {
    root,

    apply(placements: readonly TreePlacement[]): void {
      let trunkCount = 0;
      let coniferCount = 0;
      let broadleafCount = 0;
      for (const extent of extents) clearPlacementExtent(extent);

      for (const placement of placements) {
        if (trunkCount >= FLORA_TREE_CAP) break;

        position.set(placement.x, placement.groundY, placement.z);
        rotation.setFromAxisAngle(UP, placement.yaw);
        scale.setScalar(placement.scale);
        matrix.compose(position, rotation, scale);

        trunks.setMatrixAt(trunkCount++, matrix);
        includePlacement(extents[0]!, placement.x, placement.groundY, placement.z);
        if (placement.kind === 'conifer') {
          conifers.setMatrixAt(coniferCount++, matrix);
          includePlacement(extents[1]!, placement.x, placement.groundY, placement.z);
        } else {
          broadleaves.setMatrixAt(broadleafCount++, matrix);
          includePlacement(extents[2]!, placement.x, placement.groundY, placement.z);
        }
      }

      trunks.count = trunkCount;
      conifers.count = coniferCount;
      broadleaves.count = broadleafCount;

      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i]!;
      // ONE RANGE PER BUFFER, sized by the live population (GH #262): three's
      // updateBuffer uploads the WHOLE array whenever the range list is empty
      // and never consults mesh.count, so a bare needsUpdate on a CAP-sized
      // buffer re-sends the cap however few instances are standing.
        uploadAllInstances(mesh.instanceMatrix, mesh.count, MATRIX_FLOATS_PER_INSTANCE);
        // MANDATORY, not tidiness: frustum culling tests an InstancedMesh
        // against its own cached bounding sphere, which was computed from the
        // PREVIOUS set of matrices. Skipping this makes a forest vanish when
        // the camera moves past where the trees used to be — it is only the
        // DERIVATION that changed (GH #257), from a read-back of every matrix
        // to the placement box the loop above already accumulated.
        writeInstanceSphere(mesh, extents[i]!, reaches[i]!);
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
