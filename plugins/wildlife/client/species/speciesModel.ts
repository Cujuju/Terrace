// The contract between one species' model file and the shared pool in
// ../models.ts.
//
// A species file AUTHORS: it builds the part tree the way every creature in
// this plugin is built (a Group per hinge, a Mesh per surface, positioned in
// its parent's space, the model facing +X with its pivot at the feet for a
// walker and the body centre for a swimmer), names the nodes its animation
// drives, and supplies the animation that poses them. It never allocates a
// geometry or a material on its own account: it asks the pool, which owns
// them, shares them across every instance and frees them exactly once.
//
// The pool BAKES (client/src/render/rigSkin.ts) and HERDS (rigHerd.ts): one
// skinned InstancedMesh per surface per species, a pose palette rebuilt per
// phase slot rather than per creature. None of that is a species file's
// business, which is what lets a model be read — and replaced — on its own.
//
// WHY A FILE PER SPECIES (owner, 2026-09-02: "put them in separate plugins
// or files denoted with their name"). A model is judged by looking at it, and
// the file that draws an ibex should contain nothing but the ibex.
import type {
  Bone,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
} from 'three';

/** What the shared pool lends a species file at authoring time. */
export interface SpeciesModelPool {
  /** Registers a geometry for disposal with the pool and returns it. */
  keepGeometry<T extends BufferGeometry>(geometry: T): T;
  /**
   * A lit material. Flat-shaded unless told otherwise: the swept bodies in this
   * directory are all smooth (`flatShading: false`), and say so at every call,
   * because on a swept hull faceting shows as banding, not as style.
   */
  lambert(color: number, options?: { flatShading?: boolean }): MeshLambertMaterial;
  /** An unlit material, for the one thing per model that has to glow. */
  unlit(color: number): MeshBasicMaterial;
  /** A Mesh on shared geometry + material, positioned in its parent's space. */
  part(geometry: BufferGeometry, material: Material, x: number, y: number, z: number): Mesh;
  /** The root/rig pair every species starts from (see models.ts `rigged`). */
  rigged(): { root: Group; rig: Group };
}

/** The handles an animation drives, by the names the species file gave them. */
export type SpeciesJoints = Readonly<Record<string, Bone>>;

/** One species, authored: its tree, its named hinges, and its idle animation. */
export interface AuthoredSpecies {
  /** The unparented, identity-transform root `bakeRig` consumes. */
  readonly root: Group;
  /**
   * Every node the animation will address, by name. MUST include `rig`, the
   * whole-body node under the root (counter-sway, walk bob, body roll all act
   * on it). A name missing here is a joint the animation cannot reach — the
   * bake throws rather than guessing.
   */
  readonly joints: Readonly<Record<string, Object3D>>;
  /**
   * Poses the herd's scratch rig. `seconds` is the shared animation clock,
   * `phase` the offset in radians of the pose slot being filled — every
   * periodic term is `sin(seconds * HZ * TWO_PI + phase)`, which is what makes
   * quantising the phase into slots safe (models.ts, POSE_SLOTS_PER_HERD).
   */
  animate(joints: SpeciesJoints, seconds: number, phase: number): void;
}

/** A species file exports exactly one of these. */
export type SpeciesModelBuilder = (pool: SpeciesModelPool) => AuthoredSpecies;

export const TWO_PI = Math.PI * 2;
