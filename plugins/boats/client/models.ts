// The war boat: one shared geometry set, one Group per afloat boat — plus ONE
// InstancedMesh carrying every sail in the fleet.
//
// THE HULL IS NOT INSTANCED, deliberately: it needs its own oar swing and its
// own list against the swell, which is a skeleton per boat. The SAIL is, since
// 2026-09-06 (#367): it is a rigid board hanging off the root at a fixed
// authored transform, so a fleet's worth of them is one draw call instead of
// one each. Measured at 119 villages / 231 boats, boats were 180 of the
// frame's 373 draw calls, three per hull; the sail was one of the three.
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
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Sphere,
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
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import {
  assertAssetFits,
  type AssetFootprint,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';
import { BOATS_PAYLOAD_CAP } from '../protocol.ts';
import { createSailSlots } from './sailSlots.ts';

/**
 * The conservative ceiling `drawObjects` reports until the first bake measures
 * the real count: four is above the two a textured hull settles at now the sail
 * has left the per-boat path, so budgeting against it can only over-reserve.
 */
const BOAT_DRAW_OBJECTS_MAX = 4;

/**
 * What the fleet's sails cost the frame, however many boats are afloat: ONE
 * InstancedMesh (`BoatModels.sails`), added once to the boats' own container.
 * Added to `drawBudget` beside the per-hull count rather than folded into it,
 * because it does not scale with the fleet and a per-boat number that pretended
 * it did would be a lie at every fleet size but one.
 */
export const FLEET_SAIL_DRAW_OBJECTS = 1;

/** Floats one instance matrix occupies in `InstancedMesh.instanceMatrix`. */
const MATRIX_ELEMENT_COUNT = 16;

/** Floats one instance colour occupies in `InstancedMesh.instanceColor` — one RGB triple. */
const COLOR_ELEMENT_COUNT = 3;

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
  /**
   * Draw objects one HULL costs: the rig's baked surfaces, and nothing else.
   * The sail is not in here — the whole fleet's sails are one instanced draw,
   * counted once as FLEET_SAIL_DRAW_OBJECTS.
   */
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
   * MEASURED PER BAKE (`blueprint.surfaceCount`), not assumed — a textured
   * hull costs its own surface beside the flat set (map identity is in the
   * merge key), and recounting is what keeps the number truthful when the
   * asset changes. It carried a `+ 1` for the sail until the sail became one
   * instanced draw for the whole fleet.
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
 * ASSET_FIT_TOLERANCE_WORLD_UNITS, which is where that reasoning now lives.
 *
 * THE NUMBERS ARE WORLD UNITS, not cells, and the name says so since the
 * orchestrator settled the asset unit on 2026-09-04. Nothing about the hull
 * changed: it was always modelled in world units (see ./index.ts:125-132), the
 * budget was always the number 1, and a cell is CELL_WORLD_SIZE world units —
 * so "one cell square" above is the DESIGN reason for the budget, and this is
 * the measurement it is checked as.
 */
const BOAT_FOOTPRINT_WORLD_UNITS: AssetFootprint = { x: 1, z: 1 };

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
 * The two above as three `Color`s, built once: `setColorAt` takes a Color, and
 * this runs on the frame a fight starts.
 */
const SAIL_REST_TINT = new Color(SAIL_COLOR);
const SAIL_FIGHTING_TINT = new Color(SAIL_FIGHTING_COLOR);

/**
 * The shared sail material's own colour: WHITE, because it is not the sail's
 * colour any more.
 *
 * three multiplies `instanceColor` into the material's diffuse term (verified
 * in three 0.185.1: WebGLProgram.js:737 defines USE_COLOR for an instanced
 * colour, ShaderChunk/color_fragment.glsl.js applies it), so a material still
 * carrying SAIL_COLOR would square the canvas tint and darken every sail.
 */
const SAIL_MATERIAL_COLOR = 0xffffff;

/**
 * The matrix a slot no boat holds is parked at: scale zero, so the sail
 * collapses to a point and rasterises nothing. Without it a freed slot would
 * keep drawing its last sail — or, on an untouched slot, a stale one at the
 * container's origin, which is the failure mode this designs out.
 */
const PARKED_SAIL_MATRIX = new Matrix4().makeScale(0, 0, 0);

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
  /**
   * Parks and returns this boat's sail slot. Idempotent. Shared assets — the
   * blueprint, the sail mesh — belong to the set.
   */
  dispose(): void;
}

export interface BoatModels {
  /**
   * Every sail in the fleet, in ONE draw call. Add it to the SAME parent the
   * boat roots go under: an instance matrix is composed from a root's LOCAL
   * matrix, so a different parent would draw the sails in the wrong space.
   */
  readonly sails: InstancedMesh;
  create(): BoatModel;
  /**
   * Uploads the frame's sail matrices and re-bounds the fleet — ONCE for the
   * whole mesh, after every boat has been animated. Skipping it leaves the
   * sails on the previous frame's poses.
   */
  commitFrame(): void;
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
export async function preloadBoatModels(
  ctx: Pick<ClientPluginCtx, 'loadRigAsset'>,
  url: string,
): Promise<void> {
  // 'lamps-only': the war boat is diffuse art (wood, sailcloth) verified
  // eyes-on against the lamps — see ClientPluginCtx.loadRigAsset for why the
  // environment would light its diffuse term twice.
  installBoatKit(await ctx.loadRigAsset(url, 'lamps-only'));
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
    assertAssetFits(asset, BOAT_FOOTPRINT_WORLD_UNITS);
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
 * above): one boat engaging must redden ITS sail alone. Do not "fix" the sail
 * back into the rig without solving those two bullets first.
 *
 * It is not a per-boat Mesh either, since 2026-09-06: it is one InstancedMesh
 * for the whole fleet, and the per-instance recolour the blueprint could not
 * offer is exactly what `setColorAt` does offer. The sail is a rigid board at a
 * fixed authored transform, which is what makes an instance matrix enough.
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
  // flat set. Recount here is what keeps BOAT_SHAPE.drawObjects — and through
  // it drawBudget — truthful per asset.
  drawObjects = blueprint.surfaceCount;

  // ─── the fleet's sails: one mesh, one draw call, one material ──────────────

  // ONE clone for the whole fleet, where there used to be one per boat. It is
  // cloned rather than used directly because its colour is overwritten and the
  // kit's own material must survive this factory's dispose.
  const sailMaterial = installed.sailMaterial.clone();
  sailMaterial.color.setHex(SAIL_MATERIAL_COLOR);

  const sails = new InstancedMesh(installed.sailGeometry, sailMaterial, BOATS_PAYLOAD_CAP);
  sails.name = 'boats:sails';
  sails.count = 0;
  // Allocated up front instead of lazily by the first setColorAt: three
  // zero-fills that buffer, and zero is BLACK for every slot not yet tinted.
  sails.instanceColor = new InstancedBufferAttribute(
    new Float32Array(BOATS_PAYLOAD_CAP * COLOR_ELEMENT_COUNT).fill(1),
    COLOR_ELEMENT_COUNT,
  );
  // Every slot starts parked, so no matrix is ever drawn before a boat writes
  // one — an all-zero matrix out of the fresh buffer has a zero w row.
  for (let slot = 0; slot < BOATS_PAYLOAD_CAP; slot++) {
    sails.setMatrixAt(slot, PARKED_SAIL_MATRIX);
  }

  const slots = createSailSlots(BOATS_PAYLOAD_CAP);

  // The sail's authored offset from the boat root, composed once: every
  // instance matrix is a root's local matrix times this.
  const authoredSailMatrix = new Matrix4().compose(
    installed.sailPosition,
    new Quaternion(
      installed.sailQuaternion.x,
      installed.sailQuaternion.y,
      installed.sailQuaternion.z,
      installed.sailQuaternion.w,
    ),
    installed.sailScale,
  );

  // How far a sail reaches from its own instance origin, for the fleet's
  // bounding sphere below. The root contributes only a rotation and a
  // translation, so this radius is the same whatever the boat is doing.
  if (installed.sailGeometry.boundingSphere === null) {
    installed.sailGeometry.computeBoundingSphere();
  }
  const sailSphere = installed.sailGeometry.boundingSphere;
  const sailReach =
    sailSphere === null
      ? 0
      : (sailSphere.center.length() + sailSphere.radius) *
        Math.max(installed.sailScale.x, installed.sailScale.y, installed.sailScale.z);

  // Scratch reused by every boat of every frame — the discipline skiffModels'
  // writeFrame keeps, for the same reason: this runs per boat per frame.
  const sailMatrix = new Matrix4();

  // The extent of the sails written since the last commit, in container space.
  // Inverted-empty until the first write, which is how commitFrame tells a
  // frame with no boats from a frame with one at the origin.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  return {
    sails,

    create(): BoatModel {
      // One instance of the shared rig: fresh bones and root, zero new buffers.
      const instance = instantiateRig(blueprint);
      const root = instance.root;

      let slot = slots.acquire();
      // Parked and tinted at rest before the first animate(), so a slot handed
      // out between frames cannot draw last owner's sail for one frame.
      sails.setMatrixAt(slot, PARKED_SAIL_MATRIX);
      sails.setColorAt(slot, SAIL_REST_TINT);
      if (sails.instanceColor !== null) sails.instanceColor.needsUpdate = true;

      let wasFighting = false;

      return {
        root,
        animate(elapsedSeconds: number, phase: number, fighting: boolean): void {
          // A disposed boat has no slot to write and no meshes left to pose.
          if (slot < 0) return;
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

          // The sail rides the root, and animate() runs BEFORE the renderer
          // updates world matrices — so compose from the root's OWN transform
          // rather than reading a matrixWorld that is still last frame's. The
          // mesh shares the roots' parent, which is what makes a local matrix
          // the whole answer.
          root.updateMatrix();
          sailMatrix.multiplyMatrices(root.matrix, authoredSailMatrix);
          sails.setMatrixAt(slot, sailMatrix);

          // The translation column: where this sail is, for the fleet bounds
          // commitFrame turns into a sphere.
          const at = sailMatrix.elements;
          if (at[12]! < minX) minX = at[12]!;
          if (at[12]! > maxX) maxX = at[12]!;
          if (at[13]! < minY) minY = at[13]!;
          if (at[13]! > maxY) maxY = at[13]!;
          if (at[14]! < minZ) minZ = at[14]!;
          if (at[14]! > maxZ) maxZ = at[14]!;

          // Only touched on the frame the state actually changes: assigning a
          // colour every frame would re-upload the instance colours 60 times a
          // second for a value that changes twice a fight.
          if (fighting !== wasFighting) {
            sails.setColorAt(slot, fighting ? SAIL_FIGHTING_TINT : SAIL_REST_TINT);
            if (sails.instanceColor !== null) sails.instanceColor.needsUpdate = true;
            wasFighting = fighting;
          }
        },
        dispose(): void {
          if (slot < 0) return;
          // Park BEFORE releasing: the slot goes back to the pool free of the
          // sail it was drawing, whoever picks it up next.
          sails.setMatrixAt(slot, PARKED_SAIL_MATRIX);
          slots.release(slot);
          slot = -1;
          root.clear();
        },
      };
    },

    commitFrame(): void {
      const drawn = slots.drawnCount;
      sails.count = drawn;
      // ONLY THE LIVE PREFIX IS UPLOADED — without a range three re-sends the
      // whole BOATS_PAYLOAD_CAP-sized array every frame. Cleared first because
      // three only clears ranges when it actually uploads, so a frame the mesh
      // was not drawn in would leave a range for the next one to add to.
      sails.instanceMatrix.clearUpdateRanges();
      sails.instanceMatrix.addUpdateRange(0, drawn * MATRIX_ELEMENT_COUNT);
      sails.instanceMatrix.needsUpdate = true;

      // The fleet's bounding sphere, DERIVED from the matrices just written.
      // three would otherwise walk every instance to build one — once for the
      // frustum test and again for every pick ray — and, worse, would build it
      // ONCE and keep it, silently culling a fleet that had since sailed on.
      const sphere = (sails.boundingSphere ??= new Sphere());
      if (minX > maxX) {
        sphere.makeEmpty();
      } else {
        sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + sailReach;
      }
      minX = Infinity;
      minY = Infinity;
      minZ = Infinity;
      maxX = -Infinity;
      maxY = -Infinity;
      maxZ = -Infinity;
    },

    dispose(): void {
      // The blueprint: merged rig geometry plus the vertex-coloured material
      // clones the instances draw with. The installed asset (source geometry,
      // the sail template, the file's textures) belongs to the kit and is
      // freed by disposeBoatKit, not here.
      blueprint.dispose();
      // The fleet's own: the instance buffers and the one cloned material. The
      // sail GEOMETRY is the kit's and is NOT freed here, for that same reason.
      sails.dispose();
      sailMaterial.dispose();
    },
  };
}
