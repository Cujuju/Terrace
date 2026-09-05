// The war boat: one shared geometry set, one Group per afloat boat.
//
// NOT INSTANCED, deliberately, and the reasoning is the opposite of
// structures' skiffs (plugins/structures/client/skiffModels.ts, which DOES
// instance). A skiff is scenery: a settlement floats up to three, every mature
// coastal settlement has them, and a fully built 512² coastline can hold
// hundreds — so their draw calls had to be collapsed. A war boat only exists
// while a fleet is out, one village's worth at a time in practice, and each one
// needs its own oar swing and its own list against the swell. A handful of
// small Groups is the cheaper answer at that count and a far simpler one.
//
// LOADED, NOT HAND-BUILT (2026-09). The hull below used to be assembled here
// from three.js primitives; it is now authored in Blender, exported to
// assets/war-boat.glb (tools/blender/build_war_boat.py), and loaded by
// preloadBoatModels through client/src/render/rigAsset.ts. What "shared
// geometry" means changed with it: the baked rig blueprint is rebuilt from the
// installed asset on every createBoatModels call — a sub-millisecond bake of
// ~1.5k triangles — so a factory owns its blueprint exactly the way it used to
// own its geometry pool, and dispose frees it the same way.

import {
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
// Render kit, reached the same way plugins/wildlife reaches it — by path. See
// that module's header for why it lives there.
import {
  bakeRig,
  instantiateRig,
  type RigBlueprint,
} from '../../../client/src/render/rigSkin.ts';
import {
  assertAssetFits,
  loadRigAsset,
  type AssetFootprintCells,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';

/**
 * The conservative ceiling `drawObjects` reports until the first bake measures
 * the real count: four is above the three a textured hull plus sail settles at,
 * so budgeting against it can only ever over-reserve.
 */
const BOAT_DRAW_OBJECTS_MAX = 4;

/** Written only by createBoatModels, from the blueprint it just baked. */
let drawObjects: number = BOAT_DRAW_OBJECTS_MAX;

/** The shape numbers measured at install; null until installBoatKit runs. */
let shape: {
  readonly waterlineLift: number;
  readonly fireColumn: { readonly bottomY: number; readonly height: number };
} | null = null;

function installedShape(): NonNullable<typeof shape> {
  if (shape === null) {
    throw new Error(
      'BOAT_SHAPE: no boat asset installed — preloadBoatModels (or installBoatKit) runs first',
    );
  }
  return shape;
}

/**
 * The shape numbers the asset — not this file — decides, published READ-ONLY.
 *
 * These used to be three `export let` bindings with hand-built fallbacks, which
 * gave every importer two ways to be wrong: read one before the asset is
 * installed and get a number that describes a hull that no longer exists, or
 * assign one from outside and silently move every boat in the world. A frozen
 * object of getters removes both — the value is fetched from the installed kit
 * at every read, and there is no writable binding left to reach.
 */
export const BOAT_SHAPE: {
  /** How far the whole boat rides above the sea surface — the waterline bite. */
  readonly waterlineLift: number;
  /** The span of a boat that BURNS, in root space: from the deck to the masthead. */
  readonly fireColumn: { readonly bottomY: number; readonly height: number };
  /** Draw objects one boat costs: the rig's baked surfaces plus the sail. */
  readonly drawObjects: number;
} = Object.freeze({
  /**
   * MEASURED, not hardcoded: `-waterline.y` of the installed asset, so the sea
   * surface cuts the hull where the modeller put the waterline empty.
   *
   * THROWS before install, because there is no honest answer to give: every
   * read of this places a hull vertically, and a guessed number puts the boat
   * at the wrong depth rather than reporting a fault. Nothing reads it that
   * early — the only consumers are the frame loop and the mover pose, both
   * reachable only from a plugin whose attach() succeeded, and attach()
   * bakes the kit on its first line (plugins/boats/client/index.ts:195) —
   * so the throw is a guard against a future caller, not a live path.
   */
  get waterlineLift(): number {
    return installedShape().waterlineLift;
  },

  /**
   * Measured from the `deck_top` and `fire_top` anchors the same way — a flame
   * seated on this covers deck, mast and sail and nothing under the waterline.
   * Published through MoverPose.bodyBottomY / bodyHeight. Throws before
   * install for the same reason waterlineLift does.
   */
  get fireColumn(): { readonly bottomY: number; readonly height: number } {
    return installedShape().fireColumn;
  },

  /**
   * MEASURED PER BAKE (`blueprint.surfaceCount + 1`), not assumed — a textured
   * hull costs its own surface beside the flat set (map identity is in the
   * merge key), and recounting is what keeps the number truthful when the
   * asset changes.
   *
   * ALONE AMONG THE THREE THIS DOES NOT THROW: it returns the conservative
   * ceiling until the first bake. Two reasons, both from executed code rather
   * than intent. It is read from `drawBudget`, which the host calls once per
   * mounted plugin per HUD sample (client/src/plugins/host.ts:944, :965); and
   * a plugin whose attach() THREW is still recorded as mounted
   * (client/src/plugins/host.ts:816-823), so a failed bake leaves this getter
   * on a per-frame path with no kit behind it. A ceiling that over-budgets is
   * harmless there — a budget is an upper bound — while a throw would take
   * out the whole frame's draw accounting for an unrelated plugin's HUD row.
   */
  get drawObjects(): number {
    return drawObjects;
  },
});

/**
 * The ground the rowed silhouette is allowed: one cell square.
 *
 * The fight's geometry is counted in whole cells — ram range, the kraken's
 * reach, how many boats a tile holds — so a hull spilling past its own cell
 * makes every distance in the fight read wrong. Height is deliberately
 * unbudgeted: a mast is as tall as it looks good, and nothing measures it.
 * The slack that absorbs float dust in the bounding box is the render kit's
 * ASSET_FIT_TOLERANCE_CELLS, which is where that reasoning now lives.
 */
const BOAT_FOOTPRINT_CELLS: AssetFootprintCells = { x: 1, z: 1 };

/** Undyed canvas at rest. */
const SAIL_COLOR = 0xe8e0cf;
/**
 * The sail a fighting boat flies.
 *
 * A COLOUR AND NOT A BADGE, because it has to read at the distance the fight
 * happens at: a pennant or an icon would be a few pixels across from a camera
 * framing a 7-cell kraken and its attackers. Deep red against undyed canvas is
 * legible as a state change even when the boat itself is barely a smudge —
 * which is the whole job, since "is my fleet engaged or still sailing out" is
 * the only question a player can act on.
 */
const SAIL_FIGHTING_COLOR = 0xb03a2e;

/**
 * The oar pivots by node name, with the side each pulls on.
 *
 * The sign is ONLY the opposition pairing — port yaws against starboard, which
 * is what reads as rowing rather than as a shiver. Which physical side is -1
 * is invisible (the hull is symmetric), so the names, not the z signs, decide.
 */
const OAR_PIVOTS = [
  { name: 'oar_port_1', side: -1 },
  { name: 'oar_port_2', side: -1 },
  { name: 'oar_starboard_1', side: 1 },
  { name: 'oar_starboard_2', side: 1 },
] as const;

/**
 * Radians the oars sweep, and how fast.
 *
 * The swing is a YAW about the oar's own mount, never a lift, so no oar ever
 * leaves the water plane or enters the hull — the same "yaw only" constraint
 * the kraken's arms keep, for the same reason: it makes the animation
 * incapable of clipping through the thing it is attached to. The dip is
 * authored into the asset (OAR_DIP_RADIANS in tools/blender/build_war_boat.py);
 * only the swing lives here.
 */
const OAR_SWEEP_RADIANS = 0.45;
const OAR_STROKE_HZ = 0.55;
/** Strokes quicken in a fight. A multiplier, so one constant sets the contrast. */
const OAR_FIGHTING_RATE = 2.1;

/** Swell: how far a hull rolls and pitches at rest, and how fast. */
const SWELL_ROLL_RADIANS = 0.07;
const SWELL_PITCH_RADIANS = 0.04;
const SWELL_HZ = 0.31;

/** One boat's scene node and the handle that animates it. */
export interface BoatModel {
  readonly root: Group;
  /**
   * Poses the boat for this frame. `phase` de-synchronises a fleet so three
   * boats do not roll as one object; `fighting` quickens the oars and reddens
   * the sail.
   */
  animate(elapsedSeconds: number, phase: number, fighting: boolean): void;
  /** Frees only what is unique to this boat. Shared assets belong to the set. */
  dispose(): void;
}

export interface BoatModels {
  create(): BoatModel;
  dispose(): void;
}

/** Everything installBoatKit measures from the asset file, once per load. */
interface BoatKit {
  readonly asset: RigAsset;
  readonly sailGeometry: BufferGeometry;
  readonly sailMaterial: MeshStandardMaterial;
  readonly sailPosition: Vector3;
  readonly sailQuaternion: { x: number; y: number; z: number; w: number };
  readonly sailScale: Vector3;
}

let kit: BoatKit | null = null;

/**
 * Loads war-boat.glb over HTTP and installs it: the browser path, called from
 * the plugin's preload with a `.glb?url` import. Measuring, fit-checking and
 * the bake all funnel through installBoatKit, so this and the test/node path
 * (parse + install) cannot drift apart.
 */
export async function preloadBoatModels(url: string): Promise<void> {
  installBoatKit(await loadRigAsset(url));
}

/**
 * Installs an already-parsed asset: the test/node path (bytes off disk plus
 * parseRigAsset). Replaces any previous kit — the host unmounts before it
 * remounts, so the previous asset's blueprints are already disposed; and a
 * stale mount's late install merely re-installs the same bytes, never a live
 * rig out from under its factory.
 */
export function installBoatKit(asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  // The shape-derived constants, measured before anything is assigned: a
  // rejected asset must leave the previous kit (or the fallbacks) untouched.
  const waterline = asset.anchor('waterline');
  const deckTop = asset.anchor('deck_top');
  const fireTop = asset.anchor('fire_top');
  if (!(fireTop.y > deckTop.y)) {
    throw new Error(
      `boat asset: fire_top (${fireTop.y}) is not above deck_top (${deckTop.y}) — ` +
        `the fire column would burn downward`,
    );
  }
  try {
    assertAssetFits(asset, BOAT_FOOTPRINT_CELLS);
  } catch (cause) {
    // Rethrown for the boat-specific MEANING, not for the measurement: the
    // shared error already names the axis and the number, and it rides along as
    // `cause`. What it cannot say is why one cell is the budget.
    throw new Error(
      `boat asset: the rowed silhouette breaks the one-cell fit budget — ` +
        `the fight's geometry is counted in whole cells`,
      { cause },
    );
  }
  const sailNode = asset.node('sail');
  if (!(sailNode instanceof Mesh)) {
    throw new Error('boat asset: the sail node is not a mesh');
  }
  const sailMaterial = (sailNode as Mesh).material as Material;
  if (Array.isArray(sailMaterial) || !(sailMaterial instanceof MeshStandardMaterial)) {
    throw new Error('boat asset: the sail needs one standard material to recolour per boat');
  }
  // Every pivot must be bakable NOW, at install — jointIndex throws for a node
  // outside the baked tree, and finding that out on the first create (or the
  // first frame) would be a runtime surprise for an authoring typo.
  for (const pivot of OAR_PIVOTS) asset.node(pivot.name);

  disposeBoatKit();
  shape = {
    waterlineLift: -waterline.y,
    fireColumn: { bottomY: deckTop.y, height: fireTop.y - deckTop.y },
  };
  kit = {
    asset,
    sailGeometry: (sailNode as Mesh).geometry as BufferGeometry,
    sailMaterial,
    sailPosition: sailNode.position.clone(),
    sailQuaternion: {
      x: sailNode.quaternion.x,
      y: sailNode.quaternion.y,
      z: sailNode.quaternion.z,
      w: sailNode.quaternion.w,
    },
    sailScale: sailNode.scale.clone(),
  };
}

/** Frees the installed asset. Blueprints built from it must go first. */
export function disposeBoatKit(): void {
  kit?.asset.dispose();
  kit = null;
  // The measured numbers go with it: a read after dispose must fault (or, for
  // the budget, fall back to the ceiling) rather than describe a freed asset.
  shape = null;
  drawObjects = BOAT_DRAW_OBJECTS_MAX;
}

/**
 * Builds the shared factory over the installed asset.
 *
 * The sail is detached for the bake and re-attached afterwards (finally, so a
 * bake failure cannot leave the asset dismembered for the next attempt):
 *
 * * rigSkin's materialSignature() does NOT include `color` — parts that differ
 *   only in colour merge into ONE surface with the colour carried as VERTEX
 *   DATA. A baked sail's canvas tint would therefore live in a buffer shared
 *   by every boat in the world.
 * * A blueprint holds ONE material per surface, shared by every instance.
 *   There is no per-instance recolour left to be had.
 *
 * But the sail's colour IS the fighting state signal (SAIL_FIGHTING_COLOR
 * above): one boat engaging must redden ITS sail alone. So the sail stays a
 * plain Mesh with its own per-boat material, hung off the instance root at its
 * authored transform. Do not "fix" this back into the rig without solving
 * those two bullets first.
 */
export function createBoatModels(): BoatModels {
  const installed = kit;
  if (installed === null) {
    throw new Error(
      'createBoatModels: no boat asset installed — preloadBoatModels (or installBoatKit) runs first',
    );
  }
  const sailNode = installed.asset.node('sail');
  const parent = sailNode.parent;
  sailNode.removeFromParent();
  let blueprint: RigBlueprint;
  try {
    blueprint = bakeRig(installed.asset.scene);
  } finally {
    // The asset stays whole: node() and anchor() keep working after the bake.
    parent?.add(sailNode);
  }

  // Capture the joint indices NOW, at bake time — this is the handle `animate`
  // will use to reach each oar pivot bone. It cannot be recovered later: the
  // instance bones are fresh objects with no link back to the authored nodes.
  const oarJoints: number[] = [];
  const oarSides: number[] = [];
  for (const pivot of OAR_PIVOTS) {
    oarJoints.push(blueprint.jointIndex(installed.asset.node(pivot.name)));
    oarSides.push(pivot.side);
  }

  // Measured, not assumed: the textured hull costs its own surface beside the
  // flat set, and the sail (never baked) is the +1. Recount here is what keeps
  // BOAT_SHAPE.drawObjects — and through it drawBudget — truthful per asset.
  drawObjects = blueprint.surfaceCount + 1;

  return {
    create(): BoatModel {
      // One instance of the shared rig: fresh bones and root, zero new buffers.
      const instance = instantiateRig(blueprint);
      const root = instance.root;

      const sailMaterial = installed.sailMaterial.clone();
      sailMaterial.color.setHex(SAIL_COLOR);
      const sail = new Mesh(installed.sailGeometry, sailMaterial);
      sail.position.copy(installed.sailPosition);
      sail.quaternion.set(
        installed.sailQuaternion.x,
        installed.sailQuaternion.y,
        installed.sailQuaternion.z,
        installed.sailQuaternion.w,
      );
      sail.scale.copy(installed.sailScale);
      root.add(sail);

      let wasFighting = false;

      return {
        root,
        animate(elapsedSeconds: number, phase: number, fighting: boolean): void {
          const t = elapsedSeconds + phase;

          // Swell: roll about the keel, pitch about the beam. Two different
          // frequencies so the motion never looks like a single rocking axis.
          root.rotation.z = Math.sin(t * SWELL_HZ * Math.PI * 2) * SWELL_ROLL_RADIANS;
          root.rotation.x = Math.sin(t * SWELL_HZ * Math.PI * 2 * 0.73) * SWELL_PITCH_RADIANS;

          const strokeRate = fighting ? OAR_STROKE_HZ * OAR_FIGHTING_RATE : OAR_STROKE_HZ;
          const swing = Math.sin(t * strokeRate * Math.PI * 2) * OAR_SWEEP_RADIANS;
          for (let i = 0; i < oarJoints.length; i++) {
            // Opposite sides pull in opposition, which is what reads as rowing
            // rather than as a shiver. The side comes from the parallel array
            // captured at bake time, NOT from userData: instantiateRig builds
            // fresh Bone objects from rest transforms and does not carry
            // userData across the bake.
            instance.joints[oarJoints[i]!]!.rotation.y = swing * oarSides[i]!;
          }

          // Only touched on the frame the state actually changes: assigning a
          // colour every frame would dirty the material's uniforms 60 times a
          // second for a value that changes twice a fight.
          if (fighting !== wasFighting) {
            sailMaterial.color.setHex(fighting ? SAIL_FIGHTING_COLOR : SAIL_COLOR);
            wasFighting = fighting;
          }
        },
        dispose(): void {
          // Only this boat's own sail material; the rig surface belongs to the
          // shared blueprint and is freed by the set's dispose below.
          sailMaterial.dispose();
          root.clear();
        },
      };
    },

    dispose(): void {
      // The blueprint: merged rig geometry plus the vertex-coloured material
      // clones the instances draw with. The installed asset (source geometry,
      // the sail template, the file's textures) belongs to the kit and is
      // freed by disposeBoatKit, not here.
      blueprint.dispose();
    },
  };
}
