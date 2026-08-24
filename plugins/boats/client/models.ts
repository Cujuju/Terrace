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
// SHARED GEOMETRY AND MATERIALS, allocated once by createBoatModels and freed
// once by its dispose. Only the Groups are per boat.
//
// PORTED TO RIGSKIN, 2026-08-23. The reasoning above survives — a war boat
// still gets its own skeleton and its own sail — but what "a handful of small
// Groups" meant changed: the hull, deck, mast, yard and all four oars are now
// baked once into a RigBlueprint (client/src/render/rigSkin.ts) and drawn as
// ONE skinned surface per boat, animated through Bones instead of scene-graph
// nodes. The unit of AUTHORING stopped being the unit of DRAWING: this went
// from 9 draw calls per boat to 2 (the rig surface plus the sail).

import {
  BoxGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Shape,
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

/**
 * Hull length in cells (CELL_WORLD_SIZE is 1, so cells are world units).
 *
 * 0.9 — just under one cell. A boat has to read as a boat at the camera
 * distance a kraken fight is watched from while never looking like it occupies
 * more sea than it does: the fight's own geometry is measured in whole cells
 * (BOAT_ENGAGEMENT_RANGE_CELLS is 5), so a hull that spilled past a cell would
 * make "five cells away" look wrong.
 */
const HULL_LENGTH = 0.9;
const HULL_BEAM = 0.34;
/**
 * Hull depth. 0.2 rather than the 0.16 this started at: the first eyes-on pass
 * (preview-boats.html) showed the boat reading as a flat plank with a card on
 * it, and freeboard is most of what makes a hull look like a hull from the
 * overhead-ish camera this game is played at.
 */
const HULL_DEPTH = 0.2;
/**
 * The hull's PLAN OUTLINE, in cells, as (fore-aft, athwart) pairs for the
 * starboard half — the port half is mirrored, so the boat cannot end up
 * asymmetric by a typo in one row.
 *
 * ONE EXTRUDED OUTLINE RATHER THAN A BOX PLUS A CONE, which is what this was
 * for two eyes-on passes and what neither of them could rescue. A 4-segment
 * cone laid on its side is a pyramid: from the front it read as a dark spike
 * hanging under the boat, and from above the join between it and the box was a
 * visible step. A hull's shape IS its plan outline — pointed forward, full
 * amidships, square across the stern — so stating that outline once and giving
 * it depth produces the silhouette directly instead of approximating it with
 * two solids that meet badly.
 */
const HULL_OUTLINE: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0],
  [0.34, 0.13],
  [0.06, 0.17],
  [-0.28, 0.16],
  [-0.46, 0.12],
];

/** Mast height, from the deck. Two-thirds the hull's length — a working rig. */
const MAST_HEIGHT = HULL_LENGTH * 0.66;
const MAST_RADIUS = 0.022;

/** Sail dimensions. Wide enough to catch the eye from above, which is the
 * camera angle this game is actually played at. */
/**
 * Sail dimensions.
 *
 * Cut down from 1.5 × beam and 0.62 × mast after the first eyes-on pass: at
 * those numbers the sail was wider than the boat was long in silhouette and
 * read as a billboard rather than as canvas. A square sail is roughly as wide
 * as the hull's beam and about half the mast — that is what a working rig
 * looks like, and it leaves the hull visible underneath it, which is the part
 * that says "boat".
 */
const SAIL_WIDTH = HULL_BEAM * 1.15;
const SAIL_HEIGHT = MAST_HEIGHT * 0.5;
const SAIL_THICKNESS = 0.015;
/** The yard: the spar a square sail hangs from. Without it the sail floats. */
const YARD_RADIUS = 0.014;
const YARD_OVERHANG = 0.03;

/**
 * How far the whole boat rides above the sea surface — the waterline bite.
 *
 * Half the hull depth puts the surface exactly through the middle of the hull,
 * so a boat sits IN the water rather than on it. The sea is translucent
 * (client/src/render/water.ts), so the submerged half really is visible and
 * getting this wrong reads immediately as a boat hovering.
 */
export const BOAT_WATERLINE_LIFT = -HULL_DEPTH * 0.55;

const HULL_COLOR = 0x6b4a2f;
const DECK_COLOR = 0x8a6a44;
const MAST_COLOR = 0x53381f;
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
 * Oar length, measured OUTBOARD FROM THE GUNWALE — so the boat's widest extent
 * is HULL_BEAM/2 + OAR_LENGTH per side, and the whole rowed silhouette has to
 * fit the one-cell budget HULL_LENGTH is chosen against, not just the hull.
 *
 * 0.9 × the beam puts that extent at 0.476 cells a side (0.95 across), just
 * inside a cell. It was 1.35 × the beam until a test measured the assembled
 * model at 1.26 cells across — real oars are longer than a beam, but a boat
 * that occupies more sea than its cell makes every distance in the fight read
 * wrong, and the fight's whole geometry is counted in cells.
 */
const OAR_LENGTH = HULL_BEAM * 0.9;
const OAR_RADIUS = 0.012;
const OAR_COLOR = 0x53381f;
/** Oars per side. Two is enough to read as rowing without modelling a crew. */
const OARS_PER_SIDE = 2;

/**
 * Radians the oars sweep, and how fast.
 *
 * The swing is a YAW about the oar's own mount, never a lift, so no oar ever
 * leaves the water plane or enters the hull — the same "yaw only" constraint
 * the kraken's arms keep, for the same reason: it makes the animation
 * incapable of clipping through the thing it is attached to.
 */
const OAR_SWEEP_RADIANS = 0.45;
const OAR_STROKE_HZ = 0.55;
/**
 * How far the oars tilt DOWN toward the water, in radians.
 *
 * The first eyes-on pass had them dead level at deck height, where they read as
 * loose spars floating beside the boat rather than as oars — nothing connected
 * them to the sea. 0.38 rad drops the blade tips to about the waterline, which
 * is the whole visual point of an oar. It is a fixed tilt and not part of the
 * stroke: the swing stays a pure yaw (see OAR_SWEEP_RADIANS), so the animation
 * still cannot lift a blade out of the water or drive it through the hull.
 */
const OAR_DIP_RADIANS = 0.38;
/** Strokes quicken in a fight. A multiplier, so one constant sets the contrast. */
const OAR_FIGHTING_RATE = 2.1;

/**
 * Height of the sail's centre above the keel line.
 *
 * Lifted out of `create()` because the YARD is baked into the rig and must sit
 * at the sail's head even though the sail itself is NOT baked — see the sail
 * comment in `create()`. One constant keeps the two from drifting apart.
 */
const SAIL_CENTRE_Y = HULL_DEPTH + MAST_HEIGHT * 0.62;

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

/**
 * Builds the shared geometry/material set and the factory over it.
 *
 * Every geometry and material below is created ONCE here and handed to every
 * boat; `dispose` frees them once. A boat's own dispose only clears its Group.
 */
export function createBoatModels(): BoatModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  const track = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const trackMaterial = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  // The hull: HULL_OUTLINE swept to HULL_DEPTH. Built in the shape plane
  // (x fore-aft, y athwart), extruded along +z, then stood upright so the
  // extrusion becomes the hull's depth and the outline becomes its waterplane.
  const hullShape = new Shape();
  const starboard = HULL_OUTLINE.map(([along, across]) => [along * HULL_LENGTH, across * HULL_BEAM * 2] as const);
  const port = [...starboard].reverse().slice(1).map(([along, across]) => [along, -across] as const);
  const outline = [...starboard, ...port];
  hullShape.moveTo(outline[0]![0], outline[0]![1]);
  for (const [along, across] of outline.slice(1)) hullShape.lineTo(along, across);
  hullShape.closePath();

  // Every BAKED part below is flattened to NON-INDEXED (`toNonIndexed`). Why:
  // bakeRig groups parts by materialSignature PLUS indexedness, because
  // mergeGeometries refuses a mix — so an indexed cylinder beside a non-indexed
  // extrusion would silently cost TWO surfaces instead of one. The hull and
  // deck arrive non-indexed from ExtrudeGeometry; converting the turned parts
  // (mast, yard, oars) to match puts the whole rig in ONE group, which is the
  // entire point of the port. The vertex-count cost is a few hundred vertices
  // on 4–5-segment primitives — nothing next to a second draw call per boat.
  // The sail is not baked, so it stays indexed.
  const toBakeable = (geometry: BufferGeometry): BufferGeometry => {
    const flat = geometry.toNonIndexed();
    geometry.dispose();
    return track(flat);
  };

  const hullGeometry = track(
    new ExtrudeGeometry(hullShape, { depth: HULL_DEPTH, bevelEnabled: false }),
  );
  // Stand it up (+z extrusion becomes +y) and centre it on its own depth, so
  // the model's origin is the waterplane and BOAT_WATERLINE_LIFT means what it
  // says.
  hullGeometry.rotateX(-Math.PI / 2);
  hullGeometry.translate(0, HULL_DEPTH / 2, 0);

  // The deck: the same outline, slightly inset and thin, laid on top so the
  // boat has a lighter surface than its flanks and does not read as one solid.
  const deckShape = new Shape();
  const deckOutline = outline.map(([along, across]) => [along * 0.88, across * 0.82] as const);
  deckShape.moveTo(deckOutline[0]![0], deckOutline[0]![1]);
  for (const [along, across] of deckOutline.slice(1)) deckShape.lineTo(along, across);
  deckShape.closePath();
  const deckGeometry = track(
    new ExtrudeGeometry(deckShape, { depth: HULL_DEPTH * 0.16, bevelEnabled: false }),
  );
  deckGeometry.rotateX(-Math.PI / 2);
  deckGeometry.translate(0, HULL_DEPTH, 0);
  const mastGeometry = toBakeable(new CylinderGeometry(MAST_RADIUS, MAST_RADIUS, MAST_HEIGHT, 5));
  const sailGeometry = track(new BoxGeometry(SAIL_THICKNESS, SAIL_HEIGHT, SAIL_WIDTH));
  const yardGeometry = toBakeable(
    new CylinderGeometry(YARD_RADIUS, YARD_RADIUS, SAIL_WIDTH + YARD_OVERHANG * 2, 5),
  );
  const oarGeometry = toBakeable(new CylinderGeometry(OAR_RADIUS, OAR_RADIUS, OAR_LENGTH, 4));

  const hullMaterial = trackMaterial(new MeshStandardMaterial({ color: HULL_COLOR, flatShading: true }));
  const deckMaterial = trackMaterial(new MeshStandardMaterial({ color: DECK_COLOR, flatShading: true }));
  const mastMaterial = trackMaterial(new MeshStandardMaterial({ color: MAST_COLOR, flatShading: true }));
  const oarMaterial = trackMaterial(new MeshStandardMaterial({ color: OAR_COLOR, flatShading: true }));
  // The ONE material that is per boat rather than shared — a fighting boat's
  // sail changes colour, and a shared material would redden every sail in the
  // world the moment one boat engaged.
  const makeSailMaterial = (): MeshStandardMaterial =>
    new MeshStandardMaterial({ color: SAIL_COLOR, flatShading: true });

  // ── THE BAKE ──────────────────────────────────────────────────────────
  //
  // The parts that are identical on every boat — hull, deck, mast, yard and
  // all four oars — are authored ONCE here as a plain part-tree and handed to
  // `bakeRig`, which turns them into one skinnable surface every boat then
  // shares (see client/src/render/rigSkin.ts). What comes back per boat is a
  // skeleton whose bones stand exactly where these nodes stood.
  const authored = new Group();
  // The model faces +X, the same convention monsters' models keep, so the
  // render loop's heading-to-rotation rule is one rule for both plugins.
  // Hull and deck are both baked at their final height by the geometry above,
  // so neither needs positioning here.
  const hull = new Mesh(hullGeometry, hullMaterial);
  authored.add(hull);
  const deck = new Mesh(deckGeometry, deckMaterial);
  authored.add(deck);

  const mast = new Mesh(mastGeometry, mastMaterial);
  mast.position.y = HULL_DEPTH + MAST_HEIGHT / 2;
  authored.add(mast);

  // The yard the sail hangs from, across the beam at the sail's head.
  const yard = new Mesh(yardGeometry, mastMaterial);
  yard.rotation.x = Math.PI / 2;
  yard.position.y = SAIL_CENTRE_Y + SAIL_HEIGHT / 2;
  authored.add(yard);

  // Oars, mounted along both gunwales. Each sits in its own pivot Group so
  // `animate` can yaw it about its mount rather than about the hull.
  //
  // The inner `shaft` Group carries the static dip (rotation.x = side ×
  // OAR_DIP_RADIANS) and is never animated. rigSkin makes EVERY node a bone —
  // including static ones — and records its rest transform verbatim in the
  // bone descriptor, so the dip survives the bake exactly; it costs one extra
  // matrix per oar and buys not having to pre-multiply the dip into anything.
  interface OarJoint {
    /** The authored pivot node, for capturing its joint index after the bake. */
    readonly node: Group;
    /** -1 port or +1 starboard, as authored. */
    readonly side: number;
  }
  const oarJoints: OarJoint[] = [];
  for (let side = -1; side <= 1; side += 2) {
    for (let index = 0; index < OARS_PER_SIDE; index++) {
      const pivot = new Group();
      pivot.position.set(
        HULL_LENGTH * (0.14 - index * 0.32),
        HULL_DEPTH * 0.9,
        (side * HULL_BEAM) / 2,
      );
      const oar = new Mesh(oarGeometry, oarMaterial);
      // Lay the cylinder across the beam, reaching outboard, then dip the
      // blade toward the water — a level oar reads as a loose spar.
      oar.rotation.x = Math.PI / 2;
      oar.position.z = (side * OAR_LENGTH) / 2;
      const shaft = new Group();
      shaft.rotation.x = side * OAR_DIP_RADIANS;
      shaft.add(oar);
      pivot.add(shaft);
      oarJoints.push({ node: pivot, side });
      authored.add(pivot);
    }
  }

  const blueprint = bakeRig(authored);

  // Capture the joint indices NOW, at author time — this is the handle
  // `animate` will use to reach each oar pivot bone. It cannot be recovered
  // later: the authored tree is consumed by the bake, and the instance bones
  // are fresh objects with no link back to these nodes.
  const oarSides: number[] = [];
  const oarJointIndices: number[] = [];
  for (const joint of oarJoints) {
    oarJointIndices.push(blueprint.jointIndex(joint.node));
    oarSides.push(joint.side);
  }

  return {
    create(): BoatModel {
      // One instance of the shared rig: fresh bones and root, zero new buffers.
      const instance = instantiateRig(blueprint);
      const root = instance.root;

      // The sail is deliberately NOT part of the baked rig, though it would
      // merge into its single surface. Two reasons, both about colour:
      //
      // * rigSkin's materialSignature() does NOT include `color` — parts that
      //   differ only in colour merge into ONE surface with the colour carried
      //   as VERTEX DATA. A baked sail's canvas tint would therefore live in a
      //   buffer shared by every boat in the world.
      // * A blueprint holds ONE material per surface, shared by every
      //   instance. There is no per-instance recolour left to be had.
      //
      // But the sail's colour IS the fighting state signal
      // (SAIL_FIGHTING_COLOR above): one boat engaging must redden ITS sail
      // alone. So the sail stays a plain Mesh with its own per-boat material,
      // hung off the instance root. Cost: 2 draw calls per boat instead of the
      // rig's 1. Do not "fix" this back into the rig without solving those two
      // bullets first.
      const sailMaterial = makeSailMaterial();
      const sail = new Mesh(sailGeometry, sailMaterial);
      sail.position.y = SAIL_CENTRE_Y;
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
          for (let i = 0; i < oarJointIndices.length; i++) {
            // Opposite sides pull in opposition, which is what reads as rowing
            // rather than as a shiver. The side comes from the parallel array
            // captured at author time, NOT from userData: instantiateRig builds
            // fresh Bone objects from rest transforms and does not carry
            // userData across the bake.
            instance.joints[oarJointIndices[i]!]!.rotation.y = swing * oarSides[i]!;
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
      // The blueprint first: it owns the merged rig geometry and the vertex-
      // coloured material clone the instances draw with. Everything after it
      // is the authoring pool this file has always tracked.
      blueprint.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
