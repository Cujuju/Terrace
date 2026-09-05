// The Cthulhu, built procedurally: sculpted organic masses, swept tentacles and
// a ribbed wing membrane, smooth-shaded, in a silhouette that is unmistakable at
// a hundred cells and holds up when the camera comes down to the water.
//
// Every rule this builder obeys — no Math.random, no per-model lights (textures
// and external assets are allowed since 2026-09-04; see ./geometry.ts), shared and
// disposed-once resources — lives in ./geometry.ts, which is also where the
// tools come from. ./anatomy.ts owns the numbers. This file owns the CREATURE:
// which masses there are, how they are rigged, and how they move.
//
// FRAME. Every static geometry is authored directly in rig space (the head's
// forward offset, the wings' shoulder mount and so on are baked into the
// vertices), so the static meshes all sit at the rig's origin. That is what lets
// one continuous noise field run across the whole creature: the wrinkles on the
// head line up with the wrinkles on the neck because they are samples of the
// same function of the same coordinates. Only the tentacles are exceptions —
// they hang off animated joints, so their geometry is authored in joint space.
//
// The origin is the PIVOT — the base of the visible torso, the point the water
// closes over — and the model faces +X (see index.ts for the heading →
// rotation.y mapping).
//
// COST, measured off the built model at MONSTER_MODEL_DETAIL = 4: 18,664
// triangles over 9,686 vertices in 24 meshes — body 3,360, head 2,976, the
// tentacle fan 6,664, the wings 4,256, eyes and haloes 1,408. There is exactly
// one monster in a world, and the terrain alone runs to a thousand chunk meshes,
// so this is noise in the frame budget and it is what buys the thing a face.

// Render kit, reached the same way client/src/plugins/registry.ts reaches this
// plugin — by path. See that module's header for why it lives there.
import { bakeRig, instantiateRig } from '../../../client/src/render/rigSkin.ts';
import {
  AdditiveBlending,
  BufferGeometry,
  CatmullRomCurve3,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
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
import {
  NOISE_CHANNEL_TENTACLE,
  TWO_PI,
  curlArc,
  ellipsoid,
  membranePanel,
  organicNoise,
  taperedTube,
  type ModelWorkshop,
  type MonsterModel,
  type SkinFinish,
} from './geometry.ts';

/** Base tessellations, in segments at detail 1. Multiplied by the knob. */
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

/**
 * This creature's skin, at a given carve depth. One function rather than three
 * literals so the wrinkle and mottle frequencies cannot drift apart between the
 * head and the body — they are one continuous field across the whole animal.
 */
function cthulhuSkin(wrinkleDepth: number): SkinFinish {
  return {
    wrinkleDepth,
    wrinkleFrequency: CTHULHU_WRINKLE_FREQUENCY,
    shadeVariation: CTHULHU_SHADE_VARIATION,
    shadeFrequency: CTHULHU_SHADE_FREQUENCY,
  };
}

/** Parts that must keep their exact shape: swept limbs, membranes, bones. */
const CTHULHU_SMOOTH_SKIN = cthulhuSkin(0);

/**
 * Builds the shared Cthulhu geometry and returns the per-instance constructor.
 *
 * Everything expensive happens ONCE, when the plugin attaches: the returned
 * function only assembles Meshes over geometries that already exist.
 */
export function createCthulhuFactory(workshop: ModelWorkshop): () => MonsterModel {
  const { segments, keepGeometry, keepMaterial, lambert, organicSurface } = workshop;

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
  const haloMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: CTHULHU_EYE_EMISSIVE,
      transparent: true,
      opacity: CTHULHU_EYE_HALO_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );

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
    cthulhuSkin(CTHULHU_BODY_WRINKLE_DEPTH),
  );

  // ── Head ───────────────────────────────────────────────────────────────────

  const headHalfLength = CTHULHU_HEAD_LENGTH / 2;
  const headHalfHeight = CTHULHU_HEAD_HEIGHT / 2;
  const headHalfWidth = CTHULHU_HEAD_WIDTH / 2;
  const headCenter = new Vector3(CTHULHU_HEAD_FORWARD, CTHULHU_HEAD_CENTER_HEIGHT, 0);

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
   * ONE function, called both by the vertex loop that builds the skull and by
   * the projection that puts the eyes on its skin. Two copies of this rule would
   * be two copies that could disagree, and the way they would tell you is by
   * burying an eye inside the head.
   */
  function headSculpt(u: number, above: boolean): HeadSculpt {
    const front = Math.max(0, u);
    const muzzle = 1 - CTHULHU_HEAD_MUZZLE_TAPER * front * front;
    const brow = above ? 1 - CTHULHU_HEAD_BROW_SLOPE * front * front : 1;
    return { vertical: muzzle * brow, lateral: muzzle };
  }

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

  const headGeometry = organicSurface(
    [buildHeadGeometry()],
    cthulhuSkin(CTHULHU_HEAD_WRINKLE_DEPTH),
  );

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
      CTHULHU_TENTACLE_MIN_CURL_RADIANS,
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
      CTHULHU_TENTACLE_MIN_CURL_RADIANS,
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
      upper: organicSurface([upper], CTHULHU_SMOOTH_SKIN),
      lower: organicSurface([lower, knuckle], CTHULHU_SMOOTH_SKIN),
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
          CTHULHU_WING_MEMBRANE_SCALLOP,
          CTHULHU_WING_MEMBRANE_SAG,
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
    return {
      membrane: organicSurface(panels, CTHULHU_SMOOTH_SKIN),
      ribs: organicSurface(bones, CTHULHU_SMOOTH_SKIN),
    };
  }

  const wingGeometries = [buildWingGeometry(1), buildWingGeometry(-1)];

  // ── Assembly ───────────────────────────────────────────────────────────────

  // AUTHORED ONCE, DRAWN AS ONE SURFACE. The rig below is the same one this
  // builder always made — body, head, two wings, four eye parts and a fan of
  // two-joint tentacles — but it is built a single time and handed to bakeRig,
  // which bakes it into one skinned geometry per material class. Each joint
  // survives as a BONE, so `animate` drives the identical handles it always did.
  const authored = (() => {
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

    return { root, rig, tentacles };
  })();

  const blueprint = workshop.keepRig(bakeRig(authored.root));
  const rigJoint = blueprint.jointIndex(authored.rig);
  // A tentacle's rest fan and phase are facts about its PLACE in the fan, not
  // about the individual, so they are read off the authored rig once and shared.
  const tentacleJoints = authored.tentacles.map((tentacle) => ({
    root: blueprint.jointIndex(tentacle.root),
    mid: blueprint.jointIndex(tentacle.mid),
    restFan: tentacle.restFan,
    phase: tentacle.phase,
  }));

  return function createCthulhu(): MonsterModel {
    const instance = instantiateRig(blueprint);
    const rig = instance.joints[rigJoint]!;
    const tentacles = tentacleJoints.map((joint) => ({
      root: instance.joints[joint.root]!,
      mid: instance.joints[joint.mid]!,
      restFan: joint.restFan,
      phase: joint.phase,
    }));

    return {
      root: instance.root,
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
  };
}
