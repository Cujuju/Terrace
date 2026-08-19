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
// RESIDUAL, stated rather than hidden: each creature is 2–7 Mesh objects (the
// whale, at 7, is the ceiling — head/torso/tail-stock/flukes/dorsal/2
// pectorals), so a full 512² population is roughly 330 draw calls. That sits alongside the
// terrain's up-to-1024 chunk meshes, so it is not the bottleneck; if it ever
// becomes one, merging each species' static parts into a single BufferGeometry
// (three/addons BufferGeometryUtils) collapses it to ~2 per creature.

import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
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
const GRAZER_BOB_AMPLITUDE = 0.05;
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
 * Span of ONE pectoral fin panel, in world units. Mirrors BIRD_WING_LENGTH's
 * role for the wing: the panel's own length, from which its root offset is
 * derived below so the two numbers cannot drift apart.
 */
const WHALE_PECTORAL_SPAN = 0.9;
/** Half the pectoral panel's span — see BIRD_WING_ROOT_OFFSET for the same derivation. */
const WHALE_PECTORAL_ROOT_OFFSET = WHALE_PECTORAL_SPAN / 2;
/**
 * Static droop of each pectoral fin about its pivot's local X, in radians.
 * Real flippers hang down and back; they do not flap, so this is baked into
 * the rig once at creation rather than driven from `animate`.
 */
const WHALE_PECTORAL_DOWNSWEEP_RADIANS = 0.35;
/** Static backward sweep of each pectoral fin about its pivot's local Y, in radians. */
const WHALE_PECTORAL_BACKSWEEP_RADIANS = 0.3;
/**
 * Height of the dorsal hump cone, in world units. Kept deliberately small — a
 * rorqual's dorsal is a stubby backward hook, not a shark's tall fin (the
 * shape this replaces: see git history for the single 0.7-tall cone this used
 * to be). Sized against SWIM_PROFILES.whale (client/placement.ts), which
 * guarantees only 0.7 of clearance between the swim origin and the sea
 * surface: at the hump's x-position (-0.3, embedded at y=0.42) the torso
 * ellipsoid's own surface sits at y≈0.53, so the hump's crown lands at
 * y≈0.54 — a 0.16 margin under the 0.7 budget. Confirmed numerically and
 * against the preview render, not trusted from a single arithmetic pass.
 */
const WHALE_DORSAL_HEIGHT = 0.24;

const TWO_PI = Math.PI * 2;

/** One creature's scene object plus its idle animation. */
export interface CreatureModel {
  /** Positioned and yawed by the caller; never touched by `animate`. */
  readonly root: Group;
  /** `seconds` is elapsed time; `phase` is a per-creature offset in radians. */
  animate(seconds: number, phase: number): void;
}

export interface WildlifeModels {
  /**
   * Builds one creature. `sizeClass` scales the whole rig uniformly — the
   * geometries stay shared and un-scaled (they are the medium-sized authoring,
   * see WILDLIFE_SIZE_MODEL_SCALE), so a size class costs a transform on the
   * root Group and not a second copy of every buffer.
   */
  create(species: WildlifeSpecies, sizeClass: WildlifeSizeClass): CreatureModel;
  /** Frees every shared geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/** Builds the shared geometry/material pool and the per-species constructors. */
export function createWildlifeModels(): WildlifeModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  /** Registers a geometry for disposal and returns it. */
  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function lambert(color: number): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color, flatShading: true });
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

  const whaleMaterial = lambert(WHALE_COLOR);
  // Body: three ellipsoids stacked nose-to-tail rather than one. A single
  // ellipsoid tapers the same amount at both ends; a whale does not — it is
  // blunt up front, widest amidships, and draws out into a long tapered
  // peduncle at the back. Each piece is positioned in createWhale() to
  // overlap its neighbour, the same seam-hiding trick the flukes already use
  // against the tail stock.
  const whaleHead = ellipsoid(1.0, 0.8, 1.0);
  const whaleTorso = ellipsoid(2.4, 1.15, 1.45);
  const whaleTailStock = ellipsoid(2.0, 0.6, 0.8);
  const whaleFlukes = keepGeometry(new BoxGeometry(0.6, 0.12, 2.3));
  // Apex points +Y already — exactly what a hump sitting on the whale's back
  // needs, so unlike the fish tail / deepsea jaw this cone needs no rotate.
  const whaleDorsal = keepGeometry(new ConeGeometry(0.2, WHALE_DORSAL_HEIGHT, CONE_SEGMENTS));
  // A flat panel, like the flukes: a pectoral fin has no radial symmetry to
  // exploit (a cone would look like a spike, not a flipper), and a box is
  // left/right-symmetric for free, so the SAME geometry serves both sides —
  // see the pivot-per-side mirroring in createWhale().
  const whalePectoralFin = keepGeometry(new BoxGeometry(0.55, 0.06, WHALE_PECTORAL_SPAN));

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
  const grazerBody = keepGeometry(new BoxGeometry(0.85, 0.4, 0.45));
  const grazerHead = ellipsoid(0.34, 0.3, 0.28);
  const grazerLeg = keepGeometry(new BoxGeometry(0.1, 0.42, 0.1));

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

  /** Root + inner rig. The caller owns `root`; animation only moves `rig`. */
  function rigged(): { root: Group; rig: Group } {
    const root = new Group();
    const rig = new Group();
    root.add(rig);
    return { root, rig };
  }

  function createFish(): CreatureModel {
    const { root, rig } = rigged();
    rig.add(part(fishBody, fishMaterial, 0, 0, 0));
    const tail = part(fishTail, fishMaterial, -0.36, 0, 0);
    rig.add(tail);
    return {
      root,
      animate(seconds, phase) {
        // Tail sweeps side to side; the body counter-rolls a little so the whole
        // fish undulates instead of dragging a hinged flap.
        const swing = Math.sin(seconds * FISH_TAIL_HZ * TWO_PI + phase);
        tail.rotation.y = swing * FISH_TAIL_SWING_RADIANS;
        rig.rotation.z = swing * FISH_TAIL_SWING_RADIANS * 0.15;
      },
    };
  }

  function createWhale(): CreatureModel {
    const { root, rig } = rigged();
    // Nose-to-tail: head, torso, tail stock. Positions overlap their
    // neighbour by a wide margin (0.2–0.55 world units) so the flat-shaded
    // facets never show a seam — same tolerance the original body/flukes join
    // already relied on.
    rig.add(part(whaleHead, whaleMaterial, 1.55, 0, 0));
    rig.add(part(whaleTorso, whaleMaterial, 0.15, 0, 0));
    rig.add(part(whaleTailStock, whaleMaterial, -1.5, 0, 0));

    // A small backward-hooked hump, roughly two-thirds of the way back —
    // see WHALE_DORSAL_HEIGHT for why it stops well short of the torso's own
    // crown.
    rig.add(part(whaleDorsal, whaleMaterial, -0.3, 0.42, 0));

    // Pectoral fins: the same pivot-per-side recipe createBird uses for
    // wings — a Group at the shoulder with the panel offset outward inside
    // it, so the pivot's rotation is the hinge and not the panel's own
    // centre. Unlike the bird's wings this pose is fixed, not animate()-driven
    // (real flippers droop; they do not flap).
    function pectoralFin(sign: number): void {
      const pivot = new Group();
      pivot.position.set(0.75, -0.05, 0);
      pivot.add(part(whalePectoralFin, whaleMaterial, 0, 0, sign * WHALE_PECTORAL_ROOT_OFFSET));
      // Opposite sign on the droop (X) so both tips hang the SAME way — the
      // bird wing's own rule (see its comment on leftWing/rightWing) applies
      // unchanged here. Matching sign on the sweep (Y) so both tips trail the
      // SAME way backward: unlike the droop, the sweep rotation composes with
      // the panel's already-mirrored Z offset such that a shared sign cancels
      // out into one consistent world direction — checked against the preview
      // render, not trusted from the arithmetic alone.
      pivot.rotation.x = -sign * WHALE_PECTORAL_DOWNSWEEP_RADIANS;
      pivot.rotation.y = sign * WHALE_PECTORAL_BACKSWEEP_RADIANS;
      rig.add(pivot);
    }
    pectoralFin(1);
    pectoralFin(-1);

    const flukes = part(whaleFlukes, whaleMaterial, -2.7, 0, 0);
    rig.add(flukes);
    return {
      root,
      animate(seconds, phase) {
        // Whales flap vertically, slowly. Pitch about Z, the axis across a model
        // that faces +X.
        const swing = Math.sin(seconds * WHALE_FLUKE_HZ * TWO_PI + phase);
        flukes.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS;
        rig.rotation.z = swing * WHALE_FLUKE_SWING_RADIANS * 0.12;
      },
    };
  }

  function createDeepsea(): CreatureModel {
    const { root, rig } = rigged();
    rig.add(part(deepseaBody, deepseaMaterial, 0, 0, 0));
    rig.add(part(deepseaJaw, deepseaMaterial, 0.5, -0.12, 0));
    rig.add(part(deepseaStalk, deepseaMaterial, 0.42, 0.34, 0));
    const lure = part(deepseaLure, deepseaLureMaterial, 0.68, 0.36, 0);
    rig.add(lure);
    const lureRestY = lure.position.y;
    return {
      root,
      animate(seconds, phase) {
        const sway = Math.sin(seconds * DEEPSEA_SWAY_HZ * TWO_PI + phase);
        rig.rotation.y = sway * DEEPSEA_SWAY_RADIANS;
        // The lure lags the body, which is what sells it as dangling.
        lure.position.y = lureRestY + Math.sin(seconds * DEEPSEA_SWAY_HZ * TWO_PI + phase - 1) * DEEPSEA_LURE_BOB;
      },
    };
  }

  function createGrazer(): CreatureModel {
    const { root, rig } = rigged();
    // Origin at the feet: legs occupy y 0…0.42, body sits on top of them.
    const legY = 0.21;
    const bodyY = 0.62;
    rig.add(part(grazerBody, grazerBodyMaterial, 0, bodyY, 0));
    rig.add(part(grazerHead, grazerBodyMaterial, 0.5, bodyY + 0.16, 0));
    for (const [lx, lz] of [
      [0.3, 0.16],
      [0.3, -0.16],
      [-0.3, 0.16],
      [-0.3, -0.16],
    ] as const) {
      rig.add(part(grazerLeg, grazerLegMaterial, lx, legY, lz));
    }
    return {
      root,
      animate(seconds, phase) {
        // A walk bob: |sin| gives two rises per stride, one per pair of legs.
        rig.position.y = Math.abs(Math.sin(seconds * GRAZER_BOB_HZ * Math.PI + phase)) * GRAZER_BOB_AMPLITUDE;
      },
    };
  }

  function createBird(): CreatureModel {
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

    return {
      root,
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
  }

  const constructors: Readonly<Record<WildlifeSpecies, () => CreatureModel>> = {
    fish: createFish,
    whale: createWhale,
    deepsea: createDeepsea,
    grazer: createGrazer,
    bird: createBird,
  };

  return {
    create(species, sizeClass) {
      const model = constructors[species]();
      // Uniform, on the ROOT: `animate` only ever touches the inner rig, and the
      // caller only ever sets position and rotation.y, so nothing downstream can
      // overwrite the scale on a later frame.
      model.root.scale.setScalar(WILDLIFE_SIZE_MODEL_SCALE[sizeClass]);
      return model;
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
