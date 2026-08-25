// The yeti, built procedurally: a hunched white biped with a heavy shoulder
// mass, arms that hang below its hips, and a ruff of brighter fur at the neck.
//
// Same rules and same tools as the other two builders (./geometry.ts): no
// textures, no per-model lights, no Math.random anywhere in the geometry, shared
// resources freed exactly once. ./yeti-anatomy.ts owns every number. This file
// owns the CREATURE — which masses there are, how the skeleton is rigged, and
// how it moves.
//
// FRAME. The torso, hips, shoulders, head and ruff are authored directly in rig
// space, so one continuous noise field runs across the whole animal and the fur
// does not change character at a seam. The LIMBS are the exception, exactly as
// the kraken's arms are: each hangs off a joint, so its geometry is authored in
// that joint's space (root at the joint's origin, hanging down -Y).
//
// THE RIG, top to bottom:
//
//   root          — placed and yawed by index.ts; never touched by animate()
//    └ rig        — the bob rides here, and it only ever LIFTS
//       ├ leg k: joint at the hip (rotation.z is the stride)
//       │          ├ the swept leg
//       │          └ ankle (counter-rotated, so the sole stays flat) → foot
//       └ upper   — the lean rides here, so no foot can ever be rolled into the
//          │        ground the client placed him on
//          ├ body, ruff                     (static, rig space)
//          ├ head (rotation.y is the scan)  → head, brow, muzzle, eyes
//          └ arm k: joint at the shoulder (rotation.z is the counter-swing)
//                     ├ the swept arm
//                     └ the hand
//
// COST at MONSTER_MODEL_DETAIL = 4: 82 320 triangles in TWO draw calls, MEASURED
// rather than estimated — up from the ~15 600 that stood here before the
// 2026-08-24 pass, and now the most expensive of the three by a wide margin (the
// kraken is 7 684, Cthulhu 18 664).
//
// THAT IS THE OWNER'S STANDING FIDELITY BAR BEING PAID FOR, not drift: world
// objects go in "substantially higher resolution" than the first-pass primitive
// look, and on a model that is a pile of smooth masses and two dozen swept tubes
// the only place that money can go is ROUNDNESS — segments on profiles that ARE
// the silhouette. It is affordable for one reason and the reason should be
// checked before it is spent again: MAX_LIVING_MONSTERS is 1. There is never
// more than one of these in a world.

// Render kit, reached the same way client/src/plugins/registry.ts reaches this
// plugin — by path. See that module's header for why it lives there.
import { bakeRig, instantiateRig } from '../../../client/src/render/rigSkin.ts';
import { CatmullRomCurve3, Group, Mesh, SphereGeometry, Vector3 } from 'three';
import {
  NOISE_CHANNEL_TENTACLE,
  TWO_PI,
  ellipsoid,
  organicNoise,
  taperedTube,
  type ModelWorkshop,
  type MonsterModel,
  type SkinFinish,
} from './geometry.ts';
import {
  YETI_AMBLE_HZ,
  YETI_ANKLE_HEIGHT,
  YETI_ARM_ELBOW_DROP,
  YETI_ARM_ELBOW_FLARE,
  YETI_ARM_ELBOW_FORWARD,
  YETI_ARM_HAND_DROP,
  YETI_ARM_HAND_FLARE,
  YETI_ARM_HAND_FORWARD,
  YETI_ARM_ROOT_RADIUS,
  YETI_ARM_SWING_RADIANS,
  YETI_ARM_TIP_RADIUS,
  YETI_BELLY_FORWARD,
  YETI_BELLY_HEIGHT,
  YETI_BELLY_LENGTH,
  YETI_BELLY_RISE,
  YETI_BELLY_WIDTH,
  YETI_BOB_CELLS,
  YETI_BROW_FORWARD,
  YETI_BROW_HEIGHT,
  YETI_BROW_LENGTH,
  YETI_BROW_RISE,
  YETI_BROW_WIDTH,
  YETI_CHEEK_FORWARD,
  YETI_CHEEK_HEIGHT,
  YETI_CHEEK_LENGTH,
  YETI_CHEEK_OFFSET,
  YETI_CHEEK_RISE,
  YETI_CHEEK_WIDTH,
  YETI_DIGIT_COUNT,
  YETI_DIGIT_SPACING,
  YETI_EAR_FORWARD,
  YETI_EAR_HEIGHT,
  YETI_EAR_LENGTH,
  YETI_EAR_OFFSET,
  YETI_EAR_RISE,
  YETI_EAR_WIDTH,
  YETI_EYE_BULGE,
  YETI_EYE_COLOR,
  YETI_EYE_EMISSIVE,
  YETI_EYE_FORWARD,
  YETI_EYE_HEIGHT,
  YETI_EYE_OFFSET,
  YETI_EYE_RADIUS,
  YETI_FANG_COLOR,
  YETI_FANG_MID_FORWARD,
  YETI_FANG_MID_HEIGHT,
  YETI_FANG_MID_OFFSET,
  YETI_FANG_ROOT_FORWARD,
  YETI_FANG_ROOT_HEIGHT,
  YETI_FANG_ROOT_OFFSET,
  YETI_FANG_ROOT_RADIUS,
  YETI_FANG_TIP_FORWARD,
  YETI_FANG_TIP_HEIGHT,
  YETI_FANG_TIP_OFFSET,
  YETI_FANG_TIP_RADIUS,
  YETI_FINGER_ROOT_FORWARD,
  YETI_FINGER_ROOT_HEIGHT,
  YETI_FINGER_ROOT_RADIUS,
  YETI_FINGER_TIP_FORWARD,
  YETI_FINGER_TIP_HEIGHT,
  YETI_FINGER_TIP_RADIUS,
  YETI_FOOT_CENTER_HEIGHT,
  YETI_FOOT_FORWARD,
  YETI_FOOT_LENGTH,
  YETI_FOOT_RISE,
  YETI_FOOT_WIDTH,
  YETI_FUR_COLOR,
  YETI_FUR_WRINKLE_DEPTH,
  YETI_HAND_RADIUS,
  YETI_HEAD_CENTER_HEIGHT,
  YETI_HEAD_HEIGHT,
  YETI_HEAD_LENGTH,
  YETI_HEAD_SCAN_HZ,
  YETI_HEAD_SCAN_RADIANS,
  YETI_HEAD_WIDTH,
  YETI_HIPS_CENTER_HEIGHT,
  YETI_HIPS_HEIGHT,
  YETI_HIPS_LENGTH,
  YETI_HIPS_WIDTH,
  YETI_HIP_HEIGHT,
  YETI_HORN_BOSS_FORWARD,
  YETI_HORN_BOSS_HEIGHT,
  YETI_HORN_BOSS_LENGTH,
  YETI_HORN_BOSS_OFFSET,
  YETI_HORN_BOSS_RISE,
  YETI_HORN_BOSS_WIDTH,
  YETI_HORN_COLOR,
  YETI_HORN_EMERGE_FORWARD,
  YETI_HORN_EMERGE_HEIGHT,
  YETI_HORN_EMERGE_OFFSET,
  YETI_HORN_EMERGE_RADIUS,
  YETI_HORN_MID_FORWARD,
  YETI_HORN_MID_HEIGHT,
  YETI_HORN_MID_OFFSET,
  YETI_HORN_ROOT_FORWARD,
  YETI_HORN_ROOT_HEIGHT,
  YETI_HORN_ROOT_OFFSET,
  YETI_HORN_ROOT_RADIUS,
  YETI_HORN_TIP_FORWARD,
  YETI_HORN_TIP_HEIGHT,
  YETI_HORN_TIP_OFFSET,
  YETI_HORN_TIP_RADIUS,
  YETI_JAW_FORWARD,
  YETI_JAW_HEIGHT,
  YETI_JAW_LENGTH,
  YETI_JAW_RISE,
  YETI_JAW_WIDTH,
  YETI_KNEE_FORWARD,
  YETI_KNEE_HEIGHT,
  YETI_LEAN_RADIANS,
  YETI_LEG_ANKLE_RADIUS,
  YETI_LEG_ROOT_RADIUS,
  YETI_LEG_SWING_RADIANS,
  YETI_MANTLE_COLOR,
  YETI_MANTLE_LENGTH_VARIATION,
  YETI_MANTLE_LOCK_COUNT,
  YETI_MANTLE_LOCK_DROP,
  YETI_MANTLE_LOCK_MID_DROP,
  YETI_MANTLE_LOCK_MID_REACH,
  YETI_MANTLE_LOCK_RADIUS,
  YETI_MANTLE_LOCK_REACH,
  YETI_MANTLE_LOCK_TIP_RADIUS,
  YETI_MANTLE_RING_HEIGHT,
  YETI_MANTLE_RING_RADIUS,
  YETI_MAW_COLOR,
  YETI_MOUTH_FORWARD,
  YETI_MOUTH_HEIGHT,
  YETI_MOUTH_LENGTH,
  YETI_MOUTH_RISE,
  YETI_MOUTH_WIDTH,
  YETI_MUZZLE_FORWARD,
  YETI_MUZZLE_HEIGHT,
  YETI_MUZZLE_LENGTH,
  YETI_MUZZLE_RISE,
  YETI_MUZZLE_WIDTH,
  YETI_NOSE_FORWARD,
  YETI_NOSE_HEIGHT,
  YETI_NOSE_LENGTH,
  YETI_NOSE_RISE,
  YETI_NOSE_WIDTH,
  YETI_SHADE_FREQUENCY,
  YETI_SHADE_VARIATION,
  YETI_SHOULDER_HALF_SPAN,
  YETI_SHOULDER_HEIGHT,
  YETI_SHOULDER_JOINT_HALF_SPAN,
  YETI_SHOULDER_JOINT_HEIGHT,
  YETI_SHOULDER_LENGTH,
  YETI_SHOULDER_RISE,
  YETI_SHOULDER_WIDTH,
  YETI_SKIN_COLOR,
  YETI_SKIN_WRINKLE_DEPTH,
  YETI_STANCE_HALF_WIDTH,
  YETI_TOE_ROOT_FORWARD,
  YETI_TOE_ROOT_RADIUS,
  YETI_TOE_TIP_FORWARD,
  YETI_TOE_TIP_RADIUS,
  YETI_TORSO_CENTER_HEIGHT,
  YETI_TORSO_HEIGHT,
  YETI_TORSO_LENGTH,
  YETI_TORSO_WIDTH,
  YETI_UNDERFUR_COLOR,
  YETI_WRINKLE_FREQUENCY,
} from './yeti-anatomy.ts';

/**
 * Base tessellations, in segments at detail 1. Multiplied by the knob.
 *
 * RAISED ACROSS THE BOARD, 2026-08-22, with the quarter-size rescale: these were
 * the lowest counts of the three creatures (a torso at 7×5 against Cthulhu's
 * 7×4 head-and-body pair and the kraken's 9×5 head), and it showed as faceting
 * on exactly the parts that carry this silhouette — the swept limbs, whose two
 * radial segments made an OCTAGONAL leg at detail 4, and the round masses whose
 * profile is the whole animal.
 *
 * The counts below are chosen per part by what its shape has to hold, not by one
 * blanket multiplier: a limb is a tube seen end-on from every angle and needs
 * RADIAL segments most; a torso is a broad curved profile and needs both; a ruff
 * tuft is a spike two-tenths of a unit thick whose length is a straight taper,
 * so it takes the radial rise and keeps its path count. Affordable, that day and
 * this one, only because MAX_LIVING_MONSTERS is 1.
 *
 * NOTE THAT NEITHER RAISE IS COMPENSATION FOR A RESCALE. A quarter-size model
 * covers a sixteenth of the screen and would have needed FEWER triangles, not
 * more; the faceting was there at full size too, and the wrinkle carve — whose
 * frequency scales inversely, so the same number of wrinkles crosses the smaller
 * body — is sampled per vertex and gets strictly better resolved by every
 * segment added here.
 *
 * RAISED AGAIN, 2026-08-24, and for a different reason: not faceting this time
 * but the owner's bar for this model in particular — "you can substantially
 * increase the resolution and design complexity of this model, it does not need
 * to look simple. It can look like a Yeti." Every count below went up by roughly
 * half, with the increase weighted towards the parts a viewer looks AT — the
 * head and torso profiles, and the radial count on the limbs, which is what a
 * tube's silhouette is made of. It landed the same day the animal was cut to two
 * peep-heights, so the two pull against each other on purpose: he covers less
 * screen and every bit of it is better resolved.
 *
 * MEASURED, not guessed — `node --experimental-strip-types` over the built
 * geometry, summing index counts: 82 320 triangles at MONSTER_MODEL_DETAIL = 4,
 * against the 15 600 these counts replaced and the 6 024 before that. The face
 * rebuild, the mantle, the horn bosses and the digits are most of that; the
 * raised counts below are the rest.
 */
const TORSO_SPHERE_SEGMENTS_BASE = 18;
const TORSO_SPHERE_RINGS_BASE = 13;
const BELLY_SPHERE_SEGMENTS_BASE = 12;
const BELLY_SPHERE_RINGS_BASE = 9;
const HIPS_SPHERE_SEGMENTS_BASE = 12;
const HIPS_SPHERE_RINGS_BASE = 9;
const SHOULDER_SPHERE_SEGMENTS_BASE = 12;
const SHOULDER_SPHERE_RINGS_BASE = 9;
const HEAD_SPHERE_SEGMENTS_BASE = 18;
const HEAD_SPHERE_RINGS_BASE = 13;
const BROW_SPHERE_SEGMENTS_BASE = 9;
const BROW_SPHERE_RINGS_BASE = 7;
const MUZZLE_SPHERE_SEGMENTS_BASE = 12;
const MUZZLE_SPHERE_RINGS_BASE = 9;
const JAW_SPHERE_SEGMENTS_BASE = 11;
const JAW_SPHERE_RINGS_BASE = 8;
const CHEEK_SPHERE_SEGMENTS_BASE = 7;
const CHEEK_SPHERE_RINGS_BASE = 5;
const EAR_SPHERE_SEGMENTS_BASE = 6;
const EAR_SPHERE_RINGS_BASE = 5;
const HORN_BOSS_SPHERE_SEGMENTS_BASE = 8;
const HORN_BOSS_SPHERE_RINGS_BASE = 6;
const NOSE_SPHERE_SEGMENTS_BASE = 8;
const NOSE_SPHERE_RINGS_BASE = 6;
const MOUTH_SPHERE_SEGMENTS_BASE = 9;
const MOUTH_SPHERE_RINGS_BASE = 5;
const EYE_SPHERE_SEGMENTS_BASE = 7;
const EYE_SPHERE_RINGS_BASE = 5;
const FOOT_SPHERE_SEGMENTS_BASE = 12;
const FOOT_SPHERE_RINGS_BASE = 8;
const HAND_SPHERE_SEGMENTS_BASE = 10;
const HAND_SPHERE_RINGS_BASE = 7;
/** Limbs: along the sweep, and around it. Thirty-two sides to a leg, not eight. */
const LIMB_PATH_SEGMENTS_BASE = 8;
const LIMB_RADIAL_SEGMENTS_BASE = 8;
/**
 * MANTLE LOCKS: fat and short, which is the whole difference between the collar
 * and the spikes it replaced (see YETI_MANTLE_LOCK_COUNT). Being fat is also
 * what decides the counts: a thick tube's silhouette is its RING, and its length
 * is a straight taper that rings along it buy nothing for.
 */
const LOCK_PATH_SEGMENTS_BASE = 3;
const LOCK_RADIAL_SEGMENTS_BASE = 6;
/** Fingers and toes: small, and never seen end-on. Cheap on both axes. */
const DIGIT_PATH_SEGMENTS_BASE = 2;
const DIGIT_RADIAL_SEGMENTS_BASE = 4;
/**
 * HORNS. A horn is a long, strongly curved taper seen against the sky from every
 * angle, so it is the one part of him whose PATH count matters as much as its
 * radial one: too few segments along the sweep and the curve becomes two straight
 * pieces with a kink, which is the single most obvious way a horn reads as a
 * prop. The radial count is a tube's silhouette, as everywhere else.
 */
const HORN_PATH_SEGMENTS_BASE = 8;
const HORN_RADIAL_SEGMENTS_BASE = 7;
/**
 * FANGS. Short, nearly straight, and small on the screen — but they are the
 * highest-contrast thing on the animal (ivory on slate, see YETI_FANG_COLOR), so
 * faceting shows on them out of all proportion to their size. They get a radial
 * count close to the horns' and almost no path segments, which is what their
 * shape actually is.
 */
const FANG_PATH_SEGMENTS_BASE = 3;
const FANG_RADIAL_SEGMENTS_BASE = 5;

/** The two sides, in a fixed order. +1 is the model's left (+Z). */
const SIDES = [1, -1] as const;

/** This creature's skin, at a given carve depth. See cthulhu.ts for the shape. */
function yetiSkin(wrinkleDepth: number): SkinFinish {
  return {
    wrinkleDepth,
    wrinkleFrequency: YETI_WRINKLE_FREQUENCY,
    shadeVariation: YETI_SHADE_VARIATION,
    shadeFrequency: YETI_SHADE_FREQUENCY,
  };
}

/** Furred masses: the deep, fine carve that reads as shag. */
const YETI_FUR_SKIN = yetiSkin(YETI_FUR_WRINKLE_DEPTH);
/** Bare skin: the nose pad, the hands and the feet. A shallower carve — hide,
 *  not fur. */
const YETI_BARE_SKIN = yetiSkin(YETI_SKIN_WRINKLE_DEPTH);
/**
 * Parts that must keep their exact shape: the swept limbs, the mantle locks,
 * the horns, the fangs and —
 * above all — the FEET, whose soles are the surface the client's placement maths
 * puts on the ground (see YETI_FOOT_CENTER_HEIGHT).
 */
const YETI_SMOOTH_SKIN = yetiSkin(0);

/**
 * Builds the shared yeti geometry and returns the per-instance constructor.
 *
 * Everything expensive happens ONCE, when the plugin attaches: the returned
 * function only assembles Meshes over geometries that already exist.
 */
export function createYetiFactory(workshop: ModelWorkshop): () => MonsterModel {
  const { segments, keepGeometry, lambert, organicSurface } = workshop;

  // ── Shared materials ───────────────────────────────────────────────────────

  const furMaterial = lambert(YETI_FUR_COLOR);
  const underfurMaterial = lambert(YETI_UNDERFUR_COLOR);
  const mantleMaterial = lambert(YETI_MANTLE_COLOR);
  const mawMaterial = lambert(YETI_MAW_COLOR);
  const skinMaterial = lambert(YETI_SKIN_COLOR);
  const hornMaterial = lambert(YETI_HORN_COLOR);
  const fangMaterial = lambert(YETI_FANG_COLOR);
  /**
   * LIT, with a trace of emission under it — unlike the two sea kinds', whose
   * eyes are unshaded because they ARE lamps burning in dark water.
   *
   * This one is a wet eye in daylight and has to be shaded to read as one: an
   * unshaded sphere renders as a flat disc of solid colour whatever its
   * geometry, which on a face this close is the difference between an eye and a
   * sticker. See YETI_EYE_EMISSIVE.
   */
  const eyeMaterial = lambert(YETI_EYE_COLOR, { emissive: YETI_EYE_EMISSIVE });

  // ── Body: hips, torso, shoulders ───────────────────────────────────────────
  //
  // One merged surface, so the fur field runs unbroken from hip to shoulder and
  // the whole mass is a single draw call. The three masses overlap by design —
  // the weld and the shared normals turn the intersections into one continuous
  // body rather than three balls in a row.

  const bodyGeometry = organicSurface(
    [
      ellipsoid(
        YETI_HIPS_LENGTH,
        YETI_HIPS_HEIGHT,
        YETI_HIPS_WIDTH,
        segments(HIPS_SPHERE_SEGMENTS_BASE),
        segments(HIPS_SPHERE_RINGS_BASE),
        new Vector3(0, YETI_HIPS_CENTER_HEIGHT, 0),
      ),
      ellipsoid(
        YETI_TORSO_LENGTH,
        YETI_TORSO_HEIGHT,
        YETI_TORSO_WIDTH,
        segments(TORSO_SPHERE_SEGMENTS_BASE),
        segments(TORSO_SPHERE_RINGS_BASE),
        new Vector3(0, YETI_TORSO_CENTER_HEIGHT, 0),
      ),
      // The belly closes the waist between torso and hips — front only, so it
      // deepens the chest line without widening the footprint.
      ellipsoid(
        YETI_BELLY_LENGTH,
        YETI_BELLY_RISE,
        YETI_BELLY_WIDTH,
        segments(BELLY_SPHERE_SEGMENTS_BASE),
        segments(BELLY_SPHERE_RINGS_BASE),
        new Vector3(YETI_BELLY_FORWARD, YETI_BELLY_HEIGHT, 0),
      ),
      ...SIDES.map((side) =>
        ellipsoid(
          YETI_SHOULDER_LENGTH,
          YETI_SHOULDER_RISE,
          YETI_SHOULDER_WIDTH,
          segments(SHOULDER_SPHERE_SEGMENTS_BASE),
          segments(SHOULDER_SPHERE_RINGS_BASE),
          new Vector3(0, YETI_SHOULDER_HEIGHT, side * YETI_SHOULDER_HALF_SPAN),
        ),
      ),
    ],
    YETI_FUR_SKIN,
  );

  // ── Head ───────────────────────────────────────────────────────────────────

  const headHalfLength = YETI_HEAD_LENGTH / 2;
  const headHalfHeight = YETI_HEAD_HEIGHT / 2;
  const headHalfWidth = YETI_HEAD_WIDTH / 2;
  const headCenter = new Vector3(0, YETI_HEAD_CENTER_HEIGHT, 0);

  // THE WHOLE FURRED HEAD IS ONE SURFACE: skull, brow, muzzle, jaw, cheeks,
  // ears and the two horn bosses. They are welded together and carved as one, so
  // the fur field runs across the face without a seam and the boss genuinely
  // becomes part of the skull rather than a ball resting on it — which is the
  // whole point of it existing (see YETI_HORN_BOSS_HEIGHT).
  //
  // Separate from the BODY so the head can turn. That seam costs one draw call
  // and no continuity, because the noise field is a function of POSITION and
  // both geometries are authored in the same rig space.
  const headGeometry = organicSurface(
    [
      ellipsoid(
        YETI_HEAD_LENGTH,
        YETI_HEAD_HEIGHT,
        YETI_HEAD_WIDTH,
        segments(HEAD_SPHERE_SEGMENTS_BASE),
        segments(HEAD_SPHERE_RINGS_BASE),
        headCenter,
      ),
      ellipsoid(
        YETI_BROW_LENGTH,
        YETI_BROW_RISE,
        YETI_BROW_WIDTH,
        segments(BROW_SPHERE_SEGMENTS_BASE),
        segments(BROW_SPHERE_RINGS_BASE),
        new Vector3(YETI_BROW_FORWARD, YETI_BROW_HEIGHT, 0),
      ),
      // The muzzle is FUR now, and part of the skull surface. It was its own
      // dark mass until 2026-08-24; see YETI_SKIN_COLOR for what that cost.
      ellipsoid(
        YETI_MUZZLE_LENGTH,
        YETI_MUZZLE_RISE,
        YETI_MUZZLE_WIDTH,
        segments(MUZZLE_SPHERE_SEGMENTS_BASE),
        segments(MUZZLE_SPHERE_RINGS_BASE),
        new Vector3(YETI_MUZZLE_FORWARD, YETI_MUZZLE_HEIGHT, 0),
      ),
      ellipsoid(
        YETI_JAW_LENGTH,
        YETI_JAW_RISE,
        YETI_JAW_WIDTH,
        segments(JAW_SPHERE_SEGMENTS_BASE),
        segments(JAW_SPHERE_RINGS_BASE),
        new Vector3(YETI_JAW_FORWARD, YETI_JAW_HEIGHT, 0),
      ),
      ...SIDES.map((side) =>
        ellipsoid(
          YETI_CHEEK_LENGTH,
          YETI_CHEEK_RISE,
          YETI_CHEEK_WIDTH,
          segments(CHEEK_SPHERE_SEGMENTS_BASE),
          segments(CHEEK_SPHERE_RINGS_BASE),
          new Vector3(YETI_CHEEK_FORWARD, YETI_CHEEK_HEIGHT, side * YETI_CHEEK_OFFSET),
        ),
      ),
      ...SIDES.map((side) =>
        ellipsoid(
          YETI_EAR_LENGTH,
          YETI_EAR_RISE,
          YETI_EAR_WIDTH,
          segments(EAR_SPHERE_SEGMENTS_BASE),
          segments(EAR_SPHERE_RINGS_BASE),
          new Vector3(YETI_EAR_FORWARD, YETI_EAR_HEIGHT, side * YETI_EAR_OFFSET),
        ),
      ),
      // THE HORN BOSSES. Merged into the skull, not the horn: a pedicle is bone
      // under fur, and the horn is what grows out of it.
      ...SIDES.map((side) =>
        ellipsoid(
          YETI_HORN_BOSS_LENGTH,
          YETI_HORN_BOSS_RISE,
          YETI_HORN_BOSS_WIDTH,
          segments(HORN_BOSS_SPHERE_SEGMENTS_BASE),
          segments(HORN_BOSS_SPHERE_RINGS_BASE),
          new Vector3(
            YETI_HORN_BOSS_FORWARD,
            YETI_HORN_BOSS_HEIGHT,
            side * YETI_HORN_BOSS_OFFSET,
          ),
        ),
      ),
    ],
    YETI_FUR_SKIN,
  );

  /** The nose pad — the only bare skin left on the face. */
  const noseGeometry = organicSurface(
    [
      ellipsoid(
        YETI_NOSE_LENGTH,
        YETI_NOSE_RISE,
        YETI_NOSE_WIDTH,
        segments(NOSE_SPHERE_SEGMENTS_BASE),
        segments(NOSE_SPHERE_RINGS_BASE),
        new Vector3(YETI_NOSE_FORWARD, YETI_NOSE_HEIGHT, 0),
      ),
    ],
    YETI_BARE_SKIN,
  );

  /** The mouth: a dark slot between the muzzle and the jaw. */
  const mouthGeometry = organicSurface(
    [
      ellipsoid(
        YETI_MOUTH_LENGTH,
        YETI_MOUTH_RISE,
        YETI_MOUTH_WIDTH,
        segments(MOUTH_SPHERE_SEGMENTS_BASE),
        segments(MOUTH_SPHERE_RINGS_BASE),
        new Vector3(YETI_MOUTH_FORWARD, YETI_MOUTH_HEIGHT, 0),
      ),
    ],
    YETI_SMOOTH_SKIN,
  );

  /**
   * Where an eye sits: the point on the head's ellipsoid in the direction of the
   * anatomy's stated eye point, pushed out along the SURFACE NORMAL by its bulge
   * so the sphere breaks the skin instead of hiding under it.
   *
   * The normal of an ellipsoid at a point is that point divided by the squares
   * of its semi-axes — not the point itself, which is why an eye pushed along
   * the radius of a long head sinks into the cheek. (Identical to the kraken's
   * rule, restated here rather than shared: it is four lines, and hoisting it
   * into the workshop would mean the workshop knowing what an eye is.)
   */
  function eyePosition(side: number): Vector3 {
    const direction = new Vector3(
      (YETI_EYE_FORWARD - headCenter.x) / headHalfLength,
      (YETI_EYE_HEIGHT - headCenter.y) / headHalfHeight,
      (side * YETI_EYE_OFFSET) / headHalfWidth,
    ).normalize();
    const surface = new Vector3(
      direction.x * headHalfLength,
      direction.y * headHalfHeight,
      direction.z * headHalfWidth,
    );
    const outward = new Vector3(
      surface.x / (headHalfLength * headHalfLength),
      surface.y / (headHalfHeight * headHalfHeight),
      surface.z / (headHalfWidth * headHalfWidth),
    ).normalize();
    return surface.add(headCenter).addScaledVector(outward, YETI_EYE_RADIUS * YETI_EYE_BULGE);
  }

  const eyeGeometry = keepGeometry(
    new SphereGeometry(
      YETI_EYE_RADIUS,
      segments(EYE_SPHERE_SEGMENTS_BASE),
      segments(EYE_SPHERE_RINGS_BASE),
    ),
  );

  // ── Horns and fangs ────────────────────────────────────────────────────────
  //
  // Both hang off the HEAD, in the same rig space the skull and muzzle are
  // authored in, so they turn with the scan and the noise field runs across
  // them continuously with everything else on the head.
  //
  // ONE GEOMETRY PER PAIR, not per side: unlike the arms, a horn and a fang are
  // authored in rig space rather than in a joint's space, so the left and right
  // members of a pair are different shapes and both have to exist in the merged
  // surface. Merging the pair is what keeps each of them a single draw call.
  //
  // SMOOTH-SKINNED, both. The fur carve is a fur carve; horn and enamel are the
  // two hard surfaces on this animal and a wrinkle in either reads as damage.
  // It also keeps YETI_TOTAL_HEIGHT a real bound, since the carve may only ever
  // push inward and the horn tip is what that bound is measured to.

  /**
   * A swept pair, mirrored in Z, as one merged surface.
   *
   * `points` is the centre line of the RIGHT-hand member, root first; `radii`
   * gives the tube's radius at each of those points and must be the same length,
   * because a horn's thickness is a property of WHERE ALONG IT you are and not
   * of a linear taper — the flare out of the boss is the whole reason this takes
   * a profile rather than two end radii.
   */
  function sweptPair(
    points: readonly Vector3[],
    radii: readonly number[],
    pathSegmentsBase: number,
    radialSegmentsBase: number,
  ): ReturnType<typeof organicSurface> {
    if (points.length !== radii.length) {
      throw new Error('a swept pair needs one radius per control point');
    }
    // The radius between two control points is a straight blend of theirs; the
    // curve's own parameter is close enough to uniform over these short spans
    // that scaling `along` by the span count is the honest reading of it.
    const lastSpan = radii.length - 1;
    const radiusAt = (along: number): number => {
      const scaled = Math.min(along, 1) * lastSpan;
      const span = Math.min(Math.floor(scaled), lastSpan - 1);
      const withinSpan = scaled - span;
      return radii[span]! + (radii[span + 1]! - radii[span]!) * withinSpan;
    };
    return organicSurface(
      SIDES.map((side) =>
        taperedTube(
          new CatmullRomCurve3(
            points.map((point) => new Vector3(point.x, point.y, side * point.z)),
          ),
          radiusAt,
          segments(pathSegmentsBase),
          segments(radialSegmentsBase),
        ),
      ),
      YETI_SMOOTH_SKIN,
    );
  }

  // FOUR control points, not three, and the extra one is the stitch: the root is
  // sunk to the middle of the boss and the EMERGENCE point sits just clear of it,
  // still fat. That is what makes the horn flare out of the skull instead of
  // arriving at the surface already at its final thickness.
  const hornGeometry = sweptPair(
    [
      new Vector3(YETI_HORN_ROOT_FORWARD, YETI_HORN_ROOT_HEIGHT, YETI_HORN_ROOT_OFFSET),
      new Vector3(
        YETI_HORN_EMERGE_FORWARD,
        YETI_HORN_EMERGE_HEIGHT,
        YETI_HORN_EMERGE_OFFSET,
      ),
      new Vector3(YETI_HORN_MID_FORWARD, YETI_HORN_MID_HEIGHT, YETI_HORN_MID_OFFSET),
      new Vector3(YETI_HORN_TIP_FORWARD, YETI_HORN_TIP_HEIGHT, YETI_HORN_TIP_OFFSET),
    ],
    [
      YETI_HORN_ROOT_RADIUS,
      YETI_HORN_EMERGE_RADIUS,
      (YETI_HORN_EMERGE_RADIUS + YETI_HORN_TIP_RADIUS) / 2,
      YETI_HORN_TIP_RADIUS,
    ],
    HORN_PATH_SEGMENTS_BASE,
    HORN_RADIAL_SEGMENTS_BASE,
  );

  const fangGeometry = sweptPair(
    [
      new Vector3(YETI_FANG_ROOT_FORWARD, YETI_FANG_ROOT_HEIGHT, YETI_FANG_ROOT_OFFSET),
      new Vector3(YETI_FANG_MID_FORWARD, YETI_FANG_MID_HEIGHT, YETI_FANG_MID_OFFSET),
      new Vector3(YETI_FANG_TIP_FORWARD, YETI_FANG_TIP_HEIGHT, YETI_FANG_TIP_OFFSET),
    ],
    [
      YETI_FANG_ROOT_RADIUS,
      (YETI_FANG_ROOT_RADIUS + YETI_FANG_TIP_RADIUS) / 2,
      YETI_FANG_TIP_RADIUS,
    ],
    FANG_PATH_SEGMENTS_BASE,
    FANG_RADIAL_SEGMENTS_BASE,
  );

  // ── Mantle ─────────────────────────────────────────────────────────────────

  /**
   * The collar, as ONE geometry: every lock is static in rig space and they all
   * share a material, so merging them costs nothing and saves eight draw calls.
   *
   * Each lock's length is a deterministic sample of the noise field at its index
   * — the same trick the kraken's crown uses, so every client grows the same
   * mantle — and it only ever SHORTENS (see YETI_MANTLE_LENGTH_VARIATION), which
   * is what keeps YETI_MANTLE_REACH a real bound.
   *
   * A LOCK RUNS OUT AND THEN DOWN, which is the shape the ruff it replaced did
   * not have: the midpoint is 70% of the way out but only 35% of the way down,
   * so the piece lies along the top of the shoulder before it falls off the
   * side of it. Drop is nearly twice reach, and the tube is thick — those two
   * facts together are the difference between a mane and a set of quills.
   */
  function buildMantle(): ReturnType<typeof organicSurface> {
    const locks = [];
    for (let index = 0; index < YETI_MANTLE_LOCK_COUNT; index++) {
      // organicNoise is in [-1, 1]; this maps it to [0, 1] so the scale below is
      // in [1 - variation, 1] and a lock can only ever be shorter.
      const wobble = 0.5 + 0.5 * organicNoise(index, 0, 0, NOISE_CHANNEL_TENTACLE);
      const scale = 1 - wobble * YETI_MANTLE_LENGTH_VARIATION;

      // Lock 0 lies on the centre line ahead of him; the rest divide the circle.
      const angle = (index / YETI_MANTLE_LOCK_COUNT) * TWO_PI;
      const outX = Math.cos(angle);
      const outZ = Math.sin(angle);
      const at = (reach: number, drop: number): Vector3 => {
        const radius = YETI_MANTLE_RING_RADIUS + reach * scale;
        return new Vector3(
          radius * outX,
          YETI_MANTLE_RING_HEIGHT - drop * scale,
          radius * outZ,
        );
      };

      const curve = new CatmullRomCurve3([
        at(0, 0),
        at(
          YETI_MANTLE_LOCK_REACH * YETI_MANTLE_LOCK_MID_REACH,
          YETI_MANTLE_LOCK_DROP * YETI_MANTLE_LOCK_MID_DROP,
        ),
        at(YETI_MANTLE_LOCK_REACH, YETI_MANTLE_LOCK_DROP),
      ]);
      locks.push(
        taperedTube(
          curve,
          (along) =>
            YETI_MANTLE_LOCK_RADIUS +
            (YETI_MANTLE_LOCK_TIP_RADIUS - YETI_MANTLE_LOCK_RADIUS) * along,
          segments(LOCK_PATH_SEGMENTS_BASE),
          segments(LOCK_RADIAL_SEGMENTS_BASE),
        ),
      );
    }
    return organicSurface(locks, YETI_SMOOTH_SKIN);
  }

  const mantleGeometry = buildMantle();

  // ── Limbs ──────────────────────────────────────────────────────────────────

  /**
   * The leg, in JOINT SPACE: the hip is the origin and it hangs down -Y, with a
   * slight forward break at the knee so it is a limb rather than a post. One
   * geometry serves both legs — they are mirror images of each other about a
   * plane the shape is already symmetric in.
   */
  const legGeometry = organicSurface(
    [
      taperedTube(
        new CatmullRomCurve3([
          new Vector3(0, 0, 0),
          new Vector3(YETI_KNEE_FORWARD, YETI_KNEE_HEIGHT - YETI_HIP_HEIGHT, 0),
          new Vector3(0, YETI_ANKLE_HEIGHT - YETI_HIP_HEIGHT, 0),
        ]),
        (along) =>
          YETI_LEG_ROOT_RADIUS + (YETI_LEG_ANKLE_RADIUS - YETI_LEG_ROOT_RADIUS) * along,
        segments(LIMB_PATH_SEGMENTS_BASE),
        segments(LIMB_RADIAL_SEGMENTS_BASE),
      ),
    ],
    YETI_SMOOTH_SKIN,
  );

  // The foot, in ANKLE space. Smooth-skinned: its sole is the plane the client
  // stands him on, and a carve would lift it off the snow.
  const footSoleHeight = YETI_FOOT_CENTER_HEIGHT - YETI_ANKLE_HEIGHT;
  const footGeometry = organicSurface(
    [
      ellipsoid(
        YETI_FOOT_LENGTH,
        YETI_FOOT_RISE,
        YETI_FOOT_WIDTH,
        segments(FOOT_SPHERE_SEGMENTS_BASE),
        segments(FOOT_SPHERE_RINGS_BASE),
        new Vector3(YETI_FOOT_FORWARD, footSoleHeight, 0),
      ),
      // Toes, running FORWARD at the foot's own height — level, not splayed
      // down, so nothing on them dips below the sole the placement maths trusts
      // to be flat (see YETI_FOOT_CENTER_HEIGHT).
      ...digits(
        new Vector3(YETI_TOE_ROOT_FORWARD, footSoleHeight, 0),
        new Vector3(YETI_TOE_TIP_FORWARD, footSoleHeight, 0),
        YETI_TOE_ROOT_RADIUS,
        YETI_TOE_TIP_RADIUS,
      ),
    ],
    YETI_SMOOTH_SKIN,
  );

  /**
   * The arm, in JOINT SPACE — one geometry per side, because an arm flares
   * OUTWARD and outward is a different direction on the two of them. Mirroring
   * one geometry with a negative scale would invert its winding and light it
   * inside out.
   */
  const armGeometries = SIDES.map((side) =>
    organicSurface(
      [
        taperedTube(
          new CatmullRomCurve3([
            new Vector3(0, 0, 0),
            new Vector3(
              YETI_ARM_ELBOW_FORWARD,
              -YETI_ARM_ELBOW_DROP,
              side * YETI_ARM_ELBOW_FLARE,
            ),
            new Vector3(YETI_ARM_HAND_FORWARD, -YETI_ARM_HAND_DROP, side * YETI_ARM_HAND_FLARE),
          ]),
          (along) =>
            YETI_ARM_ROOT_RADIUS + (YETI_ARM_TIP_RADIUS - YETI_ARM_ROOT_RADIUS) * along,
          segments(LIMB_PATH_SEGMENTS_BASE),
          segments(LIMB_RADIAL_SEGMENTS_BASE),
        ),
      ],
      YETI_SMOOTH_SKIN,
    ),
  );

  /**
   * The digits of one extremity: YETI_DIGIT_COUNT short tapered tubes, fanned
   * across Z about the centre one and rooted INSIDE the mass they belong to.
   *
   * Shared by the hand and the foot because a finger and a toe on this animal
   * are the same object at two angles — the only difference is which way they
   * point, which is what the two end points say.
   */
  function digits(root: Vector3, tip: Vector3, rootRadius: number, tipRadius: number) {
    const middle = (YETI_DIGIT_COUNT - 1) / 2;
    return Array.from({ length: YETI_DIGIT_COUNT }, (_unused, index) => {
      const offset = (index - middle) * YETI_DIGIT_SPACING;
      return taperedTube(
        new CatmullRomCurve3([
          new Vector3(root.x, root.y, root.z + offset),
          new Vector3((root.x + tip.x) / 2, (root.y + tip.y) / 2, tip.z + offset),
          new Vector3(tip.x, tip.y, tip.z + offset),
        ]),
        (along) => rootRadius + (tipRadius - rootRadius) * along,
        segments(DIGIT_PATH_SEGMENTS_BASE),
        segments(DIGIT_RADIAL_SEGMENTS_BASE),
      );
    });
  }

  const handGeometry = organicSurface(
    [
      ellipsoid(
        YETI_HAND_RADIUS * 2,
        YETI_HAND_RADIUS * 2,
        YETI_HAND_RADIUS * 2,
        segments(HAND_SPHERE_SEGMENTS_BASE),
        segments(HAND_SPHERE_RINGS_BASE),
      ),
      // Fingers, hanging forward and down out of the fist.
      ...digits(
        new Vector3(YETI_FINGER_ROOT_FORWARD, YETI_FINGER_ROOT_HEIGHT, 0),
        new Vector3(YETI_FINGER_TIP_FORWARD, YETI_FINGER_TIP_HEIGHT, 0),
        YETI_FINGER_ROOT_RADIUS,
        YETI_FINGER_TIP_RADIUS,
      ),
    ],
    YETI_BARE_SKIN,
  );

  // ── Assembly ───────────────────────────────────────────────────────────────

  // AUTHORED ONCE, DRAWN AS ONE SURFACE. The rig below is exactly the one this
  // builder always made — see the diagram in this file's header — but it is
  // built a single time and handed to bakeRig, which bakes it into one skinned
  // geometry per material class. Every Group named here survives as a BONE, so
  // `animate` drives the identical handles it always did.
  const authored = (() => {
    const root = new Group();
    // The caller owns `root` (position + yaw). Everything animated hangs off
    // `rig`, so the gait cannot fight the placement maths.
    const rig = new Group();
    root.add(rig);

    // THE LEGS HANG OFF `rig`, NOT off `upper`: the lean must never reach them,
    // or a planted foot would be rolled into the ground every stride.
    const legJoints: Group[] = [];
    const ankles: Group[] = [];
    for (const side of SIDES) {
      const joint = new Group();
      joint.position.set(0, YETI_HIP_HEIGHT, side * YETI_STANCE_HALF_WIDTH);
      joint.add(new Mesh(legGeometry, underfurMaterial));

      const ankle = new Group();
      ankle.position.set(0, YETI_ANKLE_HEIGHT - YETI_HIP_HEIGHT, 0);
      ankle.add(new Mesh(footGeometry, skinMaterial));
      joint.add(ankle);

      rig.add(joint);
      legJoints.push(joint);
      ankles.push(ankle);
    }

    const upper = new Group();
    rig.add(upper);
    upper.add(new Mesh(bodyGeometry, furMaterial));
    upper.add(new Mesh(mantleGeometry, mantleMaterial));

    const head = new Group();
    head.add(new Mesh(headGeometry, furMaterial));
    head.add(new Mesh(noseGeometry, skinMaterial));
    head.add(new Mesh(mouthGeometry, mawMaterial));
    head.add(new Mesh(hornGeometry, hornMaterial));
    head.add(new Mesh(fangGeometry, fangMaterial));
    for (const side of SIDES) {
      const eye = new Mesh(eyeGeometry, eyeMaterial);
      eye.position.copy(eyePosition(side));
      head.add(eye);
    }
    upper.add(head);

    const armJoints: Group[] = [];
    SIDES.forEach((side, index) => {
      const joint = new Group();
      joint.position.set(0, YETI_SHOULDER_JOINT_HEIGHT, side * YETI_SHOULDER_JOINT_HALF_SPAN);
      joint.add(new Mesh(armGeometries[index]!, underfurMaterial));

      const hand = new Mesh(handGeometry, skinMaterial);
      hand.position.set(
        YETI_ARM_HAND_FORWARD,
        -YETI_ARM_HAND_DROP,
        side * YETI_ARM_HAND_FLARE,
      );
      joint.add(hand);

      upper.add(joint);
      armJoints.push(joint);
    });

    return { root, rig, upper, head, legJoints, ankles, armJoints };
  })();

  const blueprint = workshop.keepRig(bakeRig(authored.root));
  const rigJoint = blueprint.jointIndex(authored.rig);
  const upperJoint = blueprint.jointIndex(authored.upper);
  const headJoint = blueprint.jointIndex(authored.head);
  const legJointIndices = authored.legJoints.map((joint) => blueprint.jointIndex(joint));
  const ankleJointIndices = authored.ankles.map((joint) => blueprint.jointIndex(joint));
  const armJointIndices = authored.armJoints.map((joint) => blueprint.jointIndex(joint));

  return function createYeti(): MonsterModel {
    const instance = instantiateRig(blueprint);
    const rig = instance.joints[rigJoint]!;
    const upper = instance.joints[upperJoint]!;
    const head = instance.joints[headJoint]!;
    const legJoints = legJointIndices.map((index) => instance.joints[index]!);
    const ankles = ankleJointIndices.map((index) => instance.joints[index]!);
    const armJoints = armJointIndices.map((index) => instance.joints[index]!);

    return {
      root: instance.root,
      animate(seconds, phase) {
        // ONE WAVE DRIVES THE WHOLE GAIT, at the rate his stride and his speed
        // between them fix (YETI_AMBLE_HZ). Everything below is a phase of it,
        // so nothing can drift out of step with anything else.
        const wave = seconds * YETI_AMBLE_HZ * TWO_PI + phase;
        const stride = Math.sin(wave);

        // LEGS in antiphase, ARMS opposite the leg on their own side: that is
        // what makes it a walk rather than a hop.
        SIDES.forEach((side, index) => {
          const swing = stride * side;
          legJoints[index]!.rotation.z = swing * YETI_LEG_SWING_RADIANS;
          // The ankle counter-rotates by exactly the stride, so the sole stays
          // parallel to the ground it is standing on. Without it the toe digs in
          // at one end of every step.
          ankles[index]!.rotation.z = -swing * YETI_LEG_SWING_RADIANS;
          armJoints[index]!.rotation.z = -swing * YETI_ARM_SWING_RADIANS;
        });

        // LEAN: one roll per gait cycle, a quarter cycle behind the legs, so he
        // is leaning over the foot that is planted. On `upper` only — see the
        // note at YETI_LEAN_RADIANS for why it may not touch the legs.
        upper.rotation.x = Math.cos(wave) * YETI_LEAN_RADIANS;

        // BOB: twice per cycle (once per step), and it only ever LIFTS —
        // (1 - cos)/2 is zero at its lowest, so his feet never sink into the
        // ground the client just placed them on.
        rig.position.y = YETI_BOB_CELLS * ((1 - Math.cos(wave * 2)) / 2);

        // THE HEAD SCANS on its own unrelated clock, so the two motions never
        // lock into a pattern a player can feel repeating.
        head.rotation.y =
          Math.sin(seconds * YETI_HEAD_SCAN_HZ * TWO_PI + phase) * YETI_HEAD_SCAN_RADIANS;
      },
    };
  };
}
