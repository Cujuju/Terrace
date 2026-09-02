// THE HAZE BANK: a stack of horizontal sheets that greys the air inside a
// drifting mass.
//
// WHAT IT IS FOR. Four plugins draw one of these. For one of them the bank IS
// the effect; for the others it is what stops a falling column reading as lines
// in a vacuum — real precipitation greys the air it falls through.
//
// Layered horizontal sheets rather than a volumetric shader: a few transparent
// discs cost nothing to draw and nothing to author, and the parallax between
// sheets at different heights and different spin rates is what actually sells
// volume to a moving camera. Same choice, and same reasoning, as the monsters
// plugin's MIST_LAYERS.
//
// NOT scene.fog, NOT the lighting rig, NOT the sky. Those are global, and
// tinting the whole world would be the opposite of "weather in large chunks" —
// this is local geometry that moves with the mass that owns it and leaves the
// rest of the map in the sun.
//
// ONE OWNER. The sheet GEOMETRY is built once per plugin and shared by every
// bank that plugin makes, so it is passed in and freed by whoever built it; a
// bank owns only its own materials.

import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
} from 'three';

const TWO_PI = Math.PI * 2;

/**
 * Tessellation of one sheet: segments around, rings out from the centre.
 *
 * 64 around keeps the wobbled outline curved rather than polygonal at the radius
 * these are drawn at — half again the monsters plugin's 48, because a weather
 * mass is up to five times the size of that mist bank and the same segment count
 * would show facets. 6 rings keeps the alpha falloff, which is interpolated
 * linearly between rings, from banding. 385 vertices, ONE geometry shared by
 * every bank a plugin makes.
 */
const HAZE_RADIAL_SEGMENTS = 64;
const HAZE_RINGS = 6;

/** One horizontal sheet. Several of them stack into a bank. */
export interface HazeLayerSpec {
  /** Height above sea level, in world units, before the bob. */
  readonly height: number;
  /** Radius as a fraction of the mass's radius. */
  readonly radiusScale: number;
  /** Peak alpha, reached at intensity 1. */
  readonly opacity: number;
  /** Turns per second about the vertical, signed. */
  readonly spinHz: number;
  /** Vertical bob amplitude in world units, and its rate in cycles per second. */
  readonly bobUnits: number;
  readonly bobHz: number;
}

/**
 * Cold and desaturated, a touch lighter than the sea it lies on (the water is
 * 0x2f6f9e, client/src/render/water.ts). Close to but not the same as the
 * monsters plugin's MIST_COLOR (0x9fb2ad): that mist is something the water is
 * giving off around one creature, this is weather, so it is a shade cooler and
 * greyer. INDEPENDENT OF IT, though visually of a piece — the two effects can be
 * on screen at once and neither knows the other exists.
 */
export const HAZE_COLOR = 0xa9b8c2;

/**
 * THE BANK: four sheets from just above the waterline up to two bands, widest at
 * the bottom and thinning upward.
 *
 * WHY THE HEIGHTS STOP AT 2.4 WORLD UNITS. That is a bit over two terrace bands,
 * so the bank fills the shoreline flats and the valleys and leaves anything a
 * player has raised three bands or more standing clear above it. Haze that
 * swallowed the mountains would be scene fog, which this deliberately is not.
 *
 * The four spin rates are mutually non-multiple and alternate in sign, so the
 * sheets never realign into one apparent slab; the same is true of the bob
 * rates. Every period is tens of seconds — slow enough to be invisible frame to
 * frame, which is both the aesthetic rule this codebase uses for idle motion and
 * the reason none of it is a photosensitivity concern.
 */
export const HAZE_LAYERS: readonly HazeLayerSpec[] = [
  { height: 0.25, radiusScale: 1, opacity: 0.3, spinHz: 0.013, bobUnits: 0.1, bobHz: 0.043 },
  { height: 0.85, radiusScale: 0.9, opacity: 0.24, spinHz: -0.019, bobUnits: 0.16, bobHz: 0.031 },
  { height: 1.55, radiusScale: 0.76, opacity: 0.17, spinHz: 0.027, bobUnits: 0.22, bobHz: 0.023 },
  { height: 2.4, radiusScale: 0.58, opacity: 0.1, spinHz: -0.037, bobUnits: 0.28, bobHz: 0.017 },
];

/**
 * How irregular a sheet's outline is, as a fraction of its radius, and the two
 * lobe counts that make it so.
 *
 * A perfect circle of haze reads as a targeting decal. Two sine lobes at coprime
 * counts never repeat inside one turn, which is what makes the outline look torn
 * rather than stamped. 3 and 5 is the monsters plugin's pair; 4 and 7 here, with
 * a deeper wobble, because a weather mass is five times the size of that mist
 * bank and a big disc needs a coarser tear to read as one. Deterministic — this
 * is the SHAPE of the haze, not the weather, and every client tears it
 * identically.
 */
export const HAZE_EDGE_WOBBLE = 0.22;
export const HAZE_EDGE_LOBES_A = 4;
export const HAZE_EDGE_LOBES_B = 7;
/** Phases, so the two lobe sets do not both peak on the +X axis. */
export const HAZE_EDGE_PHASE_A = 1.1;
export const HAZE_EDGE_PHASE_B = 2.7;

/**
 * Falloff exponent of a sheet's alpha from its centre to its rim.
 * alpha(u) = (1 − u²)^k. 1.8 gives a broad soft core and a rim that reaches zero
 * smoothly, so no sheet ever shows an edge.
 */
export const HAZE_EDGE_SOFTNESS = 1.8;

/** Radius multiplier of a sheet's wobbled outline at bearing `angle`. */
export function hazeEdgeWobble(angle: number): number {
  return (
    1 +
    HAZE_EDGE_WOBBLE *
      (Math.sin(HAZE_EDGE_LOBES_A * angle + HAZE_EDGE_PHASE_A) * 0.6 +
        Math.sin(HAZE_EDGE_LOBES_B * angle + HAZE_EDGE_PHASE_B) * 0.4)
  );
}

/**
 * How much of a sheet's own opacity a mass that PRECIPITATES also gets.
 *
 * A third of the full bank's strength is enough to soften the ground under a
 * front without turning every shower into a haze bank, and it reuses this rig
 * rather than adding another effect.
 */
export const PRECIPITATION_HAZE_SCALE = 1 / 3;

/**
 * One sheet: a horizontal UNIT disc in the XZ plane, opaque-ish at the centre
 * and vanishing at the rim. Scaled to a mass's radius by the sheet that uses it,
 * which is what lets every bank on the client share one geometry.
 *
 * The falloff is per-vertex ALPHA rather than a texture or a shader. three
 * multiplies the material's opacity by the vertex colour when the colour
 * attribute carries four components, so one stock MeshBasicMaterial gives a soft
 * radial blob whose overall strength is still a single number a mass's intensity
 * can drive — with no texture to load, no canvas to rasterise and no custom
 * shader to keep compiling.
 */
export function buildHazeGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // The centre vertex. RGB is left at 1 so the material's own colour rules; only
  // the alpha varies across the sheet.
  positions.push(0, 0, 0);
  colors.push(1, 1, 1, 1);

  for (let ring = 1; ring <= HAZE_RINGS; ring++) {
    const out = ring / HAZE_RINGS;
    const alpha = Math.pow(1 - out * out, HAZE_EDGE_SOFTNESS);
    for (let side = 0; side < HAZE_RADIAL_SEGMENTS; side++) {
      const angle = (side / HAZE_RADIAL_SEGMENTS) * TWO_PI;
      const radius = out * hazeEdgeWobble(angle);
      positions.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));
      colors.push(1, 1, 1, alpha);
    }
  }

  // Inner fan, centre to the first ring.
  for (let side = 0; side < HAZE_RADIAL_SEGMENTS; side++) {
    const here = 1 + side;
    const next = 1 + ((side + 1) % HAZE_RADIAL_SEGMENTS);
    indices.push(0, next, here);
  }

  // Quads between consecutive rings.
  for (let ring = 1; ring < HAZE_RINGS; ring++) {
    const inner = 1 + (ring - 1) * HAZE_RADIAL_SEGMENTS;
    const outer = 1 + ring * HAZE_RADIAL_SEGMENTS;
    for (let side = 0; side < HAZE_RADIAL_SEGMENTS; side++) {
      const nextSide = (side + 1) % HAZE_RADIAL_SEGMENTS;
      indices.push(inner + side, outer + nextSide, outer + side);
      indices.push(inner + side, inner + nextSide, outer + nextSide);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

/** The sheets of one mass's bank, and the one call that animates them. */
export interface HazeBank {
  /** Parent these into the rig's root, in this order. */
  readonly sheets: readonly Mesh[];
  /**
   * One frame. `elapsed` is the plugin's animation clock, which STOPS ADVANCING
   * under prefers-reduced-motion — so spin and bob becalm from that one fact
   * with no branch here: this simply re-asserts the rest pose every frame.
   */
  update(worldRadius: number, intensity: number, elapsed: number): void;
  /** Frees the materials. The GEOMETRY belongs to whoever built it. */
  dispose(): void;
}

/**
 * Builds one bank over the shared geometry.
 *
 * `strength` scales every layer's peak opacity — 1 for a mass that IS haze,
 * PRECIPITATION_HAZE_SCALE for one that only greys the air its column falls
 * through.
 */
export function createHazeBank(
  geometry: BufferGeometry,
  strength: number,
  renderOrder: number,
): HazeBank {
  const materials: MeshBasicMaterial[] = [];
  const sheets: Mesh[] = [];

  for (const _layer of HAZE_LAYERS) {
    const material = new MeshBasicMaterial({
      color: HAZE_COLOR,
      transparent: true,
      // Starts invisible; the mass's intensity owns this from frame one.
      opacity: 0,
      // Per-vertex alpha (buildHazeGeometry) needs this; the vertex RGB is 1, so
      // the material's colour is what actually tints the sheet.
      vertexColors: true,
      // Visible from underneath, for a camera that has dipped toward the water.
      side: DoubleSide,
      depthWrite: false,
    });
    const sheet = new Mesh(geometry, material);
    sheet.renderOrder = renderOrder;
    materials.push(material);
    sheets.push(sheet);
  }

  return {
    sheets,

    update(worldRadius: number, intensity: number, elapsed: number): void {
      for (let index = 0; index < sheets.length; index++) {
        const layer = HAZE_LAYERS[index]!;
        const sheet = sheets[index]!;
        materials[index]!.opacity = layer.opacity * strength * intensity;
        sheet.scale.setScalar(worldRadius * layer.radiusScale);
        sheet.rotation.y = elapsed * layer.spinHz * TWO_PI;
        sheet.position.y = layer.height + Math.sin(elapsed * layer.bobHz * TWO_PI) * layer.bobUnits;
      }
    },

    dispose(): void {
      for (const material of materials) material.dispose();
    },
  };
}
