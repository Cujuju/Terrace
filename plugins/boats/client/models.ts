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

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from 'three';

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
const HULL_DEPTH = 0.16;

/** Mast height, from the deck. Two-thirds the hull's length — a working rig. */
const MAST_HEIGHT = HULL_LENGTH * 0.66;
const MAST_RADIUS = 0.022;

/** Sail dimensions. Wide enough to catch the eye from above, which is the
 * camera angle this game is actually played at. */
const SAIL_WIDTH = HULL_BEAM * 1.5;
const SAIL_HEIGHT = MAST_HEIGHT * 0.62;
const SAIL_THICKNESS = 0.015;

/**
 * How far the whole boat rides above the sea surface — the waterline bite.
 *
 * Half the hull depth puts the surface exactly through the middle of the hull,
 * so a boat sits IN the water rather than on it. The sea is translucent
 * (client/src/render/water.ts), so the submerged half really is visible and
 * getting this wrong reads immediately as a boat hovering.
 */
export const BOAT_WATERLINE_LIFT = -HULL_DEPTH / 2;

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

const OAR_LENGTH = HULL_BEAM * 1.35;
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

  // A hull is a box for the body and a cone for the bow: cheap, and at this
  // size the cone reads as a prow rather than as a cone.
  const hullGeometry = track(new BoxGeometry(HULL_LENGTH * 0.78, HULL_DEPTH, HULL_BEAM));
  const bowGeometry = track(new ConeGeometry(HULL_BEAM / 2, HULL_LENGTH * 0.34, 4));
  const deckGeometry = track(
    new BoxGeometry(HULL_LENGTH * 0.78, HULL_DEPTH * 0.18, HULL_BEAM * 0.92),
  );
  const mastGeometry = track(new CylinderGeometry(MAST_RADIUS, MAST_RADIUS, MAST_HEIGHT, 5));
  const sailGeometry = track(new BoxGeometry(SAIL_THICKNESS, SAIL_HEIGHT, SAIL_WIDTH));
  const oarGeometry = track(new CylinderGeometry(OAR_RADIUS, OAR_RADIUS, OAR_LENGTH, 4));

  const hullMaterial = trackMaterial(new MeshStandardMaterial({ color: HULL_COLOR, flatShading: true }));
  const deckMaterial = trackMaterial(new MeshStandardMaterial({ color: DECK_COLOR, flatShading: true }));
  const mastMaterial = trackMaterial(new MeshStandardMaterial({ color: MAST_COLOR, flatShading: true }));
  const oarMaterial = trackMaterial(new MeshStandardMaterial({ color: OAR_COLOR, flatShading: true }));
  // The ONE material that is per boat rather than shared — a fighting boat's
  // sail changes colour, and a shared material would redden every sail in the
  // world the moment one boat engaged.
  const makeSailMaterial = (): MeshStandardMaterial =>
    new MeshStandardMaterial({ color: SAIL_COLOR, flatShading: true });

  return {
    create(): BoatModel {
      const root = new Group();
      // The model faces +X, the same convention monsters' models keep, so the
      // render loop's heading-to-rotation rule is one rule for both plugins.
      const hull = new Mesh(hullGeometry, hullMaterial);
      root.add(hull);

      const bow = new Mesh(bowGeometry, hullMaterial);
      bow.position.x = HULL_LENGTH * 0.55;
      // The cone points +Y by default; lay it along +X.
      bow.rotation.z = -Math.PI / 2;
      root.add(bow);

      const deck = new Mesh(deckGeometry, deckMaterial);
      deck.position.y = HULL_DEPTH * 0.5;
      root.add(deck);

      const mast = new Mesh(mastGeometry, mastMaterial);
      mast.position.y = HULL_DEPTH * 0.5 + MAST_HEIGHT / 2;
      root.add(mast);

      const sailMaterial = makeSailMaterial();
      const sail = new Mesh(sailGeometry, sailMaterial);
      sail.position.y = HULL_DEPTH * 0.5 + MAST_HEIGHT * 0.62;
      root.add(sail);

      // Oars, mounted along both gunwales. Each sits in its own pivot Group so
      // `animate` can yaw it about its mount rather than about the hull.
      const oarPivots: Group[] = [];
      for (let side = -1; side <= 1; side += 2) {
        for (let index = 0; index < OARS_PER_SIDE; index++) {
          const pivot = new Group();
          pivot.position.set(
            HULL_LENGTH * (0.1 - index * 0.28),
            HULL_DEPTH * 0.4,
            (side * HULL_BEAM) / 2,
          );
          const oar = new Mesh(oarGeometry, oarMaterial);
          // Lay the cylinder across the beam, reaching outboard.
          oar.rotation.x = Math.PI / 2;
          oar.position.z = (side * OAR_LENGTH) / 2;
          pivot.add(oar);
          pivot.userData.side = side;
          oarPivots.push(pivot);
          root.add(pivot);
        }
      }

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
          for (const pivot of oarPivots) {
            // Opposite sides pull in opposition, which is what reads as rowing
            // rather than as a shiver.
            pivot.rotation.y = swing * (pivot.userData.side as number);
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
          // Only this boat's own sail material; every other asset is shared and
          // is freed by the set's dispose below.
          sailMaterial.dispose();
          root.clear();
        },
      };
    },

    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
