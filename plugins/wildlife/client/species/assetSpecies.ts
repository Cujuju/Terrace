// The ASSET-SOURCED species path: a Blender-built .glb standing in for a
// procedural ./<species>.ts body, against the same SpeciesModelBuilder contract
// the hand-authored files answer.
//
// WHY THIS EXISTS (owner, 2026-09-04). Every fish and whale in this plugin
// becomes a Blender asset, one species per pass. The species files are not
// going away — an asset supplies a BODY, and a body is only half of what
// ./speciesModel.ts calls a species. So the split this module fixes is:
//
//   the ASSET supplies  the part tree and the joints, addressed BY NAME;
//   the .ts supplies    the envelope it claims to measure, the joint names it
//                       drives, and `animate`.
//
// Nothing else moves. `models.ts`'s bakeSpecies / herdFor / drawInto never
// learn that a species came from a file: `assetSpeciesBuilder` returns the same
// `AuthoredSpecies` shape `buildGrazer` does, and `speciesDrawable`
// (../models.ts) bakes and herds it identically.
//
// WHY THE ENVELOPE IS ASSERTED RATHER THAN READ. placement.ts fits a swimmer
// into its water column from the species file's envelope constants
// (SWIM_PROFILES, BODY_COLUMNS), and those are a CONTRACT with the server's
// spawn rules, not a description that may drift. Taking them from whatever
// .glb happened to be installed would let a re-export silently move every
// fish in the world; asserting the file against them turns the same re-export
// into a load error naming the file. So the constants stay declared in the
// species .ts and the asset must MEASURE them.
//
// WHO OWNS WHAT, AND THE ORDER THINGS ARE FREED IN — the one thing a reader
// of this file most needs:
//
//   | thing                                   | owner            | freed by |
//   |-----------------------------------------|------------------|----------|
//   | the .glb's geometries/materials/textures| the RigAsset     | disposeSpeciesAssets() |
//   | the baked merged geometry + material    | the RigBlueprint | models.dispose() |
//   | anything from SpeciesModelPool          | nobody: an asset-sourced species allocates NONE |
//
// An asset-sourced builder never calls `pool.keepGeometry` or `pool.lambert`:
// the buffers it draws with came out of the file and the file frees them. And
// the blueprint MUST go first — bakeRig's surfaces sample the asset's own
// texture objects by reference (client/src/render/rigSkin.ts:472-500,
// `vertexColoured`), so freeing the asset while a blueprint lives pulls the
// texels out from under a drawn rig. Hence: ../index.ts disposes `models`
// (every blueprint) and only then calls disposeSpeciesAssets().

import { Box3, type Object3D } from 'three';
import type { RigAsset } from '../../../../client/src/render/rigAsset.ts';
import type { AuthoredSpecies, SpeciesJoints, SpeciesModelBuilder } from './speciesModel.ts';

/**
 * The shape numbers a species file declares and placement.ts reads. Every
 * asset-sourced species asserts its .glb against exactly these.
 */
export interface SpeciesEnvelope {
  /** Nose tip to tail tip, in world units at model scale 1. */
  readonly length: number;
  /** Half of it — what placement.ts's swim profiles are written against. */
  readonly halfLength: number;
  /** The BODY's widest half-width. Fins may reach further; see `flank`. */
  readonly halfWidth: number;
  /** The highest point of the creature above its origin. */
  readonly crownY: number;
  /** The lowest point below it (negative). */
  readonly bellyY: number;
}

/** One species' asset: what file, what joints, what shape it must measure. */
export interface SpeciesAssetSpec {
  /**
   * The species key. One asset per key; installing twice replaces (and frees)
   * the previous one, which is what a plugin remount does.
   */
  readonly species: string;
  /** The file's name, used verbatim in every error this module throws. */
  readonly file: string;
  /**
   * Every node `animate` will address, by the name it carries in the .glb.
   * MUST include `rig` — see AuthoredSpecies.joints.
   */
  readonly joints: readonly string[];
  /** What the file must measure, within ENVELOPE_TOLERANCE_CELLS. */
  readonly envelope: SpeciesEnvelope;
}

/**
 * The joint convention for a SWIMMER, written down once (docs/model-assets.md,
 * "Wildlife species") and shared by every fish and whale that follows the
 * fish through this path.
 *
 *   rig                 an Empty at the origin; the whole body hangs under it,
 *                       and the counter-yaw acts on it.
 *   tail                an Empty AT THE PEDUNCLE, the caudal mesh its child —
 *                       so a yaw sweeps the fin from its root rather than
 *                       spinning it about its own centre.
 *   pectoral_port /     Empties at the flank root, authored at REST IDENTITY.
 *   pectoral_starboard  The fin's sweep is baked into its outline (rigid, so
 *                       it cannot swing the root out of the body); the rest
 *                       dihedral is animation and belongs to the species .ts.
 *
 * PORT IS -Z. With +X forward and +Y up in a right-handed frame,
 * left = up x forward = Y x X = -Z. Getting this backwards is a fish whose
 * fins flutter in antiphase, which is invisible in a still and wrong in motion.
 */
export const SWIMMER_JOINTS: readonly string[] = [
  'rig',
  'tail',
  'pectoral_port',
  'pectoral_starboard',
];

/**
 * The anchor Empties a swimmer's envelope is measured from, and the extreme of
 * the model's own bounding box each one must sit at.
 *
 * `flank` is deliberately absent from this table: the pectorals reach further
 * than the body does (0.137 against 0.080 for the fish), so the bounding box's
 * z-extent is NOT the envelope's halfWidth. It is checked separately below.
 */
const ENVELOPE_ANCHORS = [
  { anchor: 'nose', axis: 'x', side: 'max' },
  { anchor: 'tail_tip', axis: 'x', side: 'min' },
  { anchor: 'crown', axis: 'y', side: 'max' },
  { anchor: 'belly', axis: 'y', side: 'min' },
] as const;

/**
 * How far a measured extreme may sit from the constant it is checked against.
 *
 * A hundredth of a cell. It is chosen from BOTH ends: far above the float32
 * dust a glTF round trip adds to a position (glTF stores accessors as float32,
 * whose relative error at 0.3 is about 2e-8), and far below anything a player
 * could see — 0.01 cell is a seventieth of the fish's length, well under a
 * pixel at the play camera. So it absorbs the file format and nothing else: a
 * fin that really moved would move by more than this or not be worth moving.
 */
export const ENVELOPE_TOLERANCE_CELLS = 0.01;

/** Installed assets by species key. Written only by installSpeciesAsset. */
const installed = new Map<string, RigAsset>();

/**
 * Installs one parsed asset for a species, after checking everything about it
 * that is checkable.
 *
 * THE ONE INSTALL PATH. The browser reaches it through a plugin's `preload`
 * (loadRigAsset over HTTP); Node — a test, a verification script — reaches it
 * with bytes off disk through parseRigAsset. Two feeders, one function, so the
 * two cannot drift: a file that installs under Vitest installs in the browser.
 *
 * Checked BEFORE anything is stored, so a rejected asset leaves the previous
 * one (if any) untouched:
 *   * every joint the species declares exists, by name;
 *   * the four envelope anchors exist and sit at the model's own extremes;
 *   * the anchors agree with the species' declared envelope constants;
 *   * `flank` agrees with the declared halfWidth and does not exceed the
 *     model's z-extent.
 */
export function installSpeciesAsset(spec: SpeciesAssetSpec, asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  if (!spec.joints.includes('rig')) {
    throw new Error(
      `${spec.file}: the species declares no "rig" joint — every AuthoredSpecies ` +
        'must expose the whole-body node (see species/speciesModel.ts)',
    );
  }
  // Every joint must resolve NOW. asset.node throws naming the file and the
  // node; finding a typo at the first bake (or the first frame) instead would
  // turn an authoring mistake into a runtime surprise.
  for (const joint of spec.joints) asset.node(joint);

  const bounds = new Box3().setFromObject(asset.scene);
  const min = bounds.min;
  const max = bounds.max;
  const measured: Record<string, number> = {};
  for (const { anchor, axis, side } of ENVELOPE_ANCHORS) {
    const position = asset.anchor(anchor);
    const extreme = side === 'max' ? max[axis] : min[axis];
    assertClose(spec, `anchor "${anchor}" (${axis})`, position[axis], extreme, 'the model’s own extent');
    measured[anchor] = position[axis];
  }

  const flank = asset.anchor('flank');
  const halfWidth = Math.abs(flank.z);
  const zExtent = Math.max(Math.abs(min.z), Math.abs(max.z));
  if (halfWidth > zExtent + ENVELOPE_TOLERANCE_CELLS) {
    throw new Error(
      `${spec.file}: the "flank" anchor is ${halfWidth.toFixed(4)} from the centreline but ` +
        `nothing in the model reaches past ${zExtent.toFixed(4)}`,
    );
  }

  const envelope = spec.envelope;
  assertClose(spec, 'length', measured.nose! - measured.tail_tip!, envelope.length, 'FISH_ENVELOPE.length');
  assertClose(spec, 'halfLength', (measured.nose! - measured.tail_tip!) / 2, envelope.halfLength, 'envelope.halfLength');
  assertClose(spec, 'crownY', measured.crown!, envelope.crownY, 'envelope.crownY');
  assertClose(spec, 'bellyY', measured.belly!, envelope.bellyY, 'envelope.bellyY');
  assertClose(spec, 'halfWidth', halfWidth, envelope.halfWidth, 'envelope.halfWidth');

  installed.get(spec.species)?.dispose();
  installed.set(spec.species, asset);
}

/** Frees every installed asset. Blueprints baked from them must go FIRST. */
export function disposeSpeciesAssets(): void {
  for (const asset of installed.values()) asset.dispose();
  installed.clear();
}

/**
 * Builds one species from its installed asset.
 *
 * `animate` is the species file's own — the asset carries no animation and is
 * never asked for one, which is what keeps a re-export from changing how a
 * creature moves.
 */
export function assetSpeciesBuilder(
  spec: SpeciesAssetSpec,
  animate: (joints: SpeciesJoints, seconds: number, phase: number) => void,
): SpeciesModelBuilder {
  return (): AuthoredSpecies => {
    const asset = installed.get(spec.species);
    if (asset === undefined) {
      throw new Error(
        `${spec.file}: no asset installed for "${spec.species}" — the wildlife plugin's ` +
          'preload (or installSpeciesAsset, under Node) runs first',
      );
    }
    const joints: Record<string, Object3D> = {};
    for (const name of spec.joints) joints[name] = asset.node(name);
    // The file's scene IS the authored root: it is unparented and at the
    // identity, which is exactly what bakeRig requires, so no placement step
    // sits between the file and the bake. bakeRig consumes it as data and
    // clones every buffer it keeps, so the scene survives repeated bakes.
    return { root: asset.scene, joints, animate };
  };
}

/** One measured-versus-declared check, with the file named in the failure. */
function assertClose(
  spec: SpeciesAssetSpec,
  label: string,
  measured: number,
  declared: number,
  against: string,
): void {
  if (Math.abs(measured - declared) <= ENVELOPE_TOLERANCE_CELLS) return;
  throw new Error(
    `${spec.file}: ${label} measures ${measured.toFixed(4)} but ${against} says ` +
      `${declared.toFixed(4)} — outside the ${ENVELOPE_TOLERANCE_CELLS} cell tolerance`,
  );
}
