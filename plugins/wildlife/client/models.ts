// Low-poly procedural creatures: spheres, cones and boxes, flat-shaded, in four
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
// RESIDUAL, stated rather than hidden: each creature is 2–6 Mesh objects, so a
// full 512² population is roughly 330 draw calls. That sits alongside the
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
import type { WildlifeSpecies } from '../protocol.ts';

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

/** Idle-animation rates, in cycles per second. Slower = larger, by convention. */
const FISH_TAIL_HZ = 3.2;
const WHALE_FLUKE_HZ = 0.45;
const DEEPSEA_SWAY_HZ = 0.7;
const GRAZER_BOB_HZ = 2.4;

const FISH_TAIL_SWING_RADIANS = 0.55;
const WHALE_FLUKE_SWING_RADIANS = 0.3;
const DEEPSEA_SWAY_RADIANS = 0.22;
/** Vertical travel of the walk bob, in world units (= cells). */
const GRAZER_BOB_AMPLITUDE = 0.05;
/** How far the lure bobs on its stalk, in world units. */
const DEEPSEA_LURE_BOB = 0.05;

const TWO_PI = Math.PI * 2;

/** One creature's scene object plus its idle animation. */
export interface CreatureModel {
  /** Positioned and yawed by the caller; never touched by `animate`. */
  readonly root: Group;
  /** `seconds` is elapsed time; `phase` is a per-creature offset in radians. */
  animate(seconds: number, phase: number): void;
}

export interface WildlifeModels {
  create(species: WildlifeSpecies): CreatureModel;
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
  const whaleBody = ellipsoid(4.4, 1.1, 1.4);
  const whaleFin = keepGeometry(new ConeGeometry(0.3, 0.7, CONE_SEGMENTS));
  const whaleFlukes = keepGeometry(new BoxGeometry(0.7, 0.12, 2.2));

  const deepseaMaterial = lambert(DEEPSEA_COLOR);
  const deepseaLureMaterial = unlit(DEEPSEA_LURE_COLOR);
  const deepseaBody = ellipsoid(1, 0.7, 0.55);
  const deepseaJaw = keepGeometry(new ConeGeometry(0.3, 0.45, CONE_SEGMENTS));
  deepseaJaw.rotateZ(-Math.PI / 2);
  const deepseaStalk = keepGeometry(new BoxGeometry(0.5, 0.04, 0.04));
  const deepseaLure = ellipsoid(0.14, 0.14, 0.14);

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
    rig.add(part(whaleBody, whaleMaterial, 0, 0, 0));
    rig.add(part(whaleFin, whaleMaterial, -0.4, 0.6, 0));
    const flukes = part(whaleFlukes, whaleMaterial, -2.4, 0, 0);
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

  const constructors: Readonly<Record<WildlifeSpecies, () => CreatureModel>> = {
    fish: createFish,
    whale: createWhale,
    deepsea: createDeepsea,
    grazer: createGrazer,
  };

  return {
    create(species) {
      return constructors[species]();
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
