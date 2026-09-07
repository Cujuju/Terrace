// The shared pool and the per-species herds. Every species but the bird is
// authored in its own file under ./species/ (SpeciesModelPool contract in
// ./species/speciesModel.ts); this file lends the pool, bakes and herds.
//
// Rules this file keeps:
//   * NO per-creature lights, and NO Math.random in any geometry. The scene's
//     hemisphere + sun light (render/scene.ts) does all the lighting, and
//     flat shading is what makes a 6-segment sphere read as deliberate
//     faceting rather than low detail.
//
//     Until 2026-09-04 this also read "no textures, no external assets".
//     Superseded that day: external GLB assets are allowed and are the
//     default path for a new species (docs/model-assets.md) —
//     ./species/assetSpecies.ts installs a .glb per species, arriving
//     through this pool as the same AuthoredSpecies the hand-built ones are.
//     Still banned: non-determinism in procedural geometry, per-object
//     lights, and anything touching shared/.
//   * GEOMETRIES AND MATERIALS ARE SHARED across every instance of a species,
//     built exactly once; `dispose()` frees them once too.
//   * The origin is the creature's PIVOT: feet for a walker, body centre for
//     a swimmer, facing +X (see index.ts for heading → rotation.y).
//   * A CREATURE IS NOT A SCENE OBJECT. Each used to carry a root Group, a
//     Skeleton, a Bone per joint and a SkinnedMesh per surface (~8,300
//     Object3Ds at population cap, all walked by updateMatrixWorld before
//     culling — perf review 2026-08-29, A2). Now a whole species is one
//     InstancedMesh per baked surface: `create` became `draw`, and scene
//     object count is O(species), not O(creatures). See render/rigHerd.ts.

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
// Render kit, reached the same way client/src/plugins/registry.ts reaches
// this plugin — by path.
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
// One file per species (./species/); this file no longer draws a fish or a
// grazer, it lends the pool and bakes whatever the species file hands back.
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

/** Sphere tessellation: 6 segments, 4 rings — fewest that still reads as a body, and gives flatShading the terraced terrain's chunky facets. */
const SPHERE_SEGMENTS = 6;
const SPHERE_RINGS = 4;
/** Cones are 4-sided — pyramids, deliberately. */
const CONE_SEGMENTS = 4;

/**
 * Birds are read as SILHOUETTES: the only creature seen against the sky
 * (0x9fc7e8, render/scene.ts) rather than terrain or water, and the smallest
 * thing on screen. Dark slate keeps contrast from every angle — a bird
 * tinted to look "right" up close would vanish at the only distance it's seen from.
 */
const BIRD_COLOR = 0x2e3646;

/**
 * What the one body still authored here measures in world units at model
 * scale 1, above/below origin — matches the species files' envelopes
 * (species/fish.ts's crownY/bellyY), read by placement.ts's BODY_COLUMNS so
 * a flame covers the body actually drawn. Centre-origin ellipsoid.
 */
export const BIRD_ENVELOPE = {
  /** Body ellipsoid full height 0.18; wings are thinner than the body. */
  crownY: 0.09,
  bellyY: -0.09,
} as const;

/**
 * Wing beats per second — the fastest animation here (convention: slower =
 * larger), also just true of small birds.
 *
 * Bounded by the display: at 60 fps a 5.5 Hz cycle is ~11 frames, so the
 * wing is drawn several times per stroke and reads as flapping. Push toward
 * 10 Hz and consecutive frames land on opposite stroke ends — aliasing into
 * a blur or an apparent backward beat.
 */
const BIRD_WING_FLAP_HZ = 5.5;

/**
 * Half the wing's travel, radians. 0.7 is ~40° either side of level (an 80°
 * stroke) — the range at which a wing seen from above visibly changes its
 * projected width. Smaller reads as a rigid glider; much larger folds the
 * wings over the bird's own back.
 */
const BIRD_WING_FLAP_RADIANS = 0.7;
/** Vertical body travel over one wing beat, world units. Tiny by design: rises fractionally on the downstroke so the flap doesn't look like a hinge on a static body — same trick as the fish's counter-roll. */
const BIRD_BODY_BOB = 0.04;
/** Span of one wing panel, world units. Two plus the body give a ~1.3-unit wingspan against a 0.6-unit body, sized larger than a fish since a bird is seen from further away (BIRD_FLIGHT_WORLD_Y). */
const BIRD_WING_LENGTH = 0.62;
/** Where a wing's pivot sits along Z relative to its panel: half the panel's length, so the inner edge lands on the body centreline and the hinge sits at the shoulder. Derived so the two can't drift apart. */
const BIRD_WING_ROOT_OFFSET = BIRD_WING_LENGTH / 2;

const TWO_PI = Math.PI * 2;

/**
 * Distinct animation phases one species is drawn with in a single frame.
 *
 * WHY QUANTISING PHASE IS SAFE. Every animation is a loop driven by one
 * angle, so slotting a phase shifts it along the loop by at most one slot,
 * never changing what the animation IS. At the project's 140 fps target the
 * fastest loop here (a hunting wolf, ~9.6 strides/s) advances ~1/15 of a
 * cycle between two seen frames, and the bird's wing (5.5 Hz) ~1/25 — a
 * 1/32-cycle quantisation step is smaller than the animation's own step.
 *
 * WHY IT'S WORTH IT. The pose palette rebuilds once per SLOT per frame, not
 * per creature: at population cap that's 32 poses instead of 850, making
 * frame cost independent of population (render/rigHerd.ts).
 */
const POSE_SLOTS_PER_HERD = 32;

/** One species (or one whale body) as it is DRAWN: a herd of instances sharing one set of buffers, and the idle animation that poses them. */
interface SpeciesDrawable {
  readonly herd: RigHerd;
  /** Poses the herd's scratch rig. `seconds` is elapsed time; `phase` is the offset in radians of the pose slot being filled. */
  animate(seconds: number, phase: number, gait: MoverGait): void;
}

export interface WildlifeModels {
  /** The drawn objects — one per species surface, not one per creature. Added to the scene once by the caller and never re-parented. */
  readonly objects: readonly Object3D[];
  /** Opens a frame. `seconds` is the animation clock every pose is read at. */
  beginFrame(seconds: number): void;
  /**
   * Draws one creature this frame.
   *
   * `sizeClass` scales the whole rig uniformly — geometries stay shared and
   * un-scaled (medium-sized authoring, see WILDLIFE_SIZE_MODEL_SCALE), so a
   * size class costs three numbers in an instance matrix, not a second
   * buffer copy. The species' own draw scale rides the same number (./modelScale.ts).
   *
   * `variantSeed` picks between bodies where a species has more than one —
   * only whales do. Must be STABLE for a creature's whole life (the caller
   * passes its entity id), or it would change species between frames.
   *
   * `phase` is the creature's animation offset in radians; `gait` (the kit's
   * `moverGaitOf`) picks which animation the pose comes from; `yaw` is
   * rotation about Y from the creature's heading.
   *
   * Positional arguments, not a pose object: called once per creature per
   * frame, and a fresh object each time is 850 allocations a frame for nothing.
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
  /** Closes a frame: uploads the poses and placements it collected. */
  endFrame(): void;
  /** Frees every shared geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/**
 * Builds the shared geometry/material pool and the per-species herds.
 *
 * `instanceCapacity` is the most creatures of ONE species that may be drawn in
 * a frame; the caller's population cap is the honest value.
 */
export function createWildlifeModels(instanceCapacity: number): WildlifeModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  /** Registers a geometry for disposal and returns it. */
  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  /** Flat-shaded by default: reads as deliberate faceting with 6-segment spheres. Swept-hull species (ibex, bison) opt out via the pool contract's option. */
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

  /** A sphere pre-scaled into an ellipsoid of the given world-unit extents. */
  function ellipsoid(length: number, height: number, width: number): SphereGeometry {
    const geometry = new SphereGeometry(0.5, SPHERE_SEGMENTS, SPHERE_RINGS);
    geometry.scale(length, height, width);
    return keepGeometry(geometry);
  }

  // ── Shared resources, built once ───────────────────────────────────────────

  // Authored roughly one cell across the wings — twice its body length, a
  // bird's real proportions. Bigger than a fish (0.55 long) since it's seen
  // from BIRD_FLIGHT_WORLD_Y, further than anything else here.
  const birdMaterial = lambert(BIRD_COLOR);
  const birdBody = ellipsoid(0.6, BIRD_ENVELOPE.crownY - BIRD_ENVELOPE.bellyY, 0.18);
  /** One wing panel. Its LENGTH runs along Z, so it hinges about the X axis. */
  const birdWing = keepGeometry(new BoxGeometry(0.32, 0.03, BIRD_WING_LENGTH));
  const birdTail = keepGeometry(new ConeGeometry(0.13, 0.26, CONE_SEGMENTS));
  birdTail.rotateZ(Math.PI / 2);

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

  /**
   * Root + inner rig, as AUTHORED. Built exactly once per species and handed
   * to `bakeRig`, which turns it into one skinned drawable; `rig` and any
   * hinge under it become bones an individual creature animates. See
   * render/rigSkin.ts — the authoring style is unchanged, only what the
   * renderer draws is.
   */
  function rigged(): { root: Group; rig: Group } {
    const root = new Group();
    const rig = new Group();
    root.add(rig);
    return { root, rig };
  }

  /**
   * A species' baked rig: the shared buffers, plus the joint index of every
   * node its animation drives.
   *
   * Named joints, not positional: `joints.leftWing` reads far better than
   * `joints[3]`, and a reordering bake would otherwise silently swap limbs.
   */
  interface SpeciesRig {
    readonly blueprint: RigBlueprint;
    readonly jointIndices: Readonly<Record<string, number>>;
    /** The authored root, baked as a bone like any other. Named apart from the species' own joints: the gait's body tilt (`applyMoverBodyTilt`) goes here — the one node a species file cannot reach and so cannot fight. */
    readonly rootJoint: number;
  }

  const speciesRigs: SpeciesRig[] = [];

  /** Bakes one authored tree and registers it for disposal. */
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

  /** The whole species as one herd, plus the named handles its animation drives — named for the same reason bakeSpecies captures joints by name. */
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
   * THE ONE PLACE a creature turns into an instance.
   *
   * A pose is built at most once per slot per frame — the first creature to
   * land in a slot pays for it, every other creature in that slot rides free.
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

  /** The pool as a species file sees it: the same helpers this file uses, via the ./species/speciesModel.ts interface. One implementation of each — a species file's geometry lands in the same disposal lists as the bird's. */
  const speciesPool: SpeciesModelPool = { keepGeometry, lambert, unlit, part, rigged };

  /**
   * Builds one species from its own file: author, bake, herd, and wrap its
   * `animate` in the `SpeciesDrawable` shape the draw path speaks.
   *
   * The species file names its own joints and drives them; nothing here
   * knows what a fin or a hind leg is — the whole point of the split.
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

  // ── The rig authored HERE, once ────────────────────────────────────────────

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

  // ── One herd each ──────────────────────────────────────────────────────────
  //
  // Built ONCE, not per creature: a per-individual model is now a per-species
  // drawable whose `animate` poses the shared scratch rig. Animation bodies
  // are unchanged — still `joint.rotation.z = …` against a Bone.

  // The nine species authored in ./species/. Order fixes the order their
  // surfaces appear in `objects`, counted against in ./index.ts's draw-object table.
  const fishDrawable = speciesDrawable(buildFish);
  const grazerDrawable = speciesDrawable(buildGrazer);
  const wolfDrawable = speciesDrawable(buildWolf);
  const ibexDrawable = speciesDrawable(buildIbex);
  const bisonDrawable = speciesDrawable(buildBison);
  const rayDrawable = speciesDrawable(buildRay);
  const sharkDrawable = speciesDrawable(buildShark);
  const eelDrawable = speciesDrawable(buildEel);
  const angelfishDrawable = speciesDrawable(buildAngelfish);

  /** One whale body per WHALE_SPECIES entry; `drawableOf` indexes by the stable per-creature seed. */
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

  /** The herd a creature of this species belongs to. */
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
      // The baked rigs own buffers of their own — merged geometry and
      // vertex-coloured material per species — on top of the authored pool
      // the two loops below free.
      for (const rig of speciesRigs) rig.blueprint.dispose();
      speciesRigs.length = 0;
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
