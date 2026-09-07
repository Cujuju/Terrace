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
import type { MoverGait } from '../../../../client/src/plugins/kit/moverGait.ts';

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
  /**
   * The unparented, identity-transform root `bakeRig` consumes.
   *
   * Object3D, not Group: a procedural species hands over the Group
   * `pool.rigged()` gave it, while an ASSET-sourced one (./assetSpecies.ts)
   * hands over the .glb's own scene node, and bakeRig has never cared which —
   * it walks children and reads transforms, both of which every Object3D has.
   */
  readonly root: Object3D;
  /**
   * Every node the animation will address, by name. MUST include `rig`, the
   * whole-body node under the root (counter-sway, walk bob, body roll all act
   * on it). A name missing here is a joint the animation cannot reach — the
   * bake throws rather than guessing.
   */
  readonly joints: Readonly<Record<string, Object3D>>;
  /**
   * Poses the herd's scratch rig. `seconds` is the shared animation clock,
   * `phase` the phase in radians of the pose slot being filled.
   *
   * TWO PACINGS, BY PLACEMENT KIND (../placement.ts, 2026-09-05):
   *   * a SWIMMER or FLYER loops on the clock — every periodic term is
   *     `sin(seconds * HZ * TWO_PI + phase)`, and `phase` is a fixed offset;
   *   * a WALKER loops on GROUND COVERED — `phase` is advanced by the engine
   *     from the distance the creature was drawn moving (index.ts,
   *     WALKER_STRIDE_WORLD_UNITS_BY_SPECIES), so its beat is `phase` alone
   *     and it must add NO clock term, or its legs would run while it stood.
   * Either way a term is a function of one unbounded angle, which is what makes
   * quantising the phase into slots safe (models.ts, POSE_SLOTS_PER_HERD).
   *
   * `gait` is what the creature is DOING (../../../client/src/plugins/kit/
   * moverGait.ts) — on the wall, climbing or falling; on the ground, walking,
   * standing still, or sat down after a long stillness (@terrace/shared's
   * stance.ts). It is 'walk' for a species that does not declare
   * `posesByGait` below, and a species that ignores it keeps its previous
   * answers exactly.
   */
  animate(joints: SpeciesJoints, seconds: number, phase: number, gait: MoverGait): void;
  /**
   * True for a species whose `animate` READS the gait — every land walker (it
   * stands and sits where it stops), and any species that can be drawn off the
   * ground climbing or falling (the ibex).
   *
   * It buys the herd one pose-palette band per MoverGait
   * (client/src/render/rigHerd.ts's `poseVariants`), because two creatures at
   * the same phase in different acts are not in the same pose.
   *
   * ABSENT MEANS NO, and a species that answers no is only ever asked for
   * 'walk' — its `animate` may ignore the gait entirely, which is what every
   * swimmer and flyer does. It is ONE flag and not one per act deliberately:
   * the question the herd needs answered is whether the gait changes this
   * species' pose at all, and a second boolean beside it would be a second
   * place for the palette to disagree with the animation.
   */
  readonly posesByGait?: boolean;
}

/** A species file exports exactly one of these. */
export type SpeciesModelBuilder = (pool: SpeciesModelPool) => AuthoredSpecies;

export const TWO_PI = Math.PI * 2;
