// The Cthulhu, built procedurally: sculpted organic masses, swept tentacles and
// a ribbed wing membrane, smooth-shaded, in a silhouette that is unmistakable at
// a hundred cells and holds up when the camera comes down to the water.
//
// Rules this file keeps (the wildlife plugin's, for the same reasons):
//   * NO textures, NO per-model lights, NO external assets. Everything is
//     generated here; the scene's hemisphere + sun light (render/scene.ts) does
//     the lighting. Surface interest comes from GEOMETRY (a deterministic
//     wrinkle carved into the skin) and from PER-VERTEX SHADE, not from maps.
//     The one exception is the eye pair, which EMITS rather than being lit.
//   * NO Math.random anywhere in the geometry. Every irregularity — the
//     wrinkles, the mottle, the uneven curl of the tentacle fan — comes out of
//     one deterministic noise field with a constant seed, so every client in the
//     world builds the same creature down to the same dent.
//   * GEOMETRIES AND MATERIALS ARE SHARED and built exactly once, and `dispose()`
//     frees them exactly once. There is at most one monster in a world, so the
//     sharing saves little today; it costs nothing and it is what stops the
//     dispose contract from being different here than everywhere else.
//   * The origin is the PIVOT — the base of the visible torso, the point the
//     water closes over — and the model faces +X (see index.ts for the
//     heading → rotation.y mapping).
//
// WHERE THE NUMBERS LIVE. ./anatomy.ts owns the creature: every dimension,
// colour, slack and rate. This file owns only the RESOLUTION those shapes are
// tessellated at — the base segment counts below and the MONSTER_MODEL_DETAIL
// multiplier over them. If you want to change how it LOOKS, open anatomy.ts; if
// you want to change how FINE it is, change the knob here.
//
// FRAME. Every static geometry is authored directly in rig space (the head's
// forward offset, the wings' shoulder mount and so on are baked into the
// vertices), so the static meshes all sit at the rig's origin. That is what lets
// one continuous noise field run across the whole creature: the wrinkles on the
// head line up with the wrinkles on the neck because they are samples of the
// same function of the same coordinates. Only the tentacles are exceptions —
// they hang off animated joints, so their geometry is authored in joint space.
//
// COST, measured off the built model at MONSTER_MODEL_DETAIL = 4: 18,664
// triangles over 9,686 vertices in 24 meshes — body 3,360, head 2,976, the
// tentacle fan 6,664, the wings 4,256, eyes and haloes 1,408. There is exactly
// one monster in a world, and the terrain alone runs to a thousand chunk meshes,
// so this is noise in the frame budget and it is what buys the thing a face.

import {
  AdditiveBlending,
  BufferGeometry,
  CatmullRomCurve3,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  Vector3,
  type Material,
  type MeshLambertMaterialParameters,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MonsterKind } from '../protocol.ts';
import {
  CTHULHU_BODY_COLOR,
  CTHULHU_BODY_WRINKLE_DEPTH,
  CTHULHU_BREATH_HZ,
  CTHULHU_BREATH_RISE,
  CTHULHU_BREATH_ROLL_RADIANS,
  CTHULHU_EYE_BULGE,
  CTHULHU_EYE_COLOR,
  CTHULHU_EYE_EMISSIVE,
  CTHULHU_EYE_FORWARD,
  CTHULHU_EYE_HALO_OPACITY,
  CTHULHU_EYE_HALO_SCALE,
  CTHULHU_EYE_HEIGHT,
  CTHULHU_EYE_OFFSET,
  CTHULHU_EYE_RADIUS,
  CTHULHU_FACE_TENTACLE_COUNT,
  CTHULHU_HEAD_BROW_SLOPE,
  CTHULHU_HEAD_CENTER_HEIGHT,
  CTHULHU_HEAD_COLOR,
  CTHULHU_HEAD_FORWARD,
  CTHULHU_HEAD_HEIGHT,
  CTHULHU_HEAD_LENGTH,
  CTHULHU_HEAD_MUZZLE_TAPER,
  CTHULHU_HEAD_WIDTH,
  CTHULHU_HEAD_WRINKLE_DEPTH,
  CTHULHU_NECK_CENTER_HEIGHT,
  CTHULHU_NECK_FORWARD,
  CTHULHU_NECK_HEIGHT,
  CTHULHU_NECK_LENGTH,
  CTHULHU_NECK_WIDTH,
  CTHULHU_SHADE_FREQUENCY,
  CTHULHU_SHADE_VARIATION,
  CTHULHU_SHOULDER_HEIGHT,
  CTHULHU_SHOULDER_LENGTH,
  CTHULHU_SHOULDER_OFFSET,
  CTHULHU_SHOULDER_THICKNESS,
  CTHULHU_SHOULDER_WIDTH,
  CTHULHU_TENTACLE_BEND_RADIANS,
  CTHULHU_TENTACLE_COLOR,
  CTHULHU_TENTACLE_CURL_VARIATION,
  CTHULHU_TENTACLE_DRIFT,
  CTHULHU_TENTACLE_FAN_RADIANS,
  CTHULHU_TENTACLE_LENGTH_VARIATION,
  CTHULHU_TENTACLE_LOWER_CURL_RADIANS,
  CTHULHU_TENTACLE_LOWER_LENGTH,
  CTHULHU_TENTACLE_LOWER_RADIUS,
  CTHULHU_TENTACLE_MIN_CURL_RADIANS,
  CTHULHU_TENTACLE_PHASE_STEP,
  CTHULHU_TENTACLE_PITCH_RADIANS,
  CTHULHU_TENTACLE_ROOT_FORWARD,
  CTHULHU_TENTACLE_ROOT_HEIGHT,
  CTHULHU_TENTACLE_SWAY_HZ,
  CTHULHU_TENTACLE_SWAY_RADIANS,
  CTHULHU_TENTACLE_SWELL,
  CTHULHU_TENTACLE_TAPER_EXPONENT,
  CTHULHU_TENTACLE_TIP_RADIUS,
  CTHULHU_TENTACLE_UPPER_CURL_RADIANS,
  CTHULHU_TENTACLE_UPPER_LENGTH,
  CTHULHU_TENTACLE_UPPER_RADIUS,
  CTHULHU_TORSO_HEIGHT,
  CTHULHU_TORSO_LENGTH,
  CTHULHU_TORSO_WIDTH,
  CTHULHU_WING_ARM_RADIUS,
  CTHULHU_WING_BACKSET,
  CTHULHU_WING_CHORD,
  CTHULHU_WING_COLOR,
  CTHULHU_WING_ELBOW_BACK_FRACTION,
  CTHULHU_WING_ELBOW_BULGE,
  CTHULHU_WING_ELBOW_RISE_FRACTION,
  CTHULHU_WING_FINGER_BOW,
  CTHULHU_WING_FINGER_COUNT,
  CTHULHU_WING_FINGER_FAN_START_RADIANS,
  CTHULHU_WING_FINGER_FAN_STEP_RADIANS,
  CTHULHU_WING_FINGER_LENGTH,
  CTHULHU_WING_FINGER_LENGTH_STEP,
  CTHULHU_WING_FINGER_RADIUS,
  CTHULHU_WING_FINGER_SPREAD,
  CTHULHU_WING_FINGER_TIP_RADIUS,
  CTHULHU_WING_FOLD_RISE,
  CTHULHU_WING_HEIGHT,
  CTHULHU_WING_KNUCKLE_SWELL,
  CTHULHU_WING_LEAN_RADIANS,
  CTHULHU_WING_MEMBRANE_SAG,
  CTHULHU_WING_MEMBRANE_SCALLOP,
  CTHULHU_WING_OFFSET,
  CTHULHU_WING_RAKE_RADIANS,
  CTHULHU_WING_RIB_COLOR,
  CTHULHU_WING_SAG_DOWN,
  CTHULHU_WING_SAG_INBOARD,
  CTHULHU_WING_TRAILING_DROP,
  CTHULHU_WING_TRAILING_TUCK,
  CTHULHU_WING_WRIST_RADIUS,
  CTHULHU_WRINKLE_FREQUENCY,
} from './anatomy.ts';

/**
 * THE RESOLUTION KNOB. Every tessellation below is a base count times this.
 *
 * It is exported and deliberately not Cthulhu-specific: the next monster's
 * builder multiplies the same knob, so "render monsters at higher resolution" is
 * one number for the whole plugin rather than a hunt through per-part constants.
 *
 * 4 puts the one Cthulhu at roughly 17k triangles. The budget is generous
 * because MAX_LIVING_MONSTERS is 1 — this is a hero model, not a crowd — but the
 * knob is what makes the trade explicit if that ever stops being true.
 */
export const MONSTER_MODEL_DETAIL = 4;

/** Base tessellations, in segments at detail 1. Multiplied by the knob above. */
const BODY_SPHERE_SEGMENTS_BASE = 7;
const BODY_SPHERE_RINGS_BASE = 4;
const HEAD_SPHERE_SEGMENTS_BASE = 12;
const HEAD_SPHERE_RINGS_BASE = 8;
const EYE_SPHERE_SEGMENTS_BASE = 4;
const EYE_SPHERE_RINGS_BASE = 3;
/** Tentacles: along the sweep, and around it. */
const TENTACLE_PATH_SEGMENTS_BASE = 6;
const TENTACLE_RADIAL_SEGMENTS_BASE = 2;
/** The knuckle at the tentacle's mid joint, which hides the bend's seam. */
const KNUCKLE_SEGMENTS_BASE = 3;
const KNUCKLE_RINGS_BASE = 2;
/** Wing bones: along the bone, and around it. */
const WING_RIB_PATH_SEGMENTS_BASE = 3;
const WING_RIB_RADIAL_SEGMENTS_BASE = 2;
/** Wing membrane: across a panel (rib to rib), and along the ridges. */
const WING_PATCH_SPAN_SEGMENTS_BASE = 2;
const WING_PATCH_RIDGE_SEGMENTS_BASE = 3;

/** Control points sampled off an arc before it is handed to a CatmullRom. */
const ARC_CONTROL_POINTS = 5;

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
const WELD_TOLERANCE = 1e-3;

const TWO_PI = Math.PI * 2;
/** Consecutive multiples land as far apart on a cycle as it is possible to be. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

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
const NOISE_CHANNEL_WRINKLE = 0;
const NOISE_CHANNEL_SHADE = 1;
const NOISE_CHANNEL_TENTACLE = 2;

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
function organicNoise(x: number, y: number, z: number, channel: number): number {
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
function positionsOnly(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  return geometry;
}

/**
 * Dents a surface INWARD along its own normals, by up to `depth` cells.
 *
 * Inward-only, never outward: anatomy.ts's extents (and CTHULHU_LURK_DEPTH,
 * which is derived from one of them) are stated as the box the model lives in,
 * and a bump that pushed a vertex out would make that box a lie. Carving can
 * only leave the creature inside it.
 *
 * Requires normals to already be present — call after computeVertexNormals.
 */
function carveWrinkles(geometry: BufferGeometry, depth: number, frequency: number): void {
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
 * The material keeps its own colour from anatomy.ts; this multiplies it by
 * something within ±CTHULHU_SHADE_VARIATION of 1, which is enough to stop a
 * broad mass of one colour reading as plastic and far too little to look like
 * camouflage. Every geometry drawn with a vertexColors material must have this
 * attribute, so it is applied by the same finishing pass that computes normals.
 */
function applyShadeVariation(geometry: BufferGeometry): void {
  const position = geometry.getAttribute('position');
  const shades = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const shade =
      1 +
      CTHULHU_SHADE_VARIATION *
        organicNoise(
          position.getX(index) * CTHULHU_SHADE_FREQUENCY,
          position.getY(index) * CTHULHU_SHADE_FREQUENCY,
          position.getZ(index) * CTHULHU_SHADE_FREQUENCY,
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
function ellipsoid(
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

/** How the head's ellipsoid is narrowed into a brow and a muzzle. */
interface HeadSculpt {
  /** Multiplier on the half-height at this point. */
  readonly vertical: number;
  /** Multiplier on the half-width at this point. */
  readonly lateral: number;
}

/**
 * The head's sculpt factors at a normalised forward position `u` ∈ [-1, 1],
 * `above` telling whether the point is over the head's mid-line.
 *
 * ONE function, called both by the vertex loop that builds the skull and by the
 * projection that puts the eyes on its skin. Two copies of this rule would be
 * two copies that could disagree, and the way they would tell you is by burying
 * an eye inside the head.
 */
function headSculpt(u: number, above: boolean): HeadSculpt {
  const front = Math.max(0, u);
  const muzzle = 1 - CTHULHU_HEAD_MUZZLE_TAPER * front * front;
  const brow = above ? 1 - CTHULHU_HEAD_BROW_SLOPE * front * front : 1;
  return { vertical: muzzle * brow, lateral: muzzle };
}

/**
 * A circular arc of the given length that turns through `turnRadians` in total,
 * hanging from the origin down -Y and curling toward -X, with a sideways bulge
 * of `drift` at its midpoint.
 *
 * Stating a curl as an ARC rather than as control-point offsets is what keeps
 * this shape describable in anatomy.ts: the radius is length / turn, so the
 * whole curve falls out of two numbers that mean something ("this long, bent
 * this far") instead of a pile of hand-placed points that mean nothing.
 */
function curlArc(length: number, turnRadians: number, drift: number): CatmullRomCurve3 {
  const turn = Math.max(CTHULHU_TENTACLE_MIN_CURL_RADIANS, turnRadians);
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
function taperedTube(
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
 * One panel of wing membrane, spanning from ridge `left` to ridge `right`.
 *
 * Both ridges start at the wrist, so a panel is a fan out of it. The free edge
 * between the two ridges is scalloped back toward the wrist and the sheet is
 * sagged, which between them are what make a membrane look like skin hanging
 * off bones rather than like a sail sheeted in.
 *
 * The panel's edges lie EXACTLY on the ridge curves — both slack terms vanish at
 * span 0 and span 1 — which is what lets the ribs be swept along the same curves
 * and land on the seam instead of near it.
 */
function membranePanel(
  left: CatmullRomCurve3,
  right: CatmullRomCurve3,
  wrist: Vector3,
  sagDirection: Vector3,
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
      // Scallop: pull the free edge back toward the wrist, proportionally to how
      // far out it already is, so the notch grows with the panel.
      vertex.sub(wrist).multiplyScalar(1 - CTHULHU_WING_MEMBRANE_SCALLOP * slack).add(wrist);
      // Sag: heaviest at the panel's middle and at its outer end, because that
      // is where an unsupported sheet of skin has the most of itself to carry.
      vertex.addScaledVector(sagDirection, CTHULHU_WING_MEMBRANE_SAG * slack * along);
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

  /** Registers a geometry for disposal and returns it. */
  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function lambert(
    color: number,
    options: { emissive?: number; doubleSided?: boolean; shaded?: boolean } = {},
  ): MeshLambertMaterial {
    // Built key by key rather than as one literal with undefineds in it: three
    // warns on a parameter that is present and undefined, because that is
    // usually a typo rather than a default.
    const parameters: MeshLambertMaterialParameters = {
      color,
      // Smooth, not flat: at this tessellation flat shading would show every
      // one of the 48 facets around the skull as a plate. The faceted look was
      // a consequence of six segments, not a style to preserve at forty-eight.
      flatShading: false,
      vertexColors: options.shaded !== false,
    };
    if (options.emissive !== undefined) parameters.emissive = options.emissive;
    if (options.doubleSided === true) parameters.side = DoubleSide;
    const material = new MeshLambertMaterial(parameters);
    materials.push(material);
    return material;
  }

  /** Scales a base segment count by the resolution knob. A triangle needs 3. */
  function segments(base: number): number {
    return Math.max(3, Math.round(base * MONSTER_MODEL_DETAIL));
  }

  /**
   * THE FINISHING PASS, and the reason the model reads as one creature.
   *
   * Merge the parts into a single geometry, weld the coincident vertices the
   * primitives arrived with, take normals over the WHOLE merged surface (which
   * is what smooth-shades it), carve the wrinkles, take the normals again over
   * the carved surface, then shade the vertices. One draw call comes out.
   *
   * Every input must be positions-only and indexed; every geometry built in this
   * file is, so the merge cannot fail on mismatched attributes.
   */
  function organicSurface(parts: BufferGeometry[], wrinkleDepth: number): BufferGeometry {
    const merged = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    const welded = mergeVertices(merged, WELD_TOLERANCE);
    merged.dispose();
    welded.computeVertexNormals();
    if (wrinkleDepth > 0) {
      carveWrinkles(welded, wrinkleDepth, CTHULHU_WRINKLE_FREQUENCY);
      welded.computeVertexNormals();
    }
    applyShadeVariation(welded);
    return keepGeometry(welded);
  }

  // ── Shared materials ───────────────────────────────────────────────────────

  const bodyMaterial = lambert(CTHULHU_BODY_COLOR);
  const headMaterial = lambert(CTHULHU_HEAD_COLOR);
  const membraneMaterial = lambert(CTHULHU_WING_COLOR, { doubleSided: true });
  const ribMaterial = lambert(CTHULHU_WING_RIB_COLOR);
  const tentacleMaterial = lambert(CTHULHU_TENTACLE_COLOR);
  /**
   * The eyes are the only emissive surface. MeshLambertMaterial with an emissive
   * colour rather than the unlit MeshBasicMaterial the wildlife plugin's
   * anglerfish lure uses: unlit would be full brightness at every angle, and
   * these are meant to be a suggestion of light in a dark head, not headlamps.
   * No vertex colours — the mottle is skin, and an eye is not skin.
   */
  const eyeMaterial = lambert(CTHULHU_EYE_COLOR, {
    emissive: CTHULHU_EYE_EMISSIVE,
    shaded: false,
  });
  /**
   * The halo IS unlit, and that is the difference between the two: it is not a
   * surface, it is the light the eye is throwing into the water around it.
   *
   * Hence additive blending — light adds to what is behind it, and a halo that
   * blended normally would read as a green marble sitting on the face rather
   * than as a glow. It writes no depth so the two halos never cut each other or
   * the skin, and it still TESTS depth so the head occludes the far side of it.
   */
  const haloMaterial = new MeshBasicMaterial({
    color: CTHULHU_EYE_EMISSIVE,
    transparent: true,
    opacity: CTHULHU_EYE_HALO_OPACITY,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  materials.push(haloMaterial);

  // ── Body: torso, shoulders and neck, merged into one mass ──────────────────

  const bodyGeometry = organicSurface(
    [
      ellipsoid(
        CTHULHU_TORSO_LENGTH,
        CTHULHU_TORSO_HEIGHT,
        CTHULHU_TORSO_WIDTH,
        segments(BODY_SPHERE_SEGMENTS_BASE),
        segments(BODY_SPHERE_RINGS_BASE),
        new Vector3(0, CTHULHU_TORSO_HEIGHT / 2, 0),
      ),
      ellipsoid(
        CTHULHU_SHOULDER_LENGTH,
        CTHULHU_SHOULDER_THICKNESS,
        CTHULHU_SHOULDER_WIDTH,
        segments(BODY_SPHERE_SEGMENTS_BASE),
        segments(BODY_SPHERE_RINGS_BASE),
        new Vector3(0, CTHULHU_SHOULDER_HEIGHT, CTHULHU_SHOULDER_OFFSET),
      ),
      ellipsoid(
        CTHULHU_SHOULDER_LENGTH,
        CTHULHU_SHOULDER_THICKNESS,
        CTHULHU_SHOULDER_WIDTH,
        segments(BODY_SPHERE_SEGMENTS_BASE),
        segments(BODY_SPHERE_RINGS_BASE),
        new Vector3(0, CTHULHU_SHOULDER_HEIGHT, -CTHULHU_SHOULDER_OFFSET),
      ),
      ellipsoid(
        CTHULHU_NECK_LENGTH,
        CTHULHU_NECK_HEIGHT,
        CTHULHU_NECK_WIDTH,
        segments(BODY_SPHERE_SEGMENTS_BASE),
        segments(BODY_SPHERE_RINGS_BASE),
        new Vector3(CTHULHU_NECK_FORWARD, CTHULHU_NECK_CENTER_HEIGHT, 0),
      ),
    ],
    CTHULHU_BODY_WRINKLE_DEPTH,
  );

  // ── Head ───────────────────────────────────────────────────────────────────

  const headHalfLength = CTHULHU_HEAD_LENGTH / 2;
  const headHalfHeight = CTHULHU_HEAD_HEIGHT / 2;
  const headHalfWidth = CTHULHU_HEAD_WIDTH / 2;
  const headCenter = new Vector3(CTHULHU_HEAD_FORWARD, CTHULHU_HEAD_CENTER_HEIGHT, 0);

  /** The skull: an ellipsoid narrowed toward the front, then wrinkled. */
  function buildHeadGeometry(): BufferGeometry {
    const skull = ellipsoid(
      CTHULHU_HEAD_LENGTH,
      CTHULHU_HEAD_HEIGHT,
      CTHULHU_HEAD_WIDTH,
      segments(HEAD_SPHERE_SEGMENTS_BASE),
      segments(HEAD_SPHERE_RINGS_BASE),
    );
    const position = skull.getAttribute('position');
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index);
      const y = position.getY(index);
      const sculpt = headSculpt(x / headHalfLength, y > 0);
      position.setXYZ(index, x, y * sculpt.vertical, position.getZ(index) * sculpt.lateral);
    }
    skull.translate(headCenter.x, headCenter.y, headCenter.z);
    return skull;
  }

  const headGeometry = organicSurface([buildHeadGeometry()], CTHULHU_HEAD_WRINKLE_DEPTH);

  /**
   * Where an eye sits: the point on the sculpted skull in the direction of the
   * anatomy's stated eye point, pushed out by its bulge so the sphere breaks the
   * surface instead of hiding under it.
   */
  function eyePosition(side: number): Vector3 {
    const direction = new Vector3(
      (CTHULHU_EYE_FORWARD - headCenter.x) / headHalfLength,
      (CTHULHU_EYE_HEIGHT - headCenter.y) / headHalfHeight,
      (side * CTHULHU_EYE_OFFSET) / headHalfWidth,
    ).normalize();
    const sculpt = headSculpt(direction.x, direction.y > 0);
    const surface = new Vector3(
      direction.x * headHalfLength,
      direction.y * headHalfHeight * sculpt.vertical,
      direction.z * headHalfWidth * sculpt.lateral,
    );
    // The outward normal of an ellipsoid at a point is that point divided by the
    // squares of its semi-axes — not the point itself, which is why an eye
    // placed along the radius of a long head sinks into the cheek.
    const outward = new Vector3(
      surface.x / (headHalfLength * headHalfLength),
      surface.y / (headHalfHeight * headHalfHeight),
      surface.z / (headHalfWidth * headHalfWidth),
    ).normalize();
    return surface.add(headCenter).addScaledVector(outward, CTHULHU_EYE_RADIUS * CTHULHU_EYE_BULGE);
  }

  const eyeGeometry = keepGeometry(
    new SphereGeometry(
      CTHULHU_EYE_RADIUS,
      segments(EYE_SPHERE_SEGMENTS_BASE),
      segments(EYE_SPHERE_RINGS_BASE),
    ),
  );

  // ── Face tentacles ─────────────────────────────────────────────────────────

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

  /** The two swept segments of one tentacle, and where its mid joint lands. */
  interface TentacleGeometry {
    readonly upper: BufferGeometry;
    readonly lower: BufferGeometry;
    /** End of the upper segment's curve — where the mid joint has to sit. */
    readonly joint: Vector3;
  }

  /**
   * Builds tentacle `index`'s two segments.
   *
   * Both are arcs, so the rest pose is already a droop and a curl; the joints
   * add the sway on top. The per-tentacle variation is a sample of the noise
   * field at the index — deterministic, so the fan is irregular in the same way
   * on every client, which is the difference between "organic" and "buggy".
   */
  function buildTentacleGeometry(index: number): TentacleGeometry {
    const variation = organicNoise(index, 0, 0, NOISE_CHANNEL_TENTACLE);
    const pathSegments = segments(TENTACLE_PATH_SEGMENTS_BASE);
    const radialSegments = segments(TENTACLE_RADIAL_SEGMENTS_BASE);

    const upperCurve = curlArc(
      CTHULHU_TENTACLE_UPPER_LENGTH,
      CTHULHU_TENTACLE_UPPER_CURL_RADIANS * (1 + variation * CTHULHU_TENTACLE_CURL_VARIATION),
      CTHULHU_TENTACLE_DRIFT * variation,
    );
    const upper = taperedTube(
      upperCurve,
      (along) =>
        (CTHULHU_TENTACLE_UPPER_RADIUS +
          (CTHULHU_TENTACLE_LOWER_RADIUS - CTHULHU_TENTACLE_UPPER_RADIUS) * along) *
        (1 + CTHULHU_TENTACLE_SWELL * Math.sin(Math.PI * along)),
      pathSegments,
      radialSegments,
    );

    const lowerLength =
      CTHULHU_TENTACLE_LOWER_LENGTH * (1 + variation * CTHULHU_TENTACLE_LENGTH_VARIATION);
    const lowerCurve = curlArc(
      lowerLength,
      CTHULHU_TENTACLE_LOWER_CURL_RADIANS * (1 - variation * CTHULHU_TENTACLE_CURL_VARIATION),
      -CTHULHU_TENTACLE_DRIFT * variation,
    );
    const lower = taperedTube(
      lowerCurve,
      (along) =>
        CTHULHU_TENTACLE_LOWER_RADIUS +
        (CTHULHU_TENTACLE_TIP_RADIUS - CTHULHU_TENTACLE_LOWER_RADIUS) *
          Math.pow(along, CTHULHU_TENTACLE_TAPER_EXPONENT),
      pathSegments,
      radialSegments,
    );
    // The knuckle. The mid joint bends the lower segment away from the upper's
    // open end, which would leave a wedge of daylight at the outside of every
    // bend; a small sphere at the joint closes it and reads as a knuckle, which
    // is a thing tentacles have.
    const knuckle = ellipsoid(
      CTHULHU_TENTACLE_LOWER_RADIUS * 2,
      CTHULHU_TENTACLE_LOWER_RADIUS * 2,
      CTHULHU_TENTACLE_LOWER_RADIUS * 2,
      segments(KNUCKLE_SEGMENTS_BASE),
      segments(KNUCKLE_RINGS_BASE),
    );

    return {
      upper: organicSurface([upper], 0),
      lower: organicSurface([lower, knuckle], 0),
      joint: upperCurve.getPointAt(1, new Vector3()),
    };
  }

  const tentacleGeometries: TentacleGeometry[] = [];
  for (let index = 0; index < CTHULHU_FACE_TENTACLE_COUNT; index++) {
    tentacleGeometries.push(buildTentacleGeometry(index));
  }

  /**
   * Rigs one tentacle: a root joint on the face carrying the upper segment, and
   * a mid joint at that segment's END carrying the lower one. The joint sits
   * where the curve actually finishes rather than at a nominal length, so the
   * two segments stay welded however hard the upper one is made to curl.
   */
  function createTentacle(index: number): TentacleRig {
    const geometry = tentacleGeometries[index]!;
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
    root.add(new Mesh(geometry.upper, tentacleMaterial));

    const mid = new Group();
    mid.position.copy(geometry.joint);
    // Curls back under, toward the body.
    mid.rotation.z = -CTHULHU_TENTACLE_BEND_RADIANS;
    mid.add(new Mesh(geometry.lower, tentacleMaterial));
    root.add(mid);

    return { root, mid, restFan: spread, phase: index * CTHULHU_TENTACLE_PHASE_STEP };
  }

  // ── Wings ──────────────────────────────────────────────────────────────────

  /** A wing's ridge fan and the bones laid along the ones that have bones. */
  interface WingSkeleton {
    /** Neighbouring pairs bound one membrane panel each. */
    readonly ridges: readonly CatmullRomCurve3[];
    /** Radius profile per boned ridge, indexed as `ridges` is; null = no bone. */
    readonly bones: readonly (((along: number) => number) | null)[];
    readonly wrist: Vector3;
    readonly sagDirection: Vector3;
  }

  /**
   * Lays out one wing's skeleton. `side` is +1 or -1 (which flank).
   *
   * The lean and the rake are SLOPES applied to each point's rise, not a
   * rotation of the whole wing — see the wing block in anatomy.ts for why the
   * difference matters to the model's stated height.
   */
  function wingSkeleton(side: number): WingSkeleton {
    const backPerRise = Math.tan(CTHULHU_WING_RAKE_RADIANS);
    const outPerRise = Math.tan(CTHULHU_WING_LEAN_RADIANS);

    /** A point on this wing, in rig space, from its rise/backset/outboard. */
    function wingPoint(rise: number, back: number, out: number): Vector3 {
      return new Vector3(
        -CTHULHU_WING_BACKSET - back,
        CTHULHU_WING_HEIGHT + rise,
        side * (CTHULHU_WING_OFFSET + out),
      );
    }

    // The arm's far end is buried in the shoulder rather than left standing on
    // top of it: derived from CTHULHU_SHOULDER_HEIGHT, so a retuned shoulder
    // takes the wing root with it instead of leaving a bone floating in the air.
    const root = wingPoint(CTHULHU_SHOULDER_HEIGHT - CTHULHU_WING_HEIGHT, 0, 0);
    const elbowRise = CTHULHU_WING_FOLD_RISE * CTHULHU_WING_ELBOW_RISE_FRACTION;
    const elbow = wingPoint(
      elbowRise,
      elbowRise * backPerRise * CTHULHU_WING_ELBOW_BACK_FRACTION,
      elbowRise * outPerRise + CTHULHU_WING_ELBOW_BULGE,
    );
    const wrist = wingPoint(
      CTHULHU_WING_FOLD_RISE,
      CTHULHU_WING_FOLD_RISE * backPerRise,
      CTHULHU_WING_FOLD_RISE * outPerRise,
    );

    // Ridge 0 is the arm, run from the wrist DOWN to the shoulder, so that every
    // ridge in the fan starts at the wrist and a panel is a fan out of it.
    const ridges: CatmullRomCurve3[] = [new CatmullRomCurve3([wrist, elbow, root])];
    const bones: (((along: number) => number) | null)[] = [
      (along) =>
        CTHULHU_WING_WRIST_RADIUS +
        (CTHULHU_WING_ARM_RADIUS - CTHULHU_WING_WRIST_RADIUS) * along,
    ];

    let fingerLength = CTHULHU_WING_FINGER_LENGTH;
    for (let finger = 0; finger < CTHULHU_WING_FINGER_COUNT; finger++) {
      const angle =
        CTHULHU_WING_FINGER_FAN_START_RADIANS + finger * CTHULHU_WING_FINGER_FAN_STEP_RADIANS;
      const rise = fingerLength * Math.cos(angle);
      const back = fingerLength * Math.sin(angle);
      const out = finger * CTHULHU_WING_FINGER_SPREAD;
      const tip = new Vector3(
        wrist.x - back,
        wrist.y + rise,
        wrist.z + side * out,
      );
      const middle = new Vector3().lerpVectors(wrist, tip, 0.5);
      middle.y -= fingerLength * CTHULHU_WING_FINGER_BOW;
      ridges.push(new CatmullRomCurve3([wrist, middle, tip]));
      bones.push(
        (along) =>
          CTHULHU_WING_FINGER_RADIUS +
          (CTHULHU_WING_FINGER_TIP_RADIUS - CTHULHU_WING_FINGER_RADIUS) * along,
      );
      fingerLength *= CTHULHU_WING_FINGER_LENGTH_STEP;
    }

    // The free trailing edge: no bone, it just falls down the flank. It is what
    // closes the membrane against the body instead of leaving the last finger's
    // panel flapping in space.
    const anchor = wingPoint(
      -CTHULHU_WING_TRAILING_DROP,
      CTHULHU_WING_CHORD,
      -CTHULHU_WING_TRAILING_TUCK,
    );
    const trailingMiddle = new Vector3().lerpVectors(wrist, anchor, 0.5);
    trailingMiddle.y -= CTHULHU_WING_MEMBRANE_SAG;
    ridges.push(new CatmullRomCurve3([wrist, trailingMiddle, anchor]));
    bones.push(null);

    return {
      ridges,
      bones,
      wrist,
      sagDirection: new Vector3(
        0,
        -CTHULHU_WING_SAG_DOWN,
        -side * CTHULHU_WING_SAG_INBOARD,
      ).normalize(),
    };
  }

  /** One wing's two geometries: the membrane sheet and the bones under it. */
  interface WingGeometry {
    readonly membrane: BufferGeometry;
    readonly ribs: BufferGeometry;
  }

  function buildWingGeometry(side: number): WingGeometry {
    const skeleton = wingSkeleton(side);
    const panels: BufferGeometry[] = [];
    for (let ridge = 0; ridge + 1 < skeleton.ridges.length; ridge++) {
      panels.push(
        membranePanel(
          skeleton.ridges[ridge]!,
          skeleton.ridges[ridge + 1]!,
          skeleton.wrist,
          skeleton.sagDirection,
          segments(WING_PATCH_SPAN_SEGMENTS_BASE),
          segments(WING_PATCH_RIDGE_SEGMENTS_BASE),
        ),
      );
    }

    const bones: BufferGeometry[] = [];
    for (let ridge = 0; ridge < skeleton.ridges.length; ridge++) {
      const radiusAt = skeleton.bones[ridge];
      if (radiusAt === null || radiusAt === undefined) continue;
      bones.push(
        taperedTube(
          skeleton.ridges[ridge]!,
          radiusAt,
          segments(WING_RIB_PATH_SEGMENTS_BASE),
          segments(WING_RIB_RADIAL_SEGMENTS_BASE),
        ),
      );
    }

    // The knuckle: every bone in the fan starts at the wrist with an open mouth,
    // and this is the ball that swallows all of them.
    const knuckleRadius =
      Math.max(CTHULHU_WING_WRIST_RADIUS, CTHULHU_WING_FINGER_RADIUS) *
      CTHULHU_WING_KNUCKLE_SWELL;
    bones.push(
      ellipsoid(
        knuckleRadius * 2,
        knuckleRadius * 2,
        knuckleRadius * 2,
        segments(KNUCKLE_SEGMENTS_BASE),
        segments(KNUCKLE_RINGS_BASE),
        skeleton.wrist,
      ),
    );

    // The membrane is NOT wrinkled: it is a sheet under tension between bones,
    // and the slack it has is already in its shape. The bones are not wrinkled
    // either — they are thinner than the carve depth would be interesting at.
    return { membrane: organicSurface(panels, 0), ribs: organicSurface(bones, 0) };
  }

  const wingGeometries = [buildWingGeometry(1), buildWingGeometry(-1)];

  // ── Assembly ───────────────────────────────────────────────────────────────

  function createCthulhu(): MonsterModel {
    const root = new Group();
    // The caller owns `root` (position + yaw); everything animated hangs off
    // `rig`, so the breathing bob cannot fight the placement maths.
    const rig = new Group();
    root.add(rig);

    // Every static geometry is already in rig space, so these all sit at the
    // rig's origin — there is no per-mesh placement left to get wrong.
    rig.add(new Mesh(bodyGeometry, bodyMaterial));
    rig.add(new Mesh(headGeometry, headMaterial));
    for (const wing of wingGeometries) {
      rig.add(new Mesh(wing.membrane, membraneMaterial));
      rig.add(new Mesh(wing.ribs, ribMaterial));
    }

    for (const side of [1, -1]) {
      const position = eyePosition(side);
      const eye = new Mesh(eyeGeometry, eyeMaterial);
      eye.position.copy(position);
      rig.add(eye);

      const halo = new Mesh(eyeGeometry, haloMaterial);
      halo.position.copy(position);
      halo.scale.setScalar(CTHULHU_EYE_HALO_SCALE);
      rig.add(halo);
    }

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
        //
        // The sway is still two joint rotations and nothing else: the curl is
        // baked into the swept geometry, so nothing here re-curves a vertex.
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
