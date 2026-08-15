// The monster workshop: the geometry toolkit every kind is built with, and the
// pool that owns what it builds.
//
// WHY THIS IS ITS OWN FILE. The rules below were written for Cthulhu and are
// not about Cthulhu — they are how this plugin makes a creature, and the second
// kind (./kraken.ts) needs every one of them. Leaving them inside the Cthulhu
// builder would have meant either a second copy or a 1 400-line file where the
// two animals are interleaved with the tools that make them.
//
// Rules this file keeps (the wildlife plugin's, for the same reasons):
//   * NO textures, NO per-model lights, NO external assets. Everything is
//     generated here; the scene's hemisphere + sun light (render/scene.ts) does
//     the lighting. Surface interest comes from GEOMETRY (a deterministic
//     wrinkle carved into the skin) and from PER-VERTEX SHADE, not from maps.
//     The one exception is emissive eyes, which emit rather than being lit.
//   * NO Math.random anywhere in the geometry. Every irregularity — the
//     wrinkles, the mottle, the uneven curl of a tentacle fan — comes out of
//     one deterministic noise field with a constant seed, so every client in the
//     world builds the same creature down to the same dent.
//   * GEOMETRIES AND MATERIALS ARE SHARED and built exactly once, and the
//     workshop's `dispose()` frees them exactly once.
//
// WHERE THE NUMBERS LIVE. ./anatomy.ts and ./kraken-anatomy.ts own the
// creatures: every dimension, colour, slack and rate. This file owns only the
// RESOLUTION those shapes are tessellated at — the MONSTER_MODEL_DETAIL
// multiplier and the weld tolerance. If you want to change how a monster LOOKS,
// open its anatomy file; if you want to change how FINE it is, change the knob
// here.

import {
  BufferGeometry,
  CatmullRomCurve3,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  MeshLambertMaterial,
  SphereGeometry,
  Vector3,
  type Material,
  type MeshLambertMaterialParameters,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * THE RESOLUTION KNOB. Every tessellation in a builder is a base count times
 * this.
 *
 * Deliberately not kind-specific: "render monsters at higher resolution" is one
 * number for the whole plugin rather than a hunt through per-part constants.
 *
 * 4 puts the one Cthulhu at roughly 17k triangles and the kraken at ~7k. The
 * budget is generous because MAX_LIVING_MONSTERS is 1 — these are hero models,
 * not a crowd — but the knob is what makes the trade explicit if that ever
 * stops being true.
 */
export const MONSTER_MODEL_DETAIL = 4;

/**
 * How close two vertices must be to be welded into one, in cells.
 *
 * Welding runs before the normals are computed and it is the whole reason the
 * smooth shading has no visible seam: a UV sphere carries a duplicate column of
 * vertices where it wraps and a fan of duplicates at each pole, and normals
 * averaged per-duplicate would light those two lines differently from the skin
 * either side of them. A thousandth of a cell is far below any feature here and
 * far above the float noise in a wrap-around cosine.
 */
export const WELD_TOLERANCE = 1e-3;

export const TWO_PI = Math.PI * 2;
/** Consecutive multiples land as far apart on a cycle as it is possible to be. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// ── The noise field ──────────────────────────────────────────────────────────

/**
 * The seed. A constant, and the point of the exercise: two clients looking at
 * the same monster must see the same wrinkles, so nothing here may come from
 * Math.random, from a Date, or from anything else that differs between tabs.
 */
const NOISE_SEED = 0.6180339887;
/** Octaves of the field, and how the frequency climbs and the amplitude falls. */
const NOISE_OCTAVES = 3;
const NOISE_LACUNARITY = 2.17;
const NOISE_GAIN = 0.5;
/**
 * Per-axis frequency ratios. Deliberately not 1:1:1 and not rational multiples
 * of each other — equal ratios make the field's zero surfaces line up into a
 * visible grid, which is exactly what a hand-made wrinkle must not look like.
 */
const NOISE_AXIS_RATIO_Y = 1.31;
const NOISE_AXIS_RATIO_Z = 0.83;

/**
 * Each use of the field gets its own channel, so the mottle does not simply
 * shade the dents the wrinkle carved (which would read as a printed texture
 * rather than as a surface).
 */
export const NOISE_CHANNEL_WRINKLE = 0;
export const NOISE_CHANNEL_SHADE = 1;
export const NOISE_CHANNEL_TENTACLE = 2;

/**
 * A smooth deterministic field over space, in [-1, 1].
 *
 * A trig lattice rather than a hashed value noise: three octaves of a product of
 * sines is a few lines, is continuous in every derivative (so a carve leaves no
 * facet), and is a pure function of position — which is what makes duplicate
 * vertices on a seam move identically and leaves no crack to weld shut.
 *
 * HONEST RESIDUAL: Math.sin is not required by IEEE-754 to be bit-identical
 * across engines, so two clients on different browsers could in principle differ
 * in the last bits of a vertex. Nothing depends on the value — no simulation
 * state, no collision, no protocol — so the consequence of that is nothing.
 */
export function organicNoise(x: number, y: number, z: number, channel: number): number {
  const seed = NOISE_SEED + channel * GOLDEN_ANGLE;
  let value = 0;
  let amplitude = 1;
  let weight = 0;
  let frequency = 1;
  for (let octave = 0; octave < NOISE_OCTAVES; octave++) {
    const phase = seed * (octave + 1);
    value +=
      amplitude *
      Math.sin(frequency * x + phase) *
      Math.sin(frequency * y * NOISE_AXIS_RATIO_Y + phase * 2) *
      Math.sin(frequency * z * NOISE_AXIS_RATIO_Z + phase * 3);
    weight += amplitude;
    amplitude *= NOISE_GAIN;
    frequency *= NOISE_LACUNARITY;
  }
  return value / weight;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Reduces a geometry to positions and an index.
 *
 * Two jobs. Merging demands that every input carry the same attributes, and a
 * sphere arrives with normals and UVs that a hand-built patch does not; and the
 * weld hashes every attribute, so leaving the UVs on would refuse to weld the
 * seam column that has the same position and two different UVs — which is the
 * one weld that matters. Nothing here samples a texture, so the UVs are dead
 * weight in the first place.
 */
export function positionsOnly(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  return geometry;
}

/**
 * Dents a surface INWARD along its own normals, by up to `depth` cells.
 *
 * Inward-only, never outward: an anatomy file's extents (and the lurk depths
 * derived from them) are stated as the box the model lives in, and a bump that
 * pushed a vertex out would make that box a lie. Carving can only leave the
 * creature inside it.
 *
 * Requires normals to already be present — call after computeVertexNormals.
 */
export function carveWrinkles(geometry: BufferGeometry, depth: number, frequency: number): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    // (0.5 + 0.5·n) maps the field to [0, 1]: every vertex moves in a little,
    // the deepest by `depth`. A signed carve would only dent half the surface
    // and leave the other half exactly on the ellipsoid, which reads as a ball
    // with bites out of it rather than as skin.
    const bite =
      depth * (0.5 + 0.5 * organicNoise(x * frequency, y * frequency, z * frequency, NOISE_CHANNEL_WRINKLE));
    position.setXYZ(
      index,
      x - normal.getX(index) * bite,
      y - normal.getY(index) * bite,
      z - normal.getZ(index) * bite,
    );
  }
  position.needsUpdate = true;
}

/**
 * Writes a per-vertex shade multiplier into the geometry's colour attribute.
 *
 * The material keeps its own colour from the anatomy; this multiplies it by
 * something within ±`variation` of 1, which is enough to stop a broad mass of
 * one colour reading as plastic and far too little to look like camouflage.
 * Every geometry drawn with a vertexColors material must have this attribute, so
 * it is applied by the same finishing pass that computes normals.
 */
export function applyShadeVariation(
  geometry: BufferGeometry,
  variation: number,
  frequency: number,
): void {
  const position = geometry.getAttribute('position');
  const shades = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const shade =
      1 +
      variation *
        organicNoise(
          position.getX(index) * frequency,
          position.getY(index) * frequency,
          position.getZ(index) * frequency,
          NOISE_CHANNEL_SHADE,
        );
    shades[index * 3] = shade;
    shades[index * 3 + 1] = shade;
    shades[index * 3 + 2] = shade;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(shades, 3));
}

/**
 * A sphere pre-scaled into an ellipsoid and moved into rig space.
 *
 * Positions only — every caller either merges it with something else or runs it
 * through the finishing pass, and both recompute what this strips.
 */
export function ellipsoid(
  length: number,
  height: number,
  width: number,
  segments: number,
  rings: number,
  center?: Vector3,
): BufferGeometry {
  const geometry = new SphereGeometry(0.5, segments, rings);
  geometry.scale(length, height, width);
  if (center !== undefined) geometry.translate(center.x, center.y, center.z);
  return positionsOnly(geometry);
}

/** Control points sampled off an arc before it is handed to a CatmullRom. */
export const ARC_CONTROL_POINTS = 5;

/**
 * A circular arc of the given length that turns through `turnRadians` in total,
 * hanging from the origin down -Y and curling toward -X, with a sideways bulge
 * of `drift` at its midpoint.
 *
 * Stating a curl as an ARC rather than as control-point offsets is what keeps
 * this shape describable in an anatomy file: the radius is length / turn, so the
 * whole curve falls out of two numbers that mean something ("this long, bent
 * this far") instead of a pile of hand-placed points that mean nothing.
 *
 * `minTurnRadians` is the floor a per-limb variation may not push the turn
 * below; it is a number from the caller's anatomy rather than one invented here,
 * because "how straight is straight enough for this creature" is a fact about
 * the creature. Without it the radius (length / turn) divides by zero.
 */
export function curlArc(
  length: number,
  turnRadians: number,
  drift: number,
  minTurnRadians: number,
): CatmullRomCurve3 {
  const turn = Math.max(minTurnRadians, turnRadians);
  const radius = length / turn;
  const points: Vector3[] = [];
  for (let step = 0; step <= ARC_CONTROL_POINTS; step++) {
    const along = step / ARC_CONTROL_POINTS;
    const angle = along * turn;
    points.push(
      new Vector3(
        -radius * (1 - Math.cos(angle)),
        -radius * Math.sin(angle),
        drift * Math.sin(Math.PI * along),
      ),
    );
  }
  return new CatmullRomCurve3(points);
}

/**
 * A tube swept along a curve whose radius is a function of how far along it is —
 * which is the whole reason this is here rather than three's TubeGeometry, since
 * that one takes a single radius and a tentacle that does not taper is a hose.
 *
 * The ring is closed by INDEX WRAP rather than by a duplicated seam column, so
 * there is no seam to weld and no crease down the length of every tentacle. The
 * far end is capped with a fan; the near end is left open because every caller
 * buries it inside the mass it grows out of.
 */
export function taperedTube(
  curve: CatmullRomCurve3,
  radiusAt: (along: number) => number,
  pathSegments: number,
  radialSegments: number,
): BufferGeometry {
  const frames = curve.computeFrenetFrames(pathSegments, false);
  const positions: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();

  for (let ring = 0; ring <= pathSegments; ring++) {
    const along = ring / pathSegments;
    curve.getPointAt(along, point);
    const normal = frames.normals[ring]!;
    const binormal = frames.binormals[ring]!;
    const radius = radiusAt(along);
    for (let side = 0; side < radialSegments; side++) {
      const angle = (side / radialSegments) * TWO_PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(
        point.x + radius * (cos * normal.x + sin * binormal.x),
        point.y + radius * (cos * normal.y + sin * binormal.y),
        point.z + radius * (cos * normal.z + sin * binormal.z),
      );
    }
  }

  for (let ring = 0; ring < pathSegments; ring++) {
    for (let side = 0; side < radialSegments; side++) {
      const here = ring * radialSegments + side;
      const next = ring * radialSegments + ((side + 1) % radialSegments);
      indices.push(here, next, next + radialSegments);
      indices.push(here, next + radialSegments, here + radialSegments);
    }
  }

  // The cap: one vertex on the curve's end and a fan of triangles back to the
  // last ring. Not a ring of radius zero — that collapses a whole row of
  // triangles to nothing and pinches the shading at the tip.
  const tipIndex = positions.length / 3;
  curve.getPointAt(1, point);
  positions.push(point.x, point.y, point.z);
  const lastRing = pathSegments * radialSegments;
  for (let side = 0; side < radialSegments; side++) {
    indices.push(lastRing + side, lastRing + ((side + 1) % radialSegments), tipIndex);
  }

  const tube = new BufferGeometry();
  tube.setAttribute('position', new Float32BufferAttribute(positions, 3));
  tube.setIndex(indices);
  return tube;
}

/**
 * One panel of membrane, spanning from ridge `left` to ridge `right`.
 *
 * Both ridges start at `hub`, so a panel is a fan out of it. The free edge
 * between the two ridges is scalloped back toward the hub and the sheet is
 * sagged, which between them are what make a membrane look like skin hanging
 * off bones rather than like a sail sheeted in.
 *
 * The panel's edges lie EXACTLY on the ridge curves — both slack terms vanish at
 * span 0 and span 1 — which is what lets the ribs be swept along the same curves
 * and land on the seam instead of near it.
 */
export function membranePanel(
  left: CatmullRomCurve3,
  right: CatmullRomCurve3,
  hub: Vector3,
  sagDirection: Vector3,
  scallop: number,
  sag: number,
  spanSegments: number,
  ridgeSegments: number,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const leftPoint = new Vector3();
  const rightPoint = new Vector3();
  const vertex = new Vector3();

  for (let spanStep = 0; spanStep <= spanSegments; spanStep++) {
    const span = spanStep / spanSegments;
    // Zero at both ridges, one in the middle of the panel.
    const slack = Math.sin(Math.PI * span);
    for (let ridgeStep = 0; ridgeStep <= ridgeSegments; ridgeStep++) {
      const along = ridgeStep / ridgeSegments;
      left.getPointAt(along, leftPoint);
      right.getPointAt(along, rightPoint);
      vertex.copy(leftPoint).lerp(rightPoint, span);
      // Scallop: pull the free edge back toward the hub, proportionally to how
      // far out it already is, so the notch grows with the panel.
      vertex.sub(hub).multiplyScalar(1 - scallop * slack).add(hub);
      // Sag: heaviest at the panel's middle and at its outer end, because that
      // is where an unsupported sheet of skin has the most of itself to carry.
      vertex.addScaledVector(sagDirection, sag * slack * along);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }

  const stride = ridgeSegments + 1;
  for (let spanStep = 0; spanStep < spanSegments; spanStep++) {
    for (let ridgeStep = 0; ridgeStep < ridgeSegments; ridgeStep++) {
      const corner = spanStep * stride + ridgeStep;
      indices.push(corner, corner + 1, corner + stride + 1);
      indices.push(corner, corner + stride + 1, corner + stride);
    }
  }

  const panel = new BufferGeometry();
  panel.setAttribute('position', new Float32BufferAttribute(positions, 3));
  panel.setIndex(indices);
  return panel;
}

// ── The workshop ─────────────────────────────────────────────────────────────

/** One monster's scene object plus its idle animation. */
export interface MonsterModel {
  /** Positioned and yawed by the caller; never touched by `animate`. */
  readonly root: Group;
  /** `seconds` is elapsed time; `phase` is a per-monster offset in radians. */
  animate(seconds: number, phase: number): void;
}

/**
 * How a kind's skin is finished: the carve, and the mottle over it. Stated as
 * one value per KIND rather than as arguments at each callsite, so a creature
 * cannot end up with two different skins on two of its parts by accident.
 */
export interface SkinFinish {
  /** Cells of inward carve. 0 for a surface that must stay exact. */
  readonly wrinkleDepth: number;
  /** Spatial frequency of the wrinkle field, cycles per cell. */
  readonly wrinkleFrequency: number;
  /** Per-vertex shade variation, as a fraction either side of the colour. */
  readonly shadeVariation: number;
  /** Spatial frequency of the mottle, cycles per cell. */
  readonly shadeFrequency: number;
}

/** Options for a lambert material built by the workshop. */
export interface LambertOptions {
  readonly emissive?: number;
  readonly doubleSided?: boolean;
  /** False for a surface with no vertex-colour attribute (eyes, not skin). */
  readonly shaded?: boolean;
}

/**
 * The shared pool: everything a kind's builder makes goes through it, and it is
 * what `dispose()` frees. One instance per client plugin attach.
 */
export interface ModelWorkshop {
  /** Scales a base segment count by the resolution knob. A triangle needs 3. */
  segments(base: number): number;
  /** Registers a geometry for disposal and returns it. */
  keepGeometry<T extends BufferGeometry>(geometry: T): T;
  /** Registers a material for disposal and returns it. */
  keepMaterial<T extends Material>(material: T): T;
  lambert(color: number, options?: LambertOptions): MeshLambertMaterial;
  /**
   * THE FINISHING PASS, and the reason a model reads as one creature.
   *
   * Merge the parts into a single geometry, weld the coincident vertices the
   * primitives arrived with, take normals over the WHOLE merged surface (which
   * is what smooth-shades it), carve the wrinkles, take the normals again over
   * the carved surface, then shade the vertices. One draw call comes out.
   *
   * Every input must be positions-only and indexed; everything this file builds
   * is, so the merge cannot fail on mismatched attributes.
   */
  organicSurface(parts: BufferGeometry[], skin: SkinFinish): BufferGeometry;
  /** Frees every kept geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

export function createWorkshop(): ModelWorkshop {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function keepMaterial<T extends Material>(material: T): T {
    materials.push(material);
    return material;
  }

  return {
    segments(base: number): number {
      return Math.max(3, Math.round(base * MONSTER_MODEL_DETAIL));
    },

    keepGeometry,
    keepMaterial,

    lambert(color: number, options: LambertOptions = {}): MeshLambertMaterial {
      // Built key by key rather than as one literal with undefineds in it: three
      // warns on a parameter that is present and undefined, because that is
      // usually a typo rather than a default.
      const parameters: MeshLambertMaterialParameters = {
        color,
        // Smooth, not flat: at this tessellation flat shading would show every
        // one of the facets around a skull as a plate. The faceted look was a
        // consequence of six segments, not a style to preserve at forty-eight.
        flatShading: false,
        vertexColors: options.shaded !== false,
      };
      if (options.emissive !== undefined) parameters.emissive = options.emissive;
      if (options.doubleSided === true) parameters.side = DoubleSide;
      return keepMaterial(new MeshLambertMaterial(parameters));
    },

    organicSurface(parts: BufferGeometry[], skin: SkinFinish): BufferGeometry {
      const merged = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      const welded = mergeVertices(merged, WELD_TOLERANCE);
      merged.dispose();
      welded.computeVertexNormals();
      if (skin.wrinkleDepth > 0) {
        carveWrinkles(welded, skin.wrinkleDepth, skin.wrinkleFrequency);
        welded.computeVertexNormals();
      }
      applyShadeVariation(welded, skin.shadeVariation, skin.shadeFrequency);
      return keepGeometry(welded);
    },

    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
