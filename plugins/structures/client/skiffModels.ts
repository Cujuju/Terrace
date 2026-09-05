// skiffModels.ts — the Three.js rendering half of card 33's skiffs; see
// skiffs.ts for the placement/animation-parameter math this file consumes,
// and its own banner for why skiffs exist purely client-side.
//
// THE HULL IS AN AUTHORED ASSET, NOT A BOX. assets/skiff.glb (built by
// tools/blender/build_skiff.py) carries the whole boat — one mesh, one
// material, vertex colours, no texture — so this file loads and measures it
// rather than assembling primitives. It is still a SIMPLE LOW-POLY PROP
// (248 triangles), deliberately much simpler than the standing buildings in
// models.ts: a skiff is ambient background dressing glimpsed bobbing on the
// water at the game's orbit-camera distance, not a hero asset a player walks
// up to — see models.ts's own file banner for the "this game's camera looks
// down from an 80+ cell orbit" reasoning that birds and fish already rely on
// for the same simplification.
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
  Box3,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Sphere,
  Vector3,
  type BufferGeometry,
} from 'three';
import { CELL_WORLD_SIZE, SEA_LEVEL } from '@terrace/shared';
import { loadRigAsset, type RigAsset } from '../../../client/src/render/rigAsset.ts';
import { STRUCTURES_CAP } from '../protocol.ts';
import { SKIFF_MAX_PER_SETTLEMENT, SKIFF_ORBIT_PERIOD_SECONDS, type SkiffPlacement } from './skiffs.ts';

const FULL_TURN_RADIANS = Math.PI * 2;
/** Floats one instance matrix occupies in an InstancedMesh's instanceMatrix array. */
const MATRIX_ELEMENT_COUNT = 16;

/**
 * World-space Y a skiff's WATERLINE floats at, before its own small bob
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

/**
 * The silhouette budget the fleet's placement was tuned against, in WORLD
 * units: the hull box this file drew before the GLB existed measured exactly
 * 0.36 long by 0.14 abeam, and skiffs.ts's orbit radii and per-settlement
 * spacing were chosen so boats of that size never crowd each other or the
 * shore. An authored hull may be prettier; it may not be BIGGER, so the
 * placement cell it was fitted to still holds.
 */
const SKIFF_LENGTH_BUDGET_WORLD_UNITS = 0.36;
const SKIFF_BEAM_BUDGET_WORLD_UNITS = 0.14;

/**
 * How far past that budget a measured hull may reach before the asset is
 * rejected at load. A thousandth of a world unit: the fit is AUTHORED, not
 * fitted — glTF stores positions as float32, whose spacing near 0.36 is about
 * 3e-8, so this is four orders of magnitude above the rounding it exists to
 * absorb and still under 0.3 % of the budget, far too small to hide a real
 * overhang. (Same rule as plugins/boats/client/models.ts's
 * BOAT_FIT_TOLERANCE_CELLS, scaled to a budget a third the size.)
 */
const SKIFF_FIT_TOLERANCE_WORLD_UNITS = 0.001;

/**
 * Yaw baked into the asset's geometry ONCE at install, turning the authoring
 * convention's forward (+X — docs/model-assets.md, and every other asset in
 * the repo) into the forward this file's per-frame matrix math assumes (+Z).
 *
 * DERIVATION. writeFrame composes the instance matrix by hand in three's
 * column-major order with elements[0] = cos, elements[2] = -sin,
 * elements[8] = sin, elements[10] = cos — which is exactly
 * Matrix4.makeRotationY(yaw), so the third column (elements[8..10]) is where
 * local +Z lands: (sin yaw, 0, cos yaw). writeFrame sets
 * yawSin = dirSign * cos(angle) and yawCos = -dirSign * sin(angle), the unit
 * tangent of the orbit, so LOCAL +Z IS THE DIRECTION OF TRAVEL. Under
 * makeRotationY(t) the first column is where local +X lands: (cos t, 0, -sin t).
 * Setting that equal to +Z = (0, 0, 1) gives cos t = 0 and -sin t = 1, i.e.
 * t = -PI/2. Verified by measurement: the asset's bow, at x = +0.17097, sits
 * at z = +0.17097 after the rotation.
 *
 * Baked into the geometry rather than folded into the per-frame matrix
 * because it is the same constant rotation for all 1 536 instances forever.
 */
const SKIFF_FORWARD_AXIS_YAW_RADIANS = -Math.PI / 2;

/**
 * Instance capacity: every live structure could in principle be a maxed-out
 * coastal settlement (STRUCTURES_CAP, protocol.ts) floating the maximum
 * skiff count (SKIFF_MAX_PER_SETTLEMENT, skiffs.ts) — the same "assume the
 * worst case, allocate once" trade every InstancedMesh in this plugin makes
 * (see models.ts's identical comment on its own tier meshes). 512 x 3 = 1536
 * instances of a 248-triangle prop is trivial GPU cost next to the building
 * meshes already allocated at this same worst case.
 */
const SKIFF_INSTANCE_CAPACITY = STRUCTURES_CAP * SKIFF_MAX_PER_SETTLEMENT;

/** Everything installSkiffKit measures from the asset file, once per load. */
interface SkiffKit {
  readonly asset: RigAsset;
  /**
   * The one mesh's geometry, already yawed by SKIFF_FORWARD_AXIS_YAW_RADIANS.
   * Owned by `asset`; freed by disposeSkiffKit, never by the fleet's own
   * dispose (which only owns the material it created).
   */
  readonly geometry: BufferGeometry;
  /**
   * How far the boat's origin must rise for its authored `waterline` Empty to
   * land on the sea surface — the negated anchor height, because the origin
   * sits at the keel BELOW that line. The old box hull instead sat its centre
   * half a hull-height up, which floated the whole boat ON the surface rather
   * than in it.
   */
  readonly waterlineLift: number;
  /**
   * How far the geometry reaches from the boat's own origin, in world units —
   * the radius of a sphere at the skiff's position that certainly contains it,
   * whatever its yaw. Yaw is a rotation about Y through the origin, so it can
   * only move geometry around a circle of its own radius, never further out:
   * one un-rotated measurement bounds every heading at once. This is what lets
   * the fleet's bounding sphere be DERIVED rather than measured (see
   * refreshBoundingSphere).
   */
  readonly reachWorldUnits: number;
}

let kit: SkiffKit | null = null;

/**
 * Loads skiff.glb over HTTP and installs it: the browser path, called from
 * the plugin's preload with a `.glb?url` import. Measuring, fit-checking and
 * the axis bake all funnel through installSkiffKit, so this and any
 * parse-from-bytes path cannot drift apart.
 */
export async function preloadSkiffModels(url: string): Promise<void> {
  installSkiffKit(await loadRigAsset(url));
}

/**
 * Installs an already-parsed asset. Everything is MEASURED AND CHECKED before
 * anything is assigned, so a rejected asset leaves the previous kit untouched;
 * every failure throws naming the file, because a silent fallback here shows
 * up as bad art rather than as an error.
 */
export function installSkiffKit(asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  const waterline = asset.anchor('waterline');

  // ONE mesh, because the fleet draws through ONE InstancedMesh. A second
  // mesh would silently go undrawn.
  const meshes: Mesh[] = [];
  asset.scene.traverse((child) => {
    if ((child as Partial<Mesh>).isMesh === true) meshes.push(child as Mesh);
  });
  if (meshes.length !== 1) {
    throw new Error(
      `skiff asset: expected exactly one mesh, found ${meshes.length} — ` +
        `the fleet draws through a single InstancedMesh`,
    );
  }
  const geometry = meshes[0].geometry;
  // The hull's paint IS its vertex colours (no texture, by design): a missing
  // colour attribute under a vertexColors material draws an untinted hull.
  if (geometry.getAttribute('color') === undefined) {
    throw new Error('skiff asset: the hull mesh carries no vertex-colour attribute');
  }

  // Measured in the ASSET's frame, before the axis bake below: +X is the
  // authored forward, so x is the boat's LENGTH and z its BEAM.
  const size = new Box3().setFromObject(asset.scene).getSize(new Vector3());
  if (
    size.x > SKIFF_LENGTH_BUDGET_WORLD_UNITS + SKIFF_FIT_TOLERANCE_WORLD_UNITS ||
    size.z > SKIFF_BEAM_BUDGET_WORLD_UNITS + SKIFF_FIT_TOLERANCE_WORLD_UNITS
  ) {
    throw new Error(
      `skiff asset: hull ${size.x.toFixed(4)} long x ${size.z.toFixed(4)} abeam breaks the ` +
        `${SKIFF_LENGTH_BUDGET_WORLD_UNITS} x ${SKIFF_BEAM_BUDGET_WORLD_UNITS} world-unit ` +
        `silhouette budget skiffs.ts's spacing was tuned against`,
    );
  }

  // The authoring convention's +X forward becomes this file's +Z forward, once
  // and for all instances — see SKIFF_FORWARD_AXIS_YAW_RADIANS's derivation.
  geometry.rotateY(SKIFF_FORWARD_AXIS_YAW_RADIANS);
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;

  disposeSkiffKit();
  kit = {
    asset,
    geometry,
    waterlineLift: -waterline.y,
    reachWorldUnits: sphere === null ? 0 : sphere.center.length() + sphere.radius,
  };
}

/**
 * Frees the installed asset — its geometry, its material and any maps. The
 * fleet built from it must be disposed FIRST (RigAsset.dispose's own contract),
 * which is why the plugin's dispose calls skiffModels.dispose() before this.
 */
export function disposeSkiffKit(): void {
  kit?.asset.dispose();
  kit = null;
}

export interface SkiffModels {
  readonly root: Group;
  apply(placements: readonly SkiffPlacement[]): void;
  /** Advances every skiff's orbit/bob by `dt` seconds. A no-op while there are no skiffs to draw. */
  animate(dt: number): void;
  dispose(): void;
}

export function createSkiffModels(): SkiffModels {
  const installed = kit;
  if (installed === null) {
    // A guard, not a race: the host awaits preload() and only then calls
    // attach() (client/src/plugins/types.ts:665-681, host.ts:844-864), so the
    // kit is installed by the time this plugin builds anything.
    throw new Error(
      'createSkiffModels: no skiff asset installed — preloadSkiffModels (or installSkiffKit) runs first',
    );
  }
  const { geometry, waterlineLift, reachWorldUnits } = installed;

  // NOT the loader's MeshStandardMaterial: every other mesh this plugin draws
  // is flat-shaded Lambert (models.ts), and a lone PBR hull would light
  // differently from the village it is moored to. The vertex colours the
  // authored material carried come across unchanged — they live on the
  // geometry, not the material.
  const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

  const root = new Group();
  root.name = 'structures:skiffs';
  const mesh = new InstancedMesh(geometry, material, SKIFF_INSTANCE_CAPACITY);
  mesh.count = 0;
  root.add(mesh);

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
      // The lift is what puts the authored waterline on the sea surface; the
      // origin itself (the keel) therefore rides below it.
      const worldY = SKIFF_FLOAT_WORLD_Y + waterlineLift + bob;

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
      // three's column-major order: the 3x3 block is a rotation about Y and
      // the translation column is the boat's world position. There is no
      // per-part offset left to carry around by that rotation — the whole
      // boat is one mesh whose origin IS the instance origin.
      elements[0] = yawCos;
      elements[2] = -yawSin;
      elements[8] = yawSin;
      elements[10] = yawCos;
      elements[12] = worldX;
      elements[13] = worldY;
      elements[14] = worldZ;
      mesh.setMatrixAt(count++, instanceMatrix);
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
    const sphere = (mesh.boundingSphere ??= new Sphere());
    if (current.length === 0) {
      sphere.center.set(0, 0, 0);
      sphere.radius = 0;
      return;
    }
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
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    // Centred on the line the boats' ORIGINS ride at, not on the sea surface,
    // so the lift below the waterline is inside the sphere rather than an
    // unaccounted extra reach beneath it.
    sphere.center.set(centerX, SKIFF_FLOAT_WORLD_Y + waterlineLift, centerZ);
    // The half-diagonal of the anchor spread, then the two things a skiff
    // can stick out of it by: its bob along Y and its own geometry.
    sphere.radius =
      Math.hypot(maxX - centerX, maxZ - centerZ) +
      SKIFF_BOB_AMPLITUDE_WORLD_UNITS +
      reachWorldUnits;
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
      mesh.dispose();
      // The MATERIAL is this fleet's own (built above); the GEOMETRY is the
      // asset's and is freed by disposeSkiffKit, which the plugin calls after
      // this — see RigAsset.dispose's ordering contract.
      material.dispose();
      root.clear();
    },
  };
}
