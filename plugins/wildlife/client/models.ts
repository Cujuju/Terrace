// Every species but the bird is authored under ./species/ (SpeciesModelPool
// contract in ./species/speciesModel.ts); this file lends the pool and herds.
//
// Rules this file keeps:
//   * No per-creature lights and no Math.random in geometry. The scene's
//     hemisphere + sun light does the lighting, and flat shading is what makes
//     a 6-segment sphere read as deliberate faceting rather than low detail.
//
//     Until 2026-09-04 this also read "no textures, no external assets". A .glb
//     per species is now the default path (docs/model-assets.md), arriving
//     through this pool as the same AuthoredSpecies a hand-built one does.
//
//   * The origin is the creature's PIVOT: feet for a walker, body centre for a
//     swimmer, facing +X (index.ts turns heading into rotation.y).
//
//   * A creature is not a scene object. Each used to carry a Group, a Skeleton,
//     a Bone per joint and a SkinnedMesh per surface — ~8,300 Object3Ds at
//     population cap, all walked before culling (perf review 2026-08-29, A2).

import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  type Bone,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
// Reached by path, the same way registry.ts reaches this plugin.
import { bakeRig, type RigBlueprint } from '../../../client/src/render/rigSkin.ts';
import { createRigHerd, type RigHerd } from '../../../client/src/render/rigHerd.ts';
import {
  MOVER_GAITS,
  moverGaitIndex,
  type MoverGait,
} from '../../../client/src/plugins/kit/moverGait.ts';
import { applyMoverBodyTilt } from '../../../client/src/plugins/kit/moverBodyTilt.ts';
import { WHALE_SPECIES, type WhaleSpecies } from './whaleSpecies.ts';
import { buildHumpback } from './species/humpback.ts';
import { buildBlueWhale } from './species/blueWhale.ts';
import { buildSpermWhale } from './species/spermWhale.ts';
import { type WildlifeSizeClass, type WildlifeSpecies } from '../protocol.ts';
import { modelScaleFor } from './modelScale.ts';
import type { SpeciesModelBuilder, SpeciesModelPool } from './species/speciesModel.ts';
import { buildFish } from './species/fish.ts';
import { buildGrazer } from './species/grazer.ts';
import { buildWolf } from './species/wolf.ts';
import { buildIbex } from './species/ibex.ts';
import { buildBison } from './species/bison.ts';
import { buildRay } from './species/ray.ts';
import { buildShark } from './species/shark.ts';
import { buildEel } from './species/eel.ts';
import { buildAngelfish } from './species/angelfish.ts';
import { buildDeepsea } from './species/deepsea.ts';

/** Fewest that still reads as a body, and gives flatShading the terrain's chunky facets. */
const SPHERE_SEGMENTS = 6;
const SPHERE_RINGS = 4;
/** Cones are 4-sided — pyramids, deliberately. */
const CONE_SEGMENTS = 4;

/**
 * Birds read as SILHOUETTES: the only creature seen against the sky (0x9fc7e8),
 * and the smallest thing on screen. A bird tinted to look right up close would
 * vanish at the only distance it is actually seen from.
 */
const BIRD_COLOR = 0x2e3646;

/**
 * World units at model scale 1, above and below a centre origin. Read by
 * placement.ts's BODY_COLUMNS so a flame covers the body actually drawn.
 */
export const BIRD_ENVELOPE = {
  /** Body ellipsoid full height 0.18; wings are thinner than the body. */
  crownY: 0.09,
  bellyY: -0.09,
} as const;

/**
 * The fastest animation here (convention: slower = larger), also just true of
 * small birds.
 *
 * Bounded by the display: at 60 fps a 5.5 Hz cycle is ~11 frames, so the wing
 * reads as flapping. Push toward 10 Hz and consecutive frames land on opposite
 * stroke ends — a blur, or an apparent backward beat.
 */
const BIRD_WING_FLAP_HZ = 5.5;

/**
 * Half the wing's travel. 0.7 is ~40° either side of level, the range at which
 * a wing seen from above visibly changes its projected width. Smaller reads as
 * a rigid glider; larger folds the wings over the bird's own back.
 */
const BIRD_WING_FLAP_RADIANS = 0.7;
/** Tiny by design: rises fractionally on the downstroke so the flap isn't a hinge on a static body. */
const BIRD_BODY_BOB = 0.04;
/** Two panels plus the body give a ~1.3-unit wingspan against a 0.6-unit body — larger than a fish, since a bird is seen from further away. */
const BIRD_WING_LENGTH = 0.62;
/** Half the panel's length, so its inner edge lands on the centreline and the hinge sits at the shoulder. Derived so the two can't drift. */
const BIRD_WING_ROOT_OFFSET = BIRD_WING_LENGTH / 2;

const TWO_PI = Math.PI * 2;

/**
 * Distinct animation phases one species is drawn with in a single frame.
 *
 * Quantising phase is safe because every animation is a loop driven by one
 * angle: slotting shifts it along the loop by at most one slot, never changing
 * what the animation is.
 *
 * At 140 fps the fastest loop here (a hunting wolf, ~9.6 strides/s) advances
 * ~1/15 of a cycle between seen frames and the bird's wing ~1/25 — both bigger
 * than the 1/32-cycle quantisation step.
 *
 * Worth it because the palette rebuilds once per SLOT per frame, not per
 * creature: 32 poses instead of 850 at population cap, so frame cost is
 * independent of population.
 */
const POSE_SLOTS_PER_HERD = 32;

interface SpeciesDrawable {
  readonly herd: RigHerd;
  /** `seconds` is elapsed time; `phase` is the pose slot's offset in radians. */
  animate(seconds: number, phase: number, gait: MoverGait): void;
}

export interface WildlifeModels {
  /** One per species surface, not one per creature. Added to the scene once and never re-parented. */
  readonly objects: readonly Object3D[];
  /** `seconds` is the animation clock every pose in the frame is read at. */
  beginFrame(seconds: number): void;
  /**
   * `sizeClass` scales the whole rig uniformly, so it costs three numbers in an
   * instance matrix rather than a second buffer copy. The species' own draw
   * scale rides the same number (./modelScale.ts).
   *
   * `variantSeed` must be STABLE for a creature's whole life (the caller passes
   * its entity id), or the creature would change body between frames. Only
   * whales have more than one.
   *
   * `phase` is an animation offset in radians; `yaw` is rotation about Y.
   *
   * Positional arguments, not a pose object: a fresh object per creature per
   * frame is 850 allocations a frame for nothing.
   */
  draw(
    species: WildlifeSpecies,
    sizeClass: WildlifeSizeClass,
    variantSeed: number,
    phase: number,
    gait: MoverGait,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): void;
  endFrame(): void;
  /** Call once, at plugin dispose. */
  dispose(): void;
}

/**
 * `instanceCapacity` is the most creatures of ONE species that may be drawn in a
 * frame; the caller's population cap is the honest value.
 */
export function createWildlifeModels(instanceCapacity: number): WildlifeModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  /** Flat-shaded by default; swept-hull species (ibex, bison) opt out through the pool contract. */
  function lambert(color: number, options: { flatShading?: boolean } = {}): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color, flatShading: options.flatShading ?? true });
    materials.push(material);
    return material;
  }

  /** Unlit glow without a light. SpeciesModelPool contract; no species calls it today. */
  function unlit(color: number): MeshBasicMaterial {
    const material = new MeshBasicMaterial({ color });
    materials.push(material);
    return material;
  }

  /** Extents are world units. */
  function ellipsoid(length: number, height: number, width: number): SphereGeometry {
    const geometry = new SphereGeometry(0.5, SPHERE_SEGMENTS, SPHERE_RINGS);
    geometry.scale(length, height, width);
    return keepGeometry(geometry);
  }

  // Authored roughly one cell across the wings — twice its body length, a
  // bird's real proportions, and bigger than a fish (0.55 long) since it is
  // seen from BIRD_FLIGHT_WORLD_Y.
  const birdMaterial = lambert(BIRD_COLOR);
  const birdBody = ellipsoid(0.6, BIRD_ENVELOPE.crownY - BIRD_ENVELOPE.bellyY, 0.18);
  /** One wing panel. Its LENGTH runs along Z, so it hinges about the X axis. */
  const birdWing = keepGeometry(new BoxGeometry(0.32, 0.03, BIRD_WING_LENGTH));
  const birdTail = keepGeometry(new ConeGeometry(0.13, 0.26, CONE_SEGMENTS));
  birdTail.rotateZ(Math.PI / 2);

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

  /**
   * Root + inner rig, as AUTHORED. `rig` and any hinge under it become bones
   * once `bakeRig` turns the tree into one skinned drawable.
   */
  function rigged(): { root: Group; rig: Group } {
    const root = new Group();
    const rig = new Group();
    root.add(rig);
    return { root, rig };
  }

  /**
   * Named joints, not positional: `joints.leftWing` reads better than
   * `joints[3]`, and a reordering bake would otherwise silently swap limbs.
   */
  interface SpeciesRig {
    readonly blueprint: RigBlueprint;
    readonly jointIndices: Readonly<Record<string, number>>;
    /** Where the gait's body tilt goes — the one node a species file cannot reach, and so cannot fight. */
    readonly rootJoint: number;
  }

  const speciesRigs: SpeciesRig[] = [];

  function bakeSpecies(root: Object3D, joints: Readonly<Record<string, Object3D>>): SpeciesRig {
    const blueprint = bakeRig(root);
    const jointIndices: Record<string, number> = {};
    for (const [name, node] of Object.entries(joints)) {
      jointIndices[name] = blueprint.jointIndex(node);
    }
    const rig: SpeciesRig = { blueprint, jointIndices, rootJoint: blueprint.jointIndex(root) };
    speciesRigs.push(rig);
    return rig;
  }

  const herds: RigHerd[] = [];

  /** Handles are named for the same reason bakeSpecies captures joints by name. */
  function herdFor(
    rig: SpeciesRig,
    posesByGait: boolean = false,
  ): { herd: RigHerd; joints: Readonly<Record<string, Bone>>; rigRoot: Bone } {
    const herd = createRigHerd(rig.blueprint, {
      capacity: instanceCapacity,
      poseSlots: POSE_SLOTS_PER_HERD,
      // A species whose pose depends on gait needs a band of slots per gait:
      // phase alone can't distinguish climbing from standing where it
      // stopped (AuthoredSpecies.posesByGait).
      poseVariants: posesByGait ? MOVER_GAITS.length : 1,
    });
    herds.push(herd);
    const joints: Record<string, Bone> = {};
    for (const [name, index] of Object.entries(rig.jointIndices)) {
      joints[name] = herd.joints[index]!;
    }
    return { herd, joints, rigRoot: herd.joints[rig.rootJoint]! };
  }

  /**
   * The one place a creature turns into an instance. A pose is built at most
   * once per slot per frame: the first creature to land in a slot pays for it,
   * every other creature in that slot rides free.
   */
  function drawInto(
    drawable: SpeciesDrawable,
    seconds: number,
    phase: number,
    gait: MoverGait,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
  ): void {
    const herd = drawable.herd;
    // The gait picks the palette band, the phase picks the row inside it. A
    // herd built without wall gaits has one band and clamps to it.
    const slot = herd.poseSlotOf(phase, moverGaitIndex(gait));
    if (herd.needsPose(slot)) {
      drawable.animate(seconds, herd.poseSlotPhase(slot), gait);
      herd.capturePose(slot);
    }
    herd.place(slot, x, y, z, yaw, scale);
  }

  /** One implementation of each, so a species file's geometry lands in the same disposal lists as the bird's. */
  const speciesPool: SpeciesModelPool = { keepGeometry, lambert, unlit, part, rigged };

  /**
   * The species file names its own joints and drives them; nothing here knows
   * what a fin or a hind leg is — the whole point of the split.
   */
  function speciesDrawable(build: SpeciesModelBuilder): SpeciesDrawable {
    const authored = build(speciesPool);
    const posesByGait = authored.posesByGait === true;
    const { herd, joints, rigRoot } = herdFor(
      bakeSpecies(authored.root, authored.joints),
      posesByGait,
    );
    return {
      herd,
      animate(seconds, phase, gait) {
        authored.animate(joints, seconds, phase, gait);
        applyMoverBodyTilt(rigRoot, gait, seconds, phase);
      },
    };
  }

  const birdRig = (() => {
    const { root, rig } = rigged();
    rig.add(part(birdBody, birdMaterial, 0, 0, 0));
    rig.add(part(birdTail, birdMaterial, -0.38, 0, 0));

    // Each wing gets its own pivot Group AT THE SHOULDER, with the panel
    // offset outboard inside it — rotating the panel directly would swing
    // it about its own centre, lifting the root through the back.
    function wing(sign: number): Group {
      const pivot = new Group();
      pivot.add(part(birdWing, birdMaterial, 0, 0, sign * BIRD_WING_ROOT_OFFSET));
      rig.add(pivot);
      return pivot;
    }
    const leftWing = wing(1);
    const rightWing = wing(-1);
    return bakeSpecies(root, { rig, leftWing, rightWing });
  })();

  // Order fixes the order these surfaces appear in `objects`, which ./index.ts's
  // draw-object table counts against.
  const fishDrawable = speciesDrawable(buildFish);
  const grazerDrawable = speciesDrawable(buildGrazer);
  const wolfDrawable = speciesDrawable(buildWolf);
  const ibexDrawable = speciesDrawable(buildIbex);
  const bisonDrawable = speciesDrawable(buildBison);
  const rayDrawable = speciesDrawable(buildRay);
  const sharkDrawable = speciesDrawable(buildShark);
  const eelDrawable = speciesDrawable(buildEel);
  const angelfishDrawable = speciesDrawable(buildAngelfish);

  /** `drawableOf` indexes these by the stable per-creature seed. */
  const whaleBuilders: Readonly<Record<WhaleSpecies, SpeciesModelBuilder>> = {
    humpback: buildHumpback,
    blue: buildBlueWhale,
    sperm: buildSpermWhale,
  };
  const whaleDrawables: readonly SpeciesDrawable[] = WHALE_SPECIES.map(
    (body): SpeciesDrawable => speciesDrawable(whaleBuilders[body]),
  );

  const deepseaDrawable = speciesDrawable(buildDeepsea);

  const birdDrawable = ((): SpeciesDrawable => {
    const { herd, joints } = herdFor(birdRig);
    const rig = joints.rig!;
    const leftWing = joints.leftWing!;
    const rightWing = joints.rightWing!;
    return {
      herd,
      animate(seconds, phase) {
        const swing = Math.sin(seconds * BIRD_WING_FLAP_HZ * TWO_PI + phase);
        // Rotation about X maps a point at +Z to y = -L·sin(θ), so the two
        // wings take OPPOSITE signs to send both tips the same way.
        leftWing.rotation.x = -swing * BIRD_WING_FLAP_RADIANS;
        rightWing.rotation.x = swing * BIRD_WING_FLAP_RADIANS;
        rig.position.y = swing * BIRD_BODY_BOB;
      },
    };
  })();

  function drawableOf(species: WildlifeSpecies, variantSeed: number): SpeciesDrawable {
    switch (species) {
      case 'fish':
        return fishDrawable;
      case 'whale':
        return whaleDrawables[Math.abs(Math.trunc(variantSeed)) % whaleDrawables.length]!;
      case 'deepsea':
        return deepseaDrawable;
      case 'grazer':
        return grazerDrawable;
      case 'wolf':
        return wolfDrawable;
      case 'ibex':
        return ibexDrawable;
      case 'bison':
        return bisonDrawable;
      case 'ray':
        return rayDrawable;
      case 'shark':
        return sharkDrawable;
      case 'eel':
        return eelDrawable;
      case 'angelfish':
        return angelfishDrawable;
      case 'bird':
        return birdDrawable;
    }
  }

  const objects: Object3D[] = [];
  for (const herd of herds) objects.push(...herd.meshes);

  let animationSeconds = 0;

  return {
    objects,
    beginFrame(seconds) {
      animationSeconds = seconds;
      for (const herd of herds) herd.beginFrame();
    },
    draw(species, sizeClass, variantSeed, phase, gait, x, y, z, yaw) {
      drawInto(
        drawableOf(species, variantSeed),
        animationSeconds,
        phase,
        gait,
        x,
        y,
        z,
        yaw,
        // Uniform, in the instance matrix: the pose palette holds rig-space
        // transforms only, so no animation can overwrite it.
        modelScaleFor(species, sizeClass),
      );
    },
    endFrame() {
      for (const herd of herds) herd.endFrame();
    },
    dispose() {
      for (const herd of herds) herd.dispose();
      herds.length = 0;
      objects.length = 0;
      // The baked rigs own buffers of their own, on top of the authored pool the
      // two loops below free.
      for (const rig of speciesRigs) rig.blueprint.dispose();
      speciesRigs.length = 0;
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
