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
// COST at MONSTER_MODEL_DETAIL = 4: ~15 600 triangles — twice the kraken's 7 700
// and still under Cthulhu's 18 664, even though this animal is a handful of
// smooth masses and six swept tubes where he is a face, a tentacle fan and two
// ribbed membranes. He spends the extra on ROUNDNESS rather than on parts (see
// the base counts below, raised 2026-08-22). All three are hero models and there
// is at most one of each in a world.

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
  YETI_BOB_CELLS,
  YETI_BROW_FORWARD,
  YETI_BROW_HEIGHT,
  YETI_BROW_LENGTH,
  YETI_BROW_RISE,
  YETI_BROW_WIDTH,
  YETI_EYE_BULGE,
  YETI_EYE_COLOR,
  YETI_EYE_EMISSIVE,
  YETI_EYE_FORWARD,
  YETI_EYE_HEIGHT,
  YETI_EYE_OFFSET,
  YETI_EYE_RADIUS,
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
  YETI_KNEE_FORWARD,
  YETI_KNEE_HEIGHT,
  YETI_LEAN_RADIANS,
  YETI_LEG_ANKLE_RADIUS,
  YETI_LEG_ROOT_RADIUS,
  YETI_LEG_SWING_RADIANS,
  YETI_MUZZLE_FORWARD,
  YETI_MUZZLE_HEIGHT,
  YETI_MUZZLE_LENGTH,
  YETI_MUZZLE_RISE,
  YETI_MUZZLE_WIDTH,
  YETI_RUFF_COLOR,
  YETI_RUFF_LENGTH_VARIATION,
  YETI_RUFF_RING_HEIGHT,
  YETI_RUFF_RING_RADIUS,
  YETI_RUFF_TUFT_COUNT,
  YETI_RUFF_TUFT_DROP,
  YETI_RUFF_TUFT_MID_DROP,
  YETI_RUFF_TUFT_MID_REACH,
  YETI_RUFF_TUFT_RADIUS,
  YETI_RUFF_TUFT_REACH,
  YETI_RUFF_TUFT_TIP_RADIUS,
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
 * so it takes the radial rise and keeps its path count. The result is ~14 400
 * triangles at MONSTER_MODEL_DETAIL = 4, up from ~5 800 and still under
 * Cthulhu's 18 664 — affordable because MAX_LIVING_MONSTERS is 1.
 *
 * NOTE THAT THIS IS NOT COMPENSATION FOR THE RESCALE. A quarter-size model
 * covers a sixteenth of the screen and would have needed FEWER triangles, not
 * more; the faceting was there at full size too, and the wrinkle carve — whose
 * frequency scales inversely, so the same number of wrinkles crosses the smaller
 * body — is sampled per vertex and gets strictly better resolved by every
 * segment added here.
 *
 * COUNTED, not guessed: a UV sphere of S segments and R rings is S·(2R − 2)
 * triangles and an uncapped tube of P path segments and N radial is 2·P·N, both
 * at MONSTER_MODEL_DETAIL = 4 — 15 600 against the 6 024 these counts replaced.
 */
const TORSO_SPHERE_SEGMENTS_BASE = 10;
const TORSO_SPHERE_RINGS_BASE = 7;
const HIPS_SPHERE_SEGMENTS_BASE = 6;
const HIPS_SPHERE_RINGS_BASE = 5;
const SHOULDER_SPHERE_SEGMENTS_BASE = 6;
const SHOULDER_SPHERE_RINGS_BASE = 5;
const HEAD_SPHERE_SEGMENTS_BASE = 9;
const HEAD_SPHERE_RINGS_BASE = 7;
const BROW_SPHERE_SEGMENTS_BASE = 5;
const BROW_SPHERE_RINGS_BASE = 4;
const MUZZLE_SPHERE_SEGMENTS_BASE = 6;
const MUZZLE_SPHERE_RINGS_BASE = 5;
const EYE_SPHERE_SEGMENTS_BASE = 4;
const EYE_SPHERE_RINGS_BASE = 3;
const FOOT_SPHERE_SEGMENTS_BASE = 6;
const FOOT_SPHERE_RINGS_BASE = 4;
const HAND_SPHERE_SEGMENTS_BASE = 5;
const HAND_SPHERE_RINGS_BASE = 4;
/** Limbs: along the sweep, and around it. Sixteen sides to a leg, not eight. */
const LIMB_PATH_SEGMENTS_BASE = 5;
const LIMB_RADIAL_SEGMENTS_BASE = 4;
/**
 * Ruff tufts: shorter, so fewer rings along them — the path count is unchanged
 * because a tuft's length is a straight taper and rings along it buy nothing.
 * Its SILHOUETTE is the ring around it, so that is where the segments go.
 */
const TUFT_PATH_SEGMENTS_BASE = 2;
const TUFT_RADIAL_SEGMENTS_BASE = 3;

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
/** Bare skin: muzzle and hands. A shallower carve — hide, not fur. */
const YETI_BARE_SKIN = yetiSkin(YETI_SKIN_WRINKLE_DEPTH);
/**
 * Parts that must keep their exact shape: the swept limbs, the ruff tufts and —
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
  const ruffMaterial = lambert(YETI_RUFF_COLOR);
  const skinMaterial = lambert(YETI_SKIN_COLOR);
  /** Lit-but-emissive, and unshaded: an eye is not skin. See cthulhu.ts. */
  const eyeMaterial = lambert(YETI_EYE_COLOR, {
    emissive: YETI_EYE_EMISSIVE,
    shaded: false,
  });

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

  // Head and brow together: the ridge is part of the skull, not a hat on it.
  // Separate from the body so the head can turn — the seam costs one draw call
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
    ],
    YETI_FUR_SKIN,
  );

  const muzzleGeometry = organicSurface(
    [
      ellipsoid(
        YETI_MUZZLE_LENGTH,
        YETI_MUZZLE_RISE,
        YETI_MUZZLE_WIDTH,
        segments(MUZZLE_SPHERE_SEGMENTS_BASE),
        segments(MUZZLE_SPHERE_RINGS_BASE),
        new Vector3(YETI_MUZZLE_FORWARD, YETI_MUZZLE_HEIGHT, 0),
      ),
    ],
    YETI_BARE_SKIN,
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

  // ── Ruff ───────────────────────────────────────────────────────────────────

  /**
   * The collar, as ONE geometry: every tuft is static in rig space and they all
   * share a material, so merging them costs nothing and saves six draw calls.
   *
   * Each tuft's length is a deterministic sample of the noise field at its index
   * — the same trick the kraken's crown uses, so every client grows the same
   * ruff — and it only ever SHORTENS (see YETI_RUFF_LENGTH_VARIATION), which is
   * what keeps YETI_RUFF_REACH a real bound.
   */
  function buildRuff(): ReturnType<typeof organicSurface> {
    const tufts = [];
    for (let index = 0; index < YETI_RUFF_TUFT_COUNT; index++) {
      // organicNoise is in [-1, 1]; this maps it to [0, 1] so the scale below is
      // in [1 - variation, 1] and a tuft can only ever be shorter.
      const wobble = 0.5 + 0.5 * organicNoise(index, 0, 0, NOISE_CHANNEL_TENTACLE);
      const scale = 1 - wobble * YETI_RUFF_LENGTH_VARIATION;

      // Tuft 0 lies on the centre line ahead of him; the rest divide the circle.
      const angle = (index / YETI_RUFF_TUFT_COUNT) * TWO_PI;
      const outX = Math.cos(angle);
      const outZ = Math.sin(angle);
      const at = (reach: number, height: number): Vector3 => {
        const radius = YETI_RUFF_RING_RADIUS + reach * scale;
        return new Vector3(radius * outX, YETI_RUFF_RING_HEIGHT - height * scale, radius * outZ);
      };

      const curve = new CatmullRomCurve3([
        at(0, 0),
        at(YETI_RUFF_TUFT_MID_REACH, YETI_RUFF_TUFT_MID_DROP),
        at(YETI_RUFF_TUFT_REACH, YETI_RUFF_TUFT_DROP),
      ]);
      tufts.push(
        taperedTube(
          curve,
          (along) =>
            YETI_RUFF_TUFT_RADIUS +
            (YETI_RUFF_TUFT_TIP_RADIUS - YETI_RUFF_TUFT_RADIUS) * along,
          segments(TUFT_PATH_SEGMENTS_BASE),
          segments(TUFT_RADIAL_SEGMENTS_BASE),
        ),
      );
    }
    return organicSurface(tufts, YETI_SMOOTH_SKIN);
  }

  const ruffGeometry = buildRuff();

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
  const footGeometry = organicSurface(
    [
      ellipsoid(
        YETI_FOOT_LENGTH,
        YETI_FOOT_RISE,
        YETI_FOOT_WIDTH,
        segments(FOOT_SPHERE_SEGMENTS_BASE),
        segments(FOOT_SPHERE_RINGS_BASE),
        new Vector3(YETI_FOOT_FORWARD, YETI_FOOT_CENTER_HEIGHT - YETI_ANKLE_HEIGHT, 0),
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

  const handGeometry = organicSurface(
    [
      ellipsoid(
        YETI_HAND_RADIUS * 2,
        YETI_HAND_RADIUS * 2,
        YETI_HAND_RADIUS * 2,
        segments(HAND_SPHERE_SEGMENTS_BASE),
        segments(HAND_SPHERE_RINGS_BASE),
      ),
    ],
    YETI_BARE_SKIN,
  );

  // ── Assembly ───────────────────────────────────────────────────────────────

  return function createYeti(): MonsterModel {
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
    upper.add(new Mesh(ruffGeometry, ruffMaterial));

    const head = new Group();
    head.add(new Mesh(headGeometry, furMaterial));
    head.add(new Mesh(muzzleGeometry, skinMaterial));
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

    return {
      root,
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
