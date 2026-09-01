// skiffModels.ts — the Three.js rendering half of card 33's skiffs; see
// skiffs.ts for the placement/animation-parameter math this file consumes,
// and its own banner for why skiffs exist purely client-side.
//
// EVERY BOAT IS A SIMPLE LOW-POLY PROP, deliberately much simpler than the
// standing buildings in models.ts: a skiff is ambient background dressing
// glimpsed bobbing on the water at the game's orbit-camera distance, not a
// hero asset a player walks up to — see models.ts's own file banner for the
// "this game's camera looks down from an 80+ cell orbit" reasoning that
// birds and fish already rely on for the same simplification.
//
// PER-FRAME MATRIX REWRITE, not a static apply()-only instance buffer like
// every building mesh in this plugin: a skiff's position changes every
// frame (it orbits its anchor and bobs), so animate() recomputes every
// instance's transform every frame it has any skiffs to draw — not just
// once per founding/upgrade/demolition the way models.ts's apply() does.
// The instance COUNT still only changes on apply() (a new or lost coastal
// settlement), so animate() is a no-op the instant there are zero skiffs —
// no idle per-frame cost on an all-inland world.
//
// WHAT A FRAME MAY COST, THEN, IS ONE MATRIX WRITE PER LIVE SKIFF AND AN
// UPLOAD OF EXACTLY THOSE MATRICES — nothing that scales with the CAPACITY.
// Two things used to make it scale with capacity anyway, and both are fixed
// below rather than accepted: an instanceMatrix with no update range makes
// three re-upload the whole 1 536-instance array however few boats are afloat
// (see writeFrame's own note), and computeBoundingSphere() re-derives that
// whole array's transforms to answer a question the anchors already answer
// (see refreshBoundingSphere, which is why the sphere is an apply()-time
// derivation and not a per-frame measurement).

import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Sphere,
  Vector3,
} from 'three';
import { CELL_WORLD_SIZE, SEA_LEVEL } from '@terrace/shared';
import { STRUCTURES_CAP } from '../protocol.ts';
import { SKIFF_MAX_PER_SETTLEMENT, SKIFF_ORBIT_PERIOD_SECONDS, type SkiffPlacement } from './skiffs.ts';

const FULL_TURN_RADIANS = Math.PI * 2;
/** Floats one instance matrix occupies in an InstancedMesh's instanceMatrix array. */
const MATRIX_ELEMENT_COUNT = 16;

/**
 * World-space Y a skiff floats at, before its own small bob
 * (SKIFF_BOB_AMPLITUDE_WORLD_UNITS below).
 *
 * Own copy of the reasoning plugins/wildlife/client/placement.ts's
 * SEA_SURFACE_WORLD_Y states in full (own copy per plugin — see this
 * plugin's protocol.ts header on why every plugin keeps its own): SEA_LEVEL
 * is 0 by definition, and the renderer draws the sea surface at
 * `SEA_LEVEL * scale + a lift far smaller than any clearance here`
 * (client/src/render/water.ts), so world Y = 0 is where the surface actually
 * sits. The `: 0` annotation stops this compiling the day SEA_LEVEL becomes
 * anything else, which is exactly when this reasoning stops holding.
 */
const SKIFF_FLOAT_WORLD_Y: 0 = SEA_LEVEL;

/** How far a skiff bobs above/below its resting float line, in world units. Small: a ripple, not a swell. */
const SKIFF_BOB_AMPLITUDE_WORLD_UNITS = 0.02;
/** Seconds for one full bob cycle (down-up-down). Distinct from every skiff's own orbit period, so bobbing never lines up with orbiting into a repeating combined cycle a player could clock. */
const SKIFF_BOB_PERIOD_SECONDS = 2.6;

const SKIFF_HULL_COLOR = 0x6b4a30;
const SKIFF_THWART_COLOR = 0x4a3220;

/**
 * Instance capacity: every live structure could in principle be a maxed-out
 * coastal settlement (STRUCTURES_CAP, protocol.ts) floating the maximum
 * skiff count (SKIFF_MAX_PER_SETTLEMENT, skiffs.ts) — the same "assume the
 * worst case, allocate once" trade every InstancedMesh in this plugin makes
 * (see models.ts's identical comment on its own tier meshes). 512 x 3 = 1536
 * instances of a two-part, few-hundred-vertex prop is trivial GPU cost next
 * to the building meshes already allocated at this same worst case.
 */
const SKIFF_INSTANCE_CAPACITY = STRUCTURES_CAP * SKIFF_MAX_PER_SETTLEMENT;

interface SkiffPart {
  readonly geometry: BoxGeometry;
  readonly material: MeshLambertMaterial;
  /**
   * Where this part sits in the boat's own frame — an OFFSET, not a matrix,
   * because every one of them only ever was a translation (the two builders
   * below both call what used to be `Matrix4().makeTranslation`). Naming it as
   * a translation is what lets writeFrame() compose the instance matrix by
   * hand instead of multiplying two 4x4s per part per skiff per frame: a pure
   * translation cannot smuggle a rotation or a scale past that shortcut.
   */
  readonly localOffsets: readonly Vector3[];
}

/**
 * Two parts: a hull and a single thwart (bench) crossbar — enough to read as
 * "a small rowboat" at gameplay distance without the tapered bow/stern
 * carpentry the standing buildings invest in (see the file banner). The
 * hull's length runs along local +Z, matching every other "front" convention
 * in this plugin (models.ts's doors/windows), so a skiff's yaw can reuse the
 * exact same axis-angle-about-Y convention circleRingMatrices already uses.
 */
function buildSkiffParts(): SkiffPart[] {
  const hullLength = 0.36;
  const hullWidth = 0.14;
  const hullHeight = 0.06;
  const hull: SkiffPart = {
    geometry: new BoxGeometry(hullWidth, hullHeight, hullLength),
    material: new MeshLambertMaterial({ color: SKIFF_HULL_COLOR, flatShading: true }),
    localOffsets: [new Vector3(0, hullHeight / 2, 0)],
  };
  const thwart: SkiffPart = {
    geometry: new BoxGeometry(hullWidth * 0.75, 0.025, 0.02),
    material: new MeshLambertMaterial({ color: SKIFF_THWART_COLOR, flatShading: true }),
    localOffsets: [new Vector3(0, hullHeight + 0.012, 0)],
  };
  return [hull, thwart];
}

/**
 * How far one part's geometry reaches from the boat's own origin, in world
 * units — the radius of a sphere at the skiff's position that certainly
 * contains it, whatever its yaw.
 *
 * Yaw is a rotation about Y through the origin, so it moves a part's offset
 * around a circle of that offset's own length and never further out than it
 * already was: the un-rotated |offset| + the part's geometry radius bounds
 * every heading at once. This is what lets the fleet's bounding sphere be
 * DERIVED rather than measured (see refreshBoundingSphere).
 */
function partReachWorldUnits(part: SkiffPart): number {
  part.geometry.computeBoundingSphere();
  const sphere = part.geometry.boundingSphere;
  if (sphere === null) return 0;
  let reach = 0;
  for (const offset of part.localOffsets) {
    reach = Math.max(reach, offset.length() + sphere.center.length() + sphere.radius);
  }
  return reach;
}

export interface SkiffModels {
  readonly root: Group;
  apply(placements: readonly SkiffPlacement[]): void;
  /** Advances every skiff's orbit/bob by `dt` seconds. A no-op while there are no skiffs to draw. */
  animate(dt: number): void;
  dispose(): void;
}

export function createSkiffModels(): SkiffModels {
  const parts = buildSkiffParts();
  const geometries = parts.map((part) => part.geometry);
  const materials = parts.map((part) => part.material);

  const root = new Group();
  root.name = 'structures:skiffs';
  const meshes = parts.map((part) => {
    const mesh = new InstancedMesh(part.geometry, part.material, SKIFF_INSTANCE_CAPACITY);
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  });

  const fleetReachWorldUnits = Math.max(...parts.map(partReachWorldUnits));

  let current: readonly SkiffPlacement[] = [];
  let elapsedSeconds = 0;

  // Scratch objects reused across every instance of every frame — the same
  // discipline models.ts's apply() keeps, for the identical reason: this
  // runs every frame, not just on a rebuild.
  const instanceMatrix = new Matrix4();
  // The nine elements a Y-rotation-plus-translation never varies: rows and
  // columns the yaw does not touch. Written once here rather than 1 536 times
  // a frame, which is only safe because instanceMatrix is scratch nothing else
  // reads between writes.
  const elements = instanceMatrix.elements;
  elements[1] = 0;
  elements[3] = 0;
  elements[4] = 0;
  elements[5] = 1;
  elements[6] = 0;
  elements[7] = 0;
  elements[9] = 0;
  elements[11] = 0;
  elements[15] = 1;

  function writeFrame(): void {
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const mesh = meshes[partIndex];
      let count = 0;
      for (const skiff of current) {
        const t = elapsedSeconds + skiff.phaseSeconds;
        const dirSign = skiff.orbitClockwise ? 1 : -1;
        const angle = (t / SKIFF_ORBIT_PERIOD_SECONDS) * FULL_TURN_RADIANS * dirSign;
        // The anchor is a CELL; the orbit radius is already in world units
        // (skiffs.ts). Converting the anchor here is what keeps the two in the
        // same space — a no-op until the 2026-08-21 re-sample.
        const worldX = skiff.x * CELL_WORLD_SIZE + Math.sin(angle) * skiff.orbitRadius;
        const worldZ = skiff.z * CELL_WORLD_SIZE + Math.cos(angle) * skiff.orbitRadius;
        const bob = Math.sin((t / SKIFF_BOB_PERIOD_SECONDS) * FULL_TURN_RADIANS) * SKIFF_BOB_AMPLITUDE_WORLD_UNITS;
        const worldY = SKIFF_FLOAT_WORLD_Y + bob;

        // Heading = the instantaneous direction of travel around the orbit
        // (the derivative of the position formula above w.r.t. angle,
        // signed by orbitClockwise), so the hull always noses the way it is
        // actually moving rather than facing a fixed or unrelated direction.
        //
        // THE HEADING'S SINE AND COSINE ARE THE TANGENT ITSELF — no atan2, no
        // second sin/cos, no quaternion. The yaw this wants is
        // `atan2(tangentX, tangentZ)`, and the tangent is a UNIT vector by
        // construction (dirSign is +/-1 over sin^2 + cos^2 = 1), so by the
        // definition of atan2 its sine IS tangentX and its cosine IS tangentZ.
        // Round-tripping them through an angle and back was the whole cost of
        // the Quaternion/compose path this replaces, and it could only lose
        // precision, never add any.
        const yawSin = dirSign * Math.cos(angle);
        const yawCos = -dirSign * Math.sin(angle);

        // The instance matrix, written straight into its own elements in
        // three's column-major order: the 3x3 block is a rotation about Y,
        // and the translation column is the boat's world position plus the
        // part's own offset carried around by that same rotation.
        elements[0] = yawCos;
        elements[2] = -yawSin;
        elements[8] = yawSin;
        elements[10] = yawCos;
        for (const offset of part.localOffsets) {
          elements[12] = worldX + yawCos * offset.x + yawSin * offset.z;
          elements[13] = worldY + offset.y;
          elements[14] = worldZ - yawSin * offset.x + yawCos * offset.z;
          mesh.setMatrixAt(count++, instanceMatrix);
        }
      }
      mesh.count = count;
      // ONLY THE LIVE PREFIX IS UPLOADED. Without a range three's
      // WebGLAttributes.updateBuffer falls back to `bufferSubData(target, 0,
      // array)` — the whole SKIFF_INSTANCE_CAPACITY-sized array, 196 608 B
      // every frame however few skiffs are afloat. Cleared first for the same
      // reason lavaFlow.ts's rebuild clears: three only clears ranges when it
      // actually uploads, so a frame the mesh was not drawn in would otherwise
      // leave a range behind for the next one to add to.
      mesh.instanceMatrix.clearUpdateRanges();
      // In ARRAY ELEMENTS: sixteen floats per instance matrix.
      mesh.instanceMatrix.addUpdateRange(0, count * MATRIX_ELEMENT_COUNT);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * The fleet's bounding sphere, DERIVED from the anchors rather than measured
   * from the matrices just written.
   *
   * `computeBoundingSphere()` walked all 1 536 instance matrices twice per
   * mesh per frame to re-derive a sphere that only moves when the fleet does.
   * Every skiff stays inside a circle of its own orbitRadius about its anchor
   * cell for all time (writeFrame's position formula is exactly that circle),
   * so the anchors and their radii bound the whole fleet analytically — for
   * every frame at once, which is why this is called from apply() and not from
   * animate().
   */
  function refreshBoundingSphere(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const skiff of current) {
      const anchorX = skiff.x * CELL_WORLD_SIZE;
      const anchorZ = skiff.z * CELL_WORLD_SIZE;
      minX = Math.min(minX, anchorX - skiff.orbitRadius);
      maxX = Math.max(maxX, anchorX + skiff.orbitRadius);
      minZ = Math.min(minZ, anchorZ - skiff.orbitRadius);
      maxZ = Math.max(maxZ, anchorZ + skiff.orbitRadius);
    }
    for (const mesh of meshes) {
      const sphere = (mesh.boundingSphere ??= new Sphere());
      if (current.length === 0) {
        sphere.center.set(0, 0, 0);
        sphere.radius = 0;
        continue;
      }
      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;
      sphere.center.set(centerX, SKIFF_FLOAT_WORLD_Y, centerZ);
      // The half-diagonal of the anchor spread, then the two things a skiff
      // can stick out of it by: its bob along Y and its own geometry.
      sphere.radius =
        Math.hypot(maxX - centerX, maxZ - centerZ) +
        SKIFF_BOB_AMPLITUDE_WORLD_UNITS +
        fleetReachWorldUnits;
    }
  }

  return {
    root,

    apply(placements: readonly SkiffPlacement[]): void {
      // SKIFF_INSTANCE_CAPACITY already covers the worst case placementsFor
      // can hand in (see its own comment); this is not a second cap, just
      // the caller's list.
      current = placements;
      writeFrame();
      refreshBoundingSphere();
    },

    animate(dt: number): void {
      elapsedSeconds += dt;
      if (current.length > 0) writeFrame();
    },

    dispose(): void {
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}
