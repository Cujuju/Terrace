// Low-poly procedural creatures: spheres, cones and boxes, flat-shaded, in five
// silhouettes you can tell apart at fifty cells.
//
// Rules this file keeps:
//   * NO textures, NO per-creature lights, NO external assets. Everything is
//     generated here; the scene's hemisphere + sun light (render/scene.ts) does
//     all the lighting, and flat shading is what makes a 6-segment sphere read as
//     a deliberate faceted style rather than as a low-detail mistake.
//   * GEOMETRIES AND MATERIALS ARE SHARED across every instance of a species and
//     built exactly once. Per-creature allocation would be a hundred BufferGeometry
//     uploads that are all byte-identical. `dispose()` frees them once too.
//   * The origin is the creature's PIVOT: feet for a walker, body centre for a
//     swimmer, and the model faces +X (see index.ts for the heading → rotation.y
//     mapping).
//
//   * A CREATURE IS NOT A SCENE OBJECT. Every individual used to carry a root
//     Group, a Skeleton, a Bone per joint and a SkinnedMesh per surface — ~8 300
//     Object3Ds at the population cap, all of them walked by three's
//     updateMatrixWorld before culling could reject any (perf review
//     2026-08-29, A2). Now a whole species is one InstancedMesh per baked
//     surface: `create` became `draw`, and the scene object count is O(species)
//     rather than O(creatures). See client/src/render/rigHerd.ts.

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
// Render kit, reached the same way client/src/plugins/registry.ts reaches this
// plugin — by path. See that module's header for why it lives there.
import { bakeRig, type RigBlueprint } from '../../../client/src/render/rigSkin.ts';
import { createRigHerd, type RigHerd } from '../../../client/src/render/rigHerd.ts';
import {
  assembleWhale,
  buildWhaleGeometrySets,
  geometriesOf,
  type WhaleGeometrySet,
} from './whaleSpecies.ts';
import {
  WILDLIFE_SIZE_MODEL_SCALE,
  type WildlifeSizeClass,
  type WildlifeSpecies,
} from '../protocol.ts';

/**
 * Sphere tessellation. 6 segments around, 4 rings tall: the fewest that still
 * reads as a body rather than a die, and with flatShading it gives the chunky
 * facets the terraced terrain already has.
 */
const SPHERE_SEGMENTS = 6;
const SPHERE_RINGS = 4;
/** Cones and the whale's flukes are 4-sided — pyramids, deliberately. */
const CONE_SEGMENTS = 4;

/** Distinct hues, each picked to sit against its own background. */
const FISH_COLOR = 0xe8a13c; // warm orange against blue shallows
const WHALE_COLOR = 0x39506b; // dark slate; big, so it needs no help
const DEEPSEA_COLOR = 0x161c26; // near-black, an abyssal silhouette
const DEEPSEA_LURE_COLOR = 0xa8fbff; // the one bright thing down there
/**
 * Uniform scale on the grazer's authored dimensions, applied at authoring time
 * so the geometry itself is the shipped size (nothing downstream has to know).
 *
 * Owner, 2026-08-24: grazers read as oversized beside the settlers. Authored at
 * 1.0 a grazer stands 0.93 world units tall against PILGRIM_HEIGHT 0.62, i.e.
 * half again as tall as a Rudy or an Uno; 0.4 puts it at ~0.37 — plainly a
 * smaller animal than the people who live beside it, without shrinking to the
 * rodent scale a literal one-fifth would give.
 *
 * WALKER_FOOTPRINT_HALF_EXTENT (client/placement.ts) is derived from the body
 * length this scales, and moves with it.
 */
const GRAZER_SCALE = 0.4;

const GRAZER_BODY_COLOR = 0xa8814f; // tan, warmer than any terrain band
const GRAZER_LEG_COLOR = 0x6d5334;
/**
 * Birds are read as SILHOUETTES, not as coloured objects: they are the only
 * creature seen against the sky (0x9fc7e8 in render/scene.ts) rather than
 * against terrain or water, and they are the smallest thing on screen. A dark
 * slate keeps that contrast from every camera angle — a bird tinted to look
 * "right" in isolation would vanish into the background at distance, which is
 * the only distance birds are ever seen from.
 */
const BIRD_COLOR = 0x2e3646;

/** Idle-animation rates, in cycles per second. Slower = larger, by convention. */
const FISH_TAIL_HZ = 3.2;
const WHALE_FLUKE_HZ = 0.45;
const DEEPSEA_SWAY_HZ = 0.7;
const GRAZER_BOB_HZ = 2.4;
/**
 * Wing beats per second. The fastest animation here, which is the convention
 * this list follows (slower = larger) and also just true of small birds.
 *
 * Bounded above by the display, not by taste: at 60 fps a 5.5 Hz cycle is ~11
 * frames, so the wing is drawn several times on each stroke and reads as
 * flapping. Push it toward 10 Hz and consecutive frames start landing on
 * opposite ends of the stroke — the wing aliases into a blur or, worse, appears
 * to beat slowly backwards.
 */
const BIRD_WING_FLAP_HZ = 5.5;

const FISH_TAIL_SWING_RADIANS = 0.55;
const WHALE_FLUKE_SWING_RADIANS = 0.3;
const DEEPSEA_SWAY_RADIANS = 0.22;
/** Vertical travel of the walk bob, in world units (= cells). */
const GRAZER_BOB_AMPLITUDE = 0.05 * GRAZER_SCALE;
/** How far the lure bobs on its stalk, in world units. */
const DEEPSEA_LURE_BOB = 0.05;
/**
 * Half the wing's travel, in radians. 0.7 is ~40° either side of level — a 80°
 * total stroke, which is the range at which a wing seen from above (this game's
 * camera) visibly changes its projected width. A smaller stroke reads as a rigid
 * glider; a much larger one folds the wings over the bird's own back.
 */
const BIRD_WING_FLAP_RADIANS = 0.7;
/**
 * Vertical travel of the body over one wing beat, in world units. Tiny by
 * design: it exists so the bird rises fractionally on the downstroke, which is
 * what stops the flap looking like a hinge bolted to a static body. Same trick,
 * same scale, as the fish's counter-roll.
 */
const BIRD_BODY_BOB = 0.04;
/**
 * Span of ONE wing panel, in world units. Two of them plus the body gives a
 * ~1.3-unit wingspan against a 0.6-unit body — roughly a bird's proportions, and
 * more than twice a fish's total length, because a bird is drawn at
 * BIRD_FLIGHT_WORLD_Y and is the furthest thing in this file from the camera.
 */
const BIRD_WING_LENGTH = 0.62;
/**
 * Where a wing's pivot sits relative to its panel, along Z: half the panel's own
 * length, so the panel's inner edge lands on the body's centreline and the hinge
 * is at the shoulder rather than out in mid-air. Derived, so the two cannot
 * drift apart.
 */
const BIRD_WING_ROOT_OFFSET = BIRD_WING_LENGTH / 2;

/**
 * The whale's pectoral, dorsal and fluke geometry moved to whaleSpecies.ts on
 * 2026-08-21, along with the constants that placed them on the old stacked-
 * ellipsoid rig (WHALE_PECTORAL_SPAN and friends, WHALE_DORSAL_HEIGHT). The
 * clearance reasoning those comments carried — why a whale's crown may not pass
 * y = 0.670 and its belly may not pass y = -0.575, and the 2026-08-19 report of
 * a whale that read as capsized because its dorsal was buried — now lives on
 * WHALE_ENVELOPE, which every whale body is fitted into. Nothing was lost; it
 * moved to where the numbers are used.
 */

const TWO_PI = Math.PI * 2;

/**
 * Distinct animation phases one species is drawn with in a single frame.
 *
 * WHY QUANTISING PHASE IS SAFE. Every animation below is a loop driven by
 * `seconds * HZ * TWO_PI + phase`, so slotting a creature's phase offset shifts
 * it along the loop by at most one slot — it never changes what the animation
 * IS. The bound that matters is the display: at the project's 140 fps target
 * the fastest animation here (BIRD_WING_FLAP_HZ, 5.5) advances 5.5/140 ≈ 1/25
 * of a cycle between two frames the player actually sees, so a quantisation
 * step of 1/32 of a cycle is smaller than the step the animation already takes
 * on its own. Anything the player could resolve, they resolve as motion.
 *
 * WHY IT IS WORTH IT. The pose palette is rebuilt once per SLOT per frame, not
 * once per creature: at the population cap that is 32 poses per species instead
 * of 850, and it is what makes the frame cost independent of how many creatures
 * are alive (client/src/render/rigHerd.ts).
 */
const POSE_SLOTS_PER_HERD = 32;

/**
 * One species (or one whale body) as it is DRAWN: a herd of instances sharing
 * one set of buffers, and the idle animation that poses them.
 */
interface SpeciesDrawable {
  readonly herd: RigHerd;
  /**
   * Poses the herd's scratch rig. `seconds` is elapsed time; `phase` is the
   * offset in radians of the pose slot being filled.
   */
  animate(seconds: number, phase: number): void;
}

export interface WildlifeModels {
  /**
   * The drawn objects — one per species surface, NOT one per creature. Added to
   * the scene once by the caller and never re-parented.
   */
  readonly objects: readonly Object3D[];
  /** Opens a frame. `seconds` is the animation clock every pose is read at. */
  beginFrame(seconds: number): void;
  /**
   * Draws one creature this frame.
   *
   * `sizeClass` scales the whole rig uniformly — the geometries stay shared and
   * un-scaled (they are the medium-sized authoring, see
   * WILDLIFE_SIZE_MODEL_SCALE), so a size class costs three numbers in an
   * instance matrix and not a second copy of every buffer.
   *
   * `variantSeed` picks between bodies where a species has more than one — only
   * whales do. It must be STABLE for a creature's whole life (the caller passes
   * its entity id), or an individual would change species between frames.
   *
   * `phase` is the creature's own animation offset in radians; `yaw` is the
   * rotation about Y the caller derives from the creature's heading.
   *
   * Positional arguments rather than a pose object, deliberately: this is
   * called once per creature per frame, and a fresh object each time is 850
   * allocations a frame for nothing.
   */
  draw(
    species: WildlifeSpecies,
    sizeClass: WildlifeSizeClass,
    variantSeed: number,
    phase: number,
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

  /**
   * Flat-shaded by default: with 6-segment spheres that is what reads as a
   * deliberate faceted style rather than as low detail. Whales opt out — see
   * whaleMaterial.
   */
  function lambert(color: number, options: { flatShading?: boolean } = {}): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color, flatShading: options.flatShading ?? true });
    materials.push(material);
    return material;
  }

  /** Unlit — the lure must glow without costing a light. */
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

  const fishMaterial = lambert(FISH_COLOR);
  const fishBody = ellipsoid(0.55, 0.26, 0.18);
  // Cones are built pointing +Y; rotate once, in geometry space, so every
  // instance inherits the orientation for free.
  const fishTail = keepGeometry(new ConeGeometry(0.16, 0.3, CONE_SEGMENTS));
  fishTail.rotateZ(Math.PI / 2);

  // Whales are smooth-shaded, unlike everything else in this pool: their bodies
  // are swept surfaces built in whaleSpecies.ts, where faceting would show as
  // banding on a body this large rather than as the deliberate chunky style the
  // other four keep.
  const whaleMaterial = lambert(WHALE_COLOR, { flatShading: false });
  // All three whale bodies, built once and shared by every whale in the world.
  const whaleSets: readonly WhaleGeometrySet[] = buildWhaleGeometrySets();
  for (const set of whaleSets) {
    for (const geometry of geometriesOf(set)) keepGeometry(geometry);
  }

  const deepseaMaterial = lambert(DEEPSEA_COLOR);
  const deepseaLureMaterial = unlit(DEEPSEA_LURE_COLOR);
  const deepseaBody = ellipsoid(1, 0.7, 0.55);
  const deepseaJaw = keepGeometry(new ConeGeometry(0.3, 0.45, CONE_SEGMENTS));
  deepseaJaw.rotateZ(-Math.PI / 2);
  const deepseaStalk = keepGeometry(new BoxGeometry(0.5, 0.04, 0.04));
  const deepseaLure = ellipsoid(0.14, 0.14, 0.14);

  // A bird is authored roughly one cell across the wings — twice its body
  // length, which is what a bird's proportions are and what makes the silhouette
  // read as a bird rather than as a small fish flying. It is bigger than a fish
  // (0.55 long) on purpose: it is seen from BIRD_FLIGHT_WORLD_Y further away
  // than anything else in this file.
  const birdMaterial = lambert(BIRD_COLOR);
  const birdBody = ellipsoid(0.6, 0.18, 0.18);
  /** One wing panel. Its LENGTH runs along Z, so it hinges about the X axis. */
  const birdWing = keepGeometry(new BoxGeometry(0.32, 0.03, BIRD_WING_LENGTH));
  const birdTail = keepGeometry(new ConeGeometry(0.13, 0.26, CONE_SEGMENTS));
  birdTail.rotateZ(Math.PI / 2);

  const grazerBodyMaterial = lambert(GRAZER_BODY_COLOR);
  const grazerLegMaterial = lambert(GRAZER_LEG_COLOR);
  const grazerBody = keepGeometry(
    new BoxGeometry(0.85 * GRAZER_SCALE, 0.4 * GRAZER_SCALE, 0.45 * GRAZER_SCALE),
  );
  const grazerHead = ellipsoid(0.34 * GRAZER_SCALE, 0.3 * GRAZER_SCALE, 0.28 * GRAZER_SCALE);
  const grazerLeg = keepGeometry(
    new BoxGeometry(0.1 * GRAZER_SCALE, 0.42 * GRAZER_SCALE, 0.1 * GRAZER_SCALE),
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

  /**
   * Root + inner rig, as AUTHORED. The tree below is built exactly once per
   * species and handed to `bakeRig`, which turns it into one skinned drawable;
   * `rig` and any hinge under it become bones an individual creature animates.
   * See client/src/render/rigSkin.ts — the authoring style here is unchanged,
   * only what the renderer is asked to draw is.
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
   * Named joints rather than positional ones because an animation reads far
   * better as `joints.leftWing` than as `joints[3]`, and a bake that reordered
   * its nodes would otherwise silently swap two limbs.
   */
  interface SpeciesRig {
    readonly blueprint: RigBlueprint;
    readonly jointIndices: Readonly<Record<string, number>>;
  }

  const speciesRigs: SpeciesRig[] = [];

  /** Bakes one authored tree and registers it for disposal. */
  function bakeSpecies(root: Group, joints: Readonly<Record<string, Object3D>>): SpeciesRig {
    const blueprint = bakeRig(root);
    const jointIndices: Record<string, number> = {};
    for (const [name, node] of Object.entries(joints)) {
      jointIndices[name] = blueprint.jointIndex(node);
    }
    const rig: SpeciesRig = { blueprint, jointIndices };
    speciesRigs.push(rig);
    return rig;
  }

  const herds: RigHerd[] = [];

  /**
   * The whole species as one herd, plus the named handles its animation drives.
   *
   * Named joints rather than positional ones for the same reason bakeSpecies
   * captures them by name: `joints.leftWing` reads, `joints[3]` does not.
   */
  function herdFor(rig: SpeciesRig): { herd: RigHerd; joints: Readonly<Record<string, Bone>> } {
    const herd = createRigHerd(rig.blueprint, {
      capacity: instanceCapacity,
      poseSlots: POSE_SLOTS_PER_HERD,
    });
    herds.push(herd);
    const joints: Record<string, Bone> = {};
    for (const [name, index] of Object.entries(rig.jointIndices)) {
      joints[name] = herd.joints[index]!;
    }
    return { herd, joints };
  }

  /**
   * THE ONE PLACE a creature turns into an instance.
   *
   * A pose is built at most once per slot per frame — the first creature to
   * land in a slot pays for it and every other creature in that slot rides it
   * free, which is the whole reason the frame cost stops scaling with the
   * population.
   */
  function drawInto(
    drawable: SpeciesDrawable,
    seconds: number,
    phase: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
  ): void {
    const herd = drawable.herd;
    const slot = herd.poseSlotOf(phase);
    if (herd.needsPose(slot)) {
      drawable.animate(seconds, herd.poseSlotPhase(slot));
      herd.capturePose(slot);
    }
    herd.place(slot, x, y, z, yaw, scale);
  }

  // ── The five rigs, authored once ───────────────────────────────────────────

  const fishRig = (() => {
    const { root, rig } = rigged();
    rig.add(part(fishBody, fishMaterial, 0, 0, 0));
    const tail = part(fishTail, fishMaterial, -0.36, 0, 0);
    rig.add(tail);
    return bakeSpecies(root, { rig, tail });
  })();

  /**
   * A whale, drawn as one of three real species (whaleSpecies.ts). Which one is
   * decided by the caller's stable per-creature seed, so an individual keeps
   * the same body for its whole life.
   *
   * These are the one exception to this file's "spheres, cones and boxes,
   * flat-shaded" rule: smooth-shaded swept surfaces at a few thousand
   * triangles, by owner decision (2026-08-21). A whale is the largest thing in
   * the water and the one creature the camera comes near, where a stack of
   * ellipsoids reads as a stack of ellipsoids. The cost is bounded — whales are
   * habitat-capped by their 2 000-square-world-unit density (cellsOverArea):
   * at most 39 of them on a fully revealed nominal 512² world, 21 once
   * WILDLIFE_POPULATION_CAP has scaled the population down. And since the
   * 2026-08-22 skinning each body is ONE draw call rather than the six the
   * note here used to record.
   */
  const whaleRigs: readonly SpeciesRig[] = whaleSets.map((set) => {
    const { root, rig } = rigged();
    const { body, flukes } = assembleWhale(set, whaleMaterial);
    rig.add(body);
    return bakeSpecies(root, { rig, flukes });
  });

  const deepseaRig = (() => {
    const { root, rig } = rigged();
    rig.add(part(deepseaBody, deepseaMaterial, 0, 0, 0));
    rig.add(part(deepseaJaw, deepseaMaterial, 0.5, -0.12, 0));
    rig.add(part(deepseaStalk, deepseaMaterial, 0.42, 0.34, 0));
    // The lure is a JOINT, not just a part: it bobs on its own, so it must be a
    // bone the skinned surface can follow rather than a vertex block frozen
    // into the body. It is also unlit, so it is its own draw either way.
    const lure = new Group();
    lure.position.set(0.68, 0.36, 0);
    lure.add(part(deepseaLure, deepseaLureMaterial, 0, 0, 0));
    rig.add(lure);
    return bakeSpecies(root, { rig, lure });
  })();

  const grazerRig = (() => {
    const { root, rig } = rigged();
    // Origin at the feet: legs occupy y 0…0.42, body sits on top of them. Every
    // offset here is an authored dimension, so it takes GRAZER_SCALE too — a
    // scaled body on unscaled offsets is a floating head and detached legs.
    const legY = 0.21 * GRAZER_SCALE;
    const bodyY = 0.62 * GRAZER_SCALE;
    rig.add(part(grazerBody, grazerBodyMaterial, 0, bodyY, 0));
    rig.add(part(grazerHead, grazerBodyMaterial, 0.5 * GRAZER_SCALE, bodyY + 0.16 * GRAZER_SCALE, 0));
    for (const [lx, lz] of [
      [0.3, 0.16],
      [0.3, -0.16],
      [-0.3, 0.16],
      [-0.3, -0.16],
    ] as const) {
      rig.add(part(grazerLeg, grazerLegMaterial, lx * GRAZER_SCALE, legY, lz * GRAZER_SCALE));
    }
    return bakeSpecies(root, { rig });
  })();

  const birdRig = (() => {
    const { root, rig } = rigged();
    rig.add(part(birdBody, birdMaterial, 0, 0, 0));
    rig.add(part(birdTail, birdMaterial, -0.38, 0, 0));

    // Each wing gets its own pivot Group AT THE SHOULDER, with the panel offset
    // outboard inside it. Rotating the panel directly would swing it about its
    // own centre, which lifts the root through the bird's back and drops the tip
    // only half as far as it should.
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
  // Built ONCE, not per creature: what used to be a per-individual model is now
  // a per-species drawable whose `animate` poses the shared scratch rig. The
  // animation bodies themselves are unchanged — they still say
  // `joint.rotation.z = …` against a Bone.

  const fishDrawable = ((): SpeciesDrawable => {
    const { herd, joints } = herdFor(fishRig);
    const rig = joints.rig!;
    const tail = joints.tail!;
    return {
      herd,
      animate(seconds, phase) {
        // Tail sweeps side to side; the body counter-rolls a little so the whole
        // fish undulates instead of dragging a hinged flap.
        const swing = Math.sin(seconds * FISH_TAIL_HZ * TWO_PI + phase);
        tail.rotation.y = swing * FISH_TAIL_SWING_RADIANS;
        rig.rotation.z = swing * FISH_TAIL_SWING_RADIANS * 0.15;
      },
    };
  })();

  const whaleDrawables: readonly SpeciesDrawable[] = whaleRigs.map((whaleRig) => {
    const { herd, joints } = herdFor(whaleRig);
    const rig = joints.rig!;
    const flukes = joints.flukes!;
    return {
      herd,
      animate(seconds: number, phase: number) {
        // Whales flap vertically, slowly. Pitch about Z, the axis across a model
        // that faces +X.
        const swing = Math.sin(seconds * WHALE_FLUKE_HZ * TWO_PI + phase);
        flukes.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS;
        rig.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS * 0.12;
      },
    };
  });

  const deepseaDrawable = ((): SpeciesDrawable => {
    const { herd, joints } = herdFor(deepseaRig);
    const rig = joints.rig!;
    const lure = joints.lure!;
    const lureRestY = lure.position.y;
    return {
      herd,
      animate(seconds, phase) {
        const sway = Math.sin(seconds * DEEPSEA_SWAY_HZ * TWO_PI + phase);
        rig.rotation.y = sway * DEEPSEA_SWAY_RADIANS;
        // The lure lags the body, which is what sells it as dangling.
        lure.position.y = lureRestY + Math.sin(seconds * DEEPSEA_SWAY_HZ * TWO_PI + phase - 1) * DEEPSEA_LURE_BOB;
      },
    };
  })();

  const grazerDrawable = ((): SpeciesDrawable => {
    const { herd, joints } = herdFor(grazerRig);
    const rig = joints.rig!;
    return {
      herd,
      animate(seconds, phase) {
        // A walk bob: |sin| gives two rises per stride, one per pair of legs.
        rig.position.y = Math.abs(Math.sin(seconds * GRAZER_BOB_HZ * Math.PI + phase)) * GRAZER_BOB_AMPLITUDE;
      },
    };
  })();

  const birdDrawable = ((): SpeciesDrawable => {
    const { herd, joints } = herdFor(birdRig);
    const rig = joints.rig!;
    const leftWing = joints.leftWing!;
    const rightWing = joints.rightWing!;
    return {
      herd,
      animate(seconds, phase) {
        const swing = Math.sin(seconds * BIRD_WING_FLAP_HZ * TWO_PI + phase);
        // Rotation about X maps a point at +Z to y = -L·sin(θ), so the two wings
        // take OPPOSITE signs to send both tips the same way. Getting this wrong
        // is a bird rolling on the spot rather than flapping.
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
    draw(species, sizeClass, variantSeed, phase, x, y, z, yaw) {
      drawInto(
        drawableOf(species, variantSeed),
        animationSeconds,
        phase,
        x,
        y,
        z,
        yaw,
        // Uniform, in the instance matrix: the pose palette holds rig-space
        // transforms only, so nothing an animation does can overwrite it.
        WILDLIFE_SIZE_MODEL_SCALE[sizeClass],
      );
    },
    endFrame() {
      for (const herd of herds) herd.endFrame();
    },
    dispose() {
      for (const herd of herds) herd.dispose();
      herds.length = 0;
      objects.length = 0;
      // The baked rigs own buffers of their own — the merged geometry and the
      // vertex-coloured material per species — on top of the authored pool the
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
