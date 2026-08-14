// The low-poly Cthulhu: spheres, cones and flat boxes, flat-shaded, in a
// silhouette that is unmistakable at a hundred cells.
//
// Rules this file keeps (the wildlife plugin's, for the same reasons):
//   * NO textures, NO per-model lights, NO external assets. Everything is
//     generated here; the scene's hemisphere + sun light (render/scene.ts) does
//     the lighting, and flat shading is what makes a 6-segment sphere read as a
//     deliberate faceted style rather than as a low-detail mistake. The one
//     exception is the eye pair, which EMITS rather than being lit — see below.
//   * GEOMETRIES AND MATERIALS ARE SHARED and built exactly once, and `dispose()`
//     frees them exactly once. There is at most one monster in a world, so the
//     sharing saves little today; it costs nothing and it is what stops the
//     dispose contract from being different here than everywhere else.
//   * The origin is the PIVOT — the base of the visible torso, the point the
//     water closes over — and the model faces +X (see index.ts for the
//     heading → rotation.y mapping).
//
// Every dimension, colour and rate comes from ./anatomy.ts. Nothing in this file
// is a number: if you want to change how it looks, that is the file to open.
//
// COST: ~22 meshes for the one monster (torso, 2 shoulders, head, 2 eyes, 4 wing
// panels, 14 tentacle segments). Against the terrain's up-to-1024 chunk meshes
// that is noise, which is what buys the tentacle fan its two segments apiece.

import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
import type { MonsterKind } from '../protocol.ts';
import {
  CTHULHU_BODY_COLOR,
  CTHULHU_BREATH_HZ,
  CTHULHU_BREATH_RISE,
  CTHULHU_BREATH_ROLL_RADIANS,
  CTHULHU_EYE_COLOR,
  CTHULHU_EYE_EMISSIVE,
  CTHULHU_EYE_FORWARD,
  CTHULHU_EYE_HEIGHT,
  CTHULHU_EYE_OFFSET,
  CTHULHU_EYE_RADIUS,
  CTHULHU_FACE_TENTACLE_COUNT,
  CTHULHU_HEAD_CENTER_HEIGHT,
  CTHULHU_HEAD_COLOR,
  CTHULHU_HEAD_FORWARD,
  CTHULHU_HEAD_HEIGHT,
  CTHULHU_HEAD_LENGTH,
  CTHULHU_HEAD_WIDTH,
  CTHULHU_SHOULDER_HEIGHT,
  CTHULHU_SHOULDER_LENGTH,
  CTHULHU_SHOULDER_OFFSET,
  CTHULHU_SHOULDER_THICKNESS,
  CTHULHU_SHOULDER_WIDTH,
  CTHULHU_TENTACLE_BEND_RADIANS,
  CTHULHU_TENTACLE_COLOR,
  CTHULHU_TENTACLE_FAN_RADIANS,
  CTHULHU_TENTACLE_LOWER_LENGTH,
  CTHULHU_TENTACLE_LOWER_RADIUS,
  CTHULHU_TENTACLE_PHASE_STEP,
  CTHULHU_TENTACLE_PITCH_RADIANS,
  CTHULHU_TENTACLE_ROOT_FORWARD,
  CTHULHU_TENTACLE_ROOT_HEIGHT,
  CTHULHU_TENTACLE_SWAY_HZ,
  CTHULHU_TENTACLE_SWAY_RADIANS,
  CTHULHU_TENTACLE_UPPER_LENGTH,
  CTHULHU_TENTACLE_UPPER_RADIUS,
  CTHULHU_TORSO_HEIGHT,
  CTHULHU_TORSO_LENGTH,
  CTHULHU_TORSO_WIDTH,
  CTHULHU_WING_BACKSET,
  CTHULHU_WING_COLOR,
  CTHULHU_WING_FOLD_RISE,
  CTHULHU_WING_FOLD_SCALE,
  CTHULHU_WING_HEIGHT,
  CTHULHU_WING_LEAN_RADIANS,
  CTHULHU_WING_OFFSET,
  CTHULHU_WING_PANEL_HEIGHT,
  CTHULHU_WING_PANEL_LENGTH,
  CTHULHU_WING_PANEL_THICKNESS,
  CTHULHU_WING_RAKE_RADIANS,
} from './anatomy.ts';

/**
 * Sphere tessellation. 6 segments around, 4 rings tall — the wildlife plugin's
 * numbers, kept identical on purpose: the monster has to look like it belongs in
 * the same sea as the whales, and facet density is most of what "belongs" means
 * in a flat-shaded style.
 */
const SPHERE_SEGMENTS = 6;
const SPHERE_RINGS = 4;
/** Tentacle segments are 5-sided — round enough to taper, coarse enough to facet. */
const CONE_SEGMENTS = 5;

const TWO_PI = Math.PI * 2;

/** One monster's scene object plus its idle animation. */
export interface MonsterModel {
  /** Positioned and yawed by the caller; never touched by `animate`. */
  readonly root: Group;
  /** `seconds` is elapsed time; `phase` is a per-monster offset in radians. */
  animate(seconds: number, phase: number): void;
}

export interface MonsterModels {
  create(kind: MonsterKind): MonsterModel;
  /** Frees every shared geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** Builds the shared geometry/material pool and the per-kind constructors. */
export function createMonsterModels(): MonsterModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function lambert(color: number, emissive?: number): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color, emissive, flatShading: true });
    materials.push(material);
    return material;
  }

  /** A sphere pre-scaled into an ellipsoid of the given world-unit extents. */
  function ellipsoid(length: number, height: number, width: number): SphereGeometry {
    const geometry = new SphereGeometry(0.5, SPHERE_SEGMENTS, SPHERE_RINGS);
    geometry.scale(length, height, width);
    return keepGeometry(geometry);
  }

  /**
   * A cone hanging DOWN with its base at the origin, so a tentacle segment can
   * be parented straight onto its joint. Cones are built pointing +Y, so this is
   * one rotate and one translate — done in geometry space, once, so every
   * instance inherits it for free.
   */
  function hangingCone(radius: number, length: number): ConeGeometry {
    const geometry = new ConeGeometry(radius, length, CONE_SEGMENTS);
    geometry.rotateX(Math.PI);
    geometry.translate(0, -length / 2, 0);
    return keepGeometry(geometry);
  }

  // ── Shared resources, built once ───────────────────────────────────────────

  const bodyMaterial = lambert(CTHULHU_BODY_COLOR);
  const headMaterial = lambert(CTHULHU_HEAD_COLOR);
  const wingMaterial = lambert(CTHULHU_WING_COLOR);
  const tentacleMaterial = lambert(CTHULHU_TENTACLE_COLOR);
  /**
   * The eyes are the only emissive surface. MeshLambertMaterial with an emissive
   * colour rather than the unlit MeshBasicMaterial the wildlife plugin's
   * anglerfish lure uses: unlit would be full brightness at every angle, and
   * these are meant to be a suggestion of light in a dark head, not headlamps.
   */
  const eyeMaterial = lambert(CTHULHU_EYE_COLOR, CTHULHU_EYE_EMISSIVE);

  const torsoGeometry = ellipsoid(CTHULHU_TORSO_LENGTH, CTHULHU_TORSO_HEIGHT, CTHULHU_TORSO_WIDTH);
  const shoulderGeometry = ellipsoid(
    CTHULHU_SHOULDER_LENGTH,
    CTHULHU_SHOULDER_THICKNESS,
    CTHULHU_SHOULDER_WIDTH,
  );
  const headGeometry = ellipsoid(CTHULHU_HEAD_LENGTH, CTHULHU_HEAD_HEIGHT, CTHULHU_HEAD_WIDTH);
  const eyeGeometry = ellipsoid(
    CTHULHU_EYE_RADIUS * 2,
    CTHULHU_EYE_RADIUS * 2,
    CTHULHU_EYE_RADIUS * 2,
  );
  const wingPanelGeometry = keepGeometry(
    new BoxGeometry(
      CTHULHU_WING_PANEL_LENGTH,
      CTHULHU_WING_PANEL_HEIGHT,
      CTHULHU_WING_PANEL_THICKNESS,
    ),
  );
  const wingFoldGeometry = keepGeometry(
    new BoxGeometry(
      CTHULHU_WING_PANEL_LENGTH * CTHULHU_WING_FOLD_SCALE,
      CTHULHU_WING_PANEL_HEIGHT * CTHULHU_WING_FOLD_SCALE,
      CTHULHU_WING_PANEL_THICKNESS,
    ),
  );
  const tentacleUpperGeometry = hangingCone(
    CTHULHU_TENTACLE_UPPER_RADIUS,
    CTHULHU_TENTACLE_UPPER_LENGTH,
  );
  const tentacleLowerGeometry = hangingCone(
    CTHULHU_TENTACLE_LOWER_RADIUS,
    CTHULHU_TENTACLE_LOWER_LENGTH,
  );

  /** Mesh helper: shared geometry + material, positioned in the rig. */
  function part(
    geometry: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    return mesh;
  }

  /** One face tentacle's two joints, kept so `animate` can sway them. */
  interface TentacleRig {
    /** Root joint at the face. Its X rotation is the fan angle plus the sway. */
    readonly root: Group;
    /** Mid joint. Its Z rotation is the bend plus a lagged sway. */
    readonly mid: Group;
    /** The fan angle this tentacle rests at, radians. */
    readonly restFan: number;
    /** Phase offset within the fan, radians — this is what makes it ripple. */
    readonly phase: number;
  }

  /**
   * Builds one tentacle: a root joint on the face carrying a tapering segment,
   * and a mid joint at that segment's tip carrying a second, thinner one. Two
   * straight cones with a joint between them is the cheapest thing that reads as
   * a CURVE; one cone reads as a spike, and a real curve costs a tube geometry
   * per tentacle.
   */
  function createTentacle(index: number): TentacleRig {
    const root = new Group();
    root.position.set(CTHULHU_TENTACLE_ROOT_FORWARD, CTHULHU_TENTACLE_ROOT_HEIGHT, 0);

    // Spread across the face: -half fan … +half fan, evenly. With an odd count
    // the middle tentacle lands exactly on the centre line. The Math.max keeps a
    // hypothetical single tentacle from dividing by zero.
    const gaps = Math.max(1, CTHULHU_FACE_TENTACLE_COUNT - 1);
    const spread = (index / gaps - 0.5) * CTHULHU_TENTACLE_FAN_RADIANS;
    // X spreads the hanging direction sideways; Z pitches the whole fan forward,
    // away from the chest, so the tentacles hang clear of the torso.
    root.rotation.set(spread, 0, CTHULHU_TENTACLE_PITCH_RADIANS);

    root.add(part(tentacleUpperGeometry, tentacleMaterial, 0, 0, 0));

    const mid = new Group();
    mid.position.set(0, -CTHULHU_TENTACLE_UPPER_LENGTH, 0);
    // Curls back under, toward the body.
    mid.rotation.z = -CTHULHU_TENTACLE_BEND_RADIANS;
    mid.add(part(tentacleLowerGeometry, tentacleMaterial, 0, 0, 0));
    root.add(mid);

    return { root, mid, restFan: spread, phase: index * CTHULHU_TENTACLE_PHASE_STEP };
  }

  /**
   * One folded wing: a big panel raked back and leaned outward, plus a smaller
   * panel above and outboard of it — the fold. `side` is +1 or -1 (which flank).
   */
  function addWing(rig: Group, side: number): void {
    const panel = part(
      wingPanelGeometry,
      wingMaterial,
      -CTHULHU_WING_BACKSET,
      CTHULHU_WING_HEIGHT,
      side * CTHULHU_WING_OFFSET,
    );
    // X leans the panel's top outward; Z rakes it backward (the model faces +X,
    // so a positive Z rotation tips the top toward -X).
    panel.rotation.set(-side * CTHULHU_WING_LEAN_RADIANS, 0, CTHULHU_WING_RAKE_RADIANS);
    rig.add(panel);

    const fold = part(
      wingFoldGeometry,
      wingMaterial,
      -CTHULHU_WING_BACKSET - CTHULHU_WING_PANEL_LENGTH * CTHULHU_WING_FOLD_SCALE * 0.5,
      CTHULHU_WING_HEIGHT + CTHULHU_WING_FOLD_RISE,
      side * (CTHULHU_WING_OFFSET + CTHULHU_WING_PANEL_THICKNESS * 2),
    );
    // The fold leans harder and rakes less — the crook at the top of a folded
    // bat wing, which is what stops the two panels reading as one slab.
    fold.rotation.set(-side * CTHULHU_WING_LEAN_RADIANS * 2, 0, -CTHULHU_WING_RAKE_RADIANS * 0.6);
    rig.add(fold);
  }

  function createCthulhu(): MonsterModel {
    const root = new Group();
    // The caller owns `root` (position + yaw); everything animated hangs off
    // `rig`, so the breathing bob cannot fight the placement maths.
    const rig = new Group();
    root.add(rig);

    rig.add(part(torsoGeometry, bodyMaterial, 0, CTHULHU_TORSO_HEIGHT / 2, 0));
    rig.add(part(shoulderGeometry, bodyMaterial, 0, CTHULHU_SHOULDER_HEIGHT, CTHULHU_SHOULDER_OFFSET));
    rig.add(part(shoulderGeometry, bodyMaterial, 0, CTHULHU_SHOULDER_HEIGHT, -CTHULHU_SHOULDER_OFFSET));
    rig.add(part(headGeometry, headMaterial, CTHULHU_HEAD_FORWARD, CTHULHU_HEAD_CENTER_HEIGHT, 0));
    rig.add(part(eyeGeometry, eyeMaterial, CTHULHU_EYE_FORWARD, CTHULHU_EYE_HEIGHT, CTHULHU_EYE_OFFSET));
    rig.add(part(eyeGeometry, eyeMaterial, CTHULHU_EYE_FORWARD, CTHULHU_EYE_HEIGHT, -CTHULHU_EYE_OFFSET));

    addWing(rig, 1);
    addWing(rig, -1);

    const tentacles: TentacleRig[] = [];
    for (let index = 0; index < CTHULHU_FACE_TENTACLE_COUNT; index++) {
      const tentacle = createTentacle(index);
      tentacles.push(tentacle);
      rig.add(tentacle.root);
    }

    return {
      root,
      animate(seconds, phase) {
        // BREATH: a slow rise and a barely-there roll. The roll is what stops
        // the bob reading as an elevator — a body that only translates is a
        // sprite, a body that translates and rotates is alive.
        const breath = Math.sin(seconds * CTHULHU_BREATH_HZ * TWO_PI + phase);
        rig.position.y = breath * CTHULHU_BREATH_RISE;
        rig.rotation.z = breath * CTHULHU_BREATH_ROLL_RADIANS;

        // TENTACLES: each sways about its rest fan angle, offset by its own
        // phase so the fan ripples across the face instead of flapping as one
        // sheet. The mid joint lags by a radian, which is what sells the whole
        // thing as slack rather than hinged.
        for (const tentacle of tentacles) {
          const wave = seconds * CTHULHU_TENTACLE_SWAY_HZ * TWO_PI + phase + tentacle.phase;
          tentacle.root.rotation.x =
            tentacle.restFan + Math.sin(wave) * CTHULHU_TENTACLE_SWAY_RADIANS;
          tentacle.mid.rotation.z =
            -CTHULHU_TENTACLE_BEND_RADIANS +
            Math.sin(wave - 1) * CTHULHU_TENTACLE_SWAY_RADIANS * 0.6;
        }
      },
    };
  }

  const constructors: Readonly<Record<MonsterKind, () => MonsterModel>> = {
    cthulhu: createCthulhu,
  };

  return {
    create(kind) {
      return constructors[kind]();
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
