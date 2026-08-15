// The kraken, built procedurally: a finned mantle rearing out of a squat head,
// ringed by ten swept limbs that arch over the water and fall away under it.
//
// Same rules and same tools as the Cthulhu builder (./geometry.ts): no textures,
// no per-model lights, no Math.random anywhere in the geometry, shared resources
// freed exactly once. ./kraken-anatomy.ts owns every number. This file owns the
// CREATURE — which masses there are, how the ring is rigged, and how it moves.
//
// FRAME. The mantle, fins, head and eyes are authored directly in rig space, so
// those meshes all sit at the rig's origin and one continuous noise field runs
// across the whole animal. The LIMBS are the exception, exactly as Cthulhu's
// tentacles are: each hangs off a joint, so its geometry is authored in that
// joint's space (root at the joint's origin, reaching along +X).
//
// THE RIG, top to bottom:
//
//   root      — placed and yawed by index.ts; never touched by animate()
//    └ rig    — the pulse rides here, so it cannot fight the placement maths
//       ├ mantle, fins, head, eyes, haloes   (static, rig space)
//       └ limb k: bearing (rotation.y = ring angle)
//                  └ joint (at the limb's root; rotation.z is the wave)
//                       └ the swept limb, and a tentacle's club
//
// COST at MONSTER_MODEL_DETAIL = 4: ~7 700 triangles — a third of Cthulhu's,
// because this animal is ten smooth tubes and four masses where he is a face, a
// tentacle fan and two ribbed membranes. Both are hero models and there is only
// ever one in a world.

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
  KRAKEN_ARM_COUNT,
  KRAKEN_ARM_COLOR,
  KRAKEN_ARM_CREST_HEIGHT,
  KRAKEN_ARM_CREST_REACH,
  KRAKEN_ARM_DRIFT,
  KRAKEN_ARM_LENGTH_VARIATION,
  KRAKEN_ARM_PHASE_STEP,
  KRAKEN_ARM_RADIUS,
  KRAKEN_ARM_ROOT_HEIGHT,
  KRAKEN_ARM_ROOT_REACH,
  KRAKEN_ARM_TAPER_EXPONENT,
  KRAKEN_ARM_TIP_HEIGHT,
  KRAKEN_ARM_TIP_RADIUS,
  KRAKEN_ARM_TIP_REACH,
  KRAKEN_ARM_WAVE_HZ,
  KRAKEN_ARM_WAVE_RADIANS,
  KRAKEN_CLUB_AT,
  KRAKEN_CLUB_COLOR,
  KRAKEN_CLUB_LENGTH,
  KRAKEN_CLUB_RISE,
  KRAKEN_CLUB_WIDTH,
  KRAKEN_EYE_BULGE,
  KRAKEN_EYE_COLOR,
  KRAKEN_EYE_EMISSIVE,
  KRAKEN_EYE_FORWARD,
  KRAKEN_EYE_HALO_OPACITY,
  KRAKEN_EYE_HALO_SCALE,
  KRAKEN_EYE_HEIGHT,
  KRAKEN_EYE_OFFSET,
  KRAKEN_EYE_RADIUS,
  KRAKEN_FIN_BACKSET,
  KRAKEN_FIN_CENTER_HEIGHT,
  KRAKEN_FIN_COLOR,
  KRAKEN_FIN_LENGTH,
  KRAKEN_FIN_RISE,
  KRAKEN_FIN_SPAN,
  KRAKEN_HEAD_CENTER_HEIGHT,
  KRAKEN_HEAD_COLOR,
  KRAKEN_HEAD_HEIGHT,
  KRAKEN_HEAD_LENGTH,
  KRAKEN_HEAD_WIDTH,
  KRAKEN_HEAD_WRINKLE_DEPTH,
  KRAKEN_LIMB_COUNT,
  KRAKEN_LIMB_STEP_RADIANS,
  KRAKEN_MANTLE_BASE_HEIGHT,
  KRAKEN_MANTLE_BASE_RADIUS,
  KRAKEN_MANTLE_COLOR,
  KRAKEN_MANTLE_HEIGHT,
  KRAKEN_MANTLE_RADIUS,
  KRAKEN_MANTLE_RAKE_RADIANS,
  KRAKEN_MANTLE_SHOULDER,
  KRAKEN_MANTLE_TAPER_EXPONENT,
  KRAKEN_MANTLE_TIP_RADIUS,
  KRAKEN_MANTLE_WRINKLE_DEPTH,
  KRAKEN_PULSE_HZ,
  KRAKEN_PULSE_RISE,
  KRAKEN_PULSE_SWELL,
  KRAKEN_SHADE_FREQUENCY,
  KRAKEN_SHADE_VARIATION,
  KRAKEN_TENTACLE_COUNT,
  KRAKEN_TENTACLE_CREST_HEIGHT,
  KRAKEN_TENTACLE_CREST_REACH,
  KRAKEN_TENTACLE_RADIUS,
  KRAKEN_TENTACLE_TIP_HEIGHT,
  KRAKEN_TENTACLE_TIP_RADIUS,
  KRAKEN_TENTACLE_TIP_REACH,
  KRAKEN_WRINKLE_FREQUENCY,
} from './kraken-anatomy.ts';

/** Base tessellations, in segments at detail 1. Multiplied by the knob. */
const HEAD_SPHERE_SEGMENTS_BASE = 9;
const HEAD_SPHERE_RINGS_BASE = 5;
const FIN_SPHERE_SEGMENTS_BASE = 4;
const FIN_SPHERE_RINGS_BASE = 3;
const EYE_SPHERE_SEGMENTS_BASE = 4;
const EYE_SPHERE_RINGS_BASE = 3;
const CLUB_SPHERE_SEGMENTS_BASE = 3;
const CLUB_SPHERE_RINGS_BASE = 2;
/** The mantle: along the sweep, and around it. It is the mass you see first. */
const MANTLE_PATH_SEGMENTS_BASE = 6;
const MANTLE_RADIAL_SEGMENTS_BASE = 3;
/** Limbs: along the sweep, and around it. */
const LIMB_PATH_SEGMENTS_BASE = 5;
const LIMB_RADIAL_SEGMENTS_BASE = 2;

/**
 * Control points sampled along the mantle's axis. Three is the fewest that can
 * express a lean that grows with height (base, middle, tip) rather than a
 * straight tilt; more would be sampling a curve that has no more shape in it.
 */
const MANTLE_AXIS_POINTS = 3;
/**
 * How much of the tip's total rake the mantle has taken up by its midpoint.
 *
 * 0.6 rather than 0.5, which is what makes the lean a CURVE: the mantle leaves
 * the head almost upright, bends back through the middle, and finishes with its
 * tip trailing furthest. A straight rake reads as a leaning cone.
 */
const MANTLE_MID_RAKE_FRACTION = 0.6;

/** This creature's skin, at a given carve depth. See cthulhu.ts for the shape. */
function krakenSkin(wrinkleDepth: number): SkinFinish {
  return {
    wrinkleDepth,
    wrinkleFrequency: KRAKEN_WRINKLE_FREQUENCY,
    shadeVariation: KRAKEN_SHADE_VARIATION,
    shadeFrequency: KRAKEN_SHADE_FREQUENCY,
  };
}

/** Parts that must keep their exact shape: the swept limbs and the clubs. */
const KRAKEN_SMOOTH_SKIN = krakenSkin(0);

/** One limb's shape. Arms and tentacles differ only in these numbers. */
interface LimbShape {
  readonly crestReach: number;
  readonly crestHeight: number;
  readonly tipReach: number;
  readonly tipHeight: number;
  readonly rootRadius: number;
  readonly tipRadius: number;
  /** True for the two tentacles: they carry a club near the tip. */
  readonly clubbed: boolean;
}

const ARM_SHAPE: LimbShape = {
  crestReach: KRAKEN_ARM_CREST_REACH,
  crestHeight: KRAKEN_ARM_CREST_HEIGHT,
  tipReach: KRAKEN_ARM_TIP_REACH,
  tipHeight: KRAKEN_ARM_TIP_HEIGHT,
  rootRadius: KRAKEN_ARM_RADIUS,
  tipRadius: KRAKEN_ARM_TIP_RADIUS,
  clubbed: false,
};

const TENTACLE_SHAPE: LimbShape = {
  crestReach: KRAKEN_TENTACLE_CREST_REACH,
  crestHeight: KRAKEN_TENTACLE_CREST_HEIGHT,
  tipReach: KRAKEN_TENTACLE_TIP_REACH,
  tipHeight: KRAKEN_TENTACLE_TIP_HEIGHT,
  rootRadius: KRAKEN_TENTACLE_RADIUS,
  tipRadius: KRAKEN_TENTACLE_TIP_RADIUS,
  clubbed: true,
};

/**
 * Which limb of the ring is a tentacle: the two either side of straight ahead.
 *
 * Ring index k sits at (k + ½) steps around from forward, so k = 0 is half a
 * step to one side and k = LIMB_COUNT - 1 is half a step to the other. Everything
 * else is an arm. Stated as a predicate rather than as two literals so the
 * counts in the anatomy stay the only place the ring's makeup is decided.
 */
function isTentacleIndex(index: number): boolean {
  const half = KRAKEN_TENTACLE_COUNT / 2;
  return index < half || index >= KRAKEN_LIMB_COUNT - half;
}

/**
 * Builds the shared kraken geometry and returns the per-instance constructor.
 *
 * Everything expensive happens ONCE, when the plugin attaches: the returned
 * function only assembles Meshes over geometries that already exist.
 */
export function createKrakenFactory(workshop: ModelWorkshop): () => MonsterModel {
  const { segments, keepGeometry, keepMaterial, lambert, organicSurface } = workshop;

  // ── Shared materials ───────────────────────────────────────────────────────

  const mantleMaterial = lambert(KRAKEN_MANTLE_COLOR);
  const finMaterial = lambert(KRAKEN_FIN_COLOR);
  const headMaterial = lambert(KRAKEN_HEAD_COLOR);
  const limbMaterial = lambert(KRAKEN_ARM_COLOR);
  const clubMaterial = lambert(KRAKEN_CLUB_COLOR);
  /** Lit-but-emissive, and unshaded: an eye is not skin. See cthulhu.ts. */
  const eyeMaterial = lambert(KRAKEN_EYE_COLOR, {
    emissive: KRAKEN_EYE_EMISSIVE,
    shaded: false,
  });
  /** The glow the lamps throw into the water: additive, and it writes no depth. */
  const haloMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: KRAKEN_EYE_EMISSIVE,
      transparent: true,
      opacity: KRAKEN_EYE_HALO_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );

  // ── Mantle ─────────────────────────────────────────────────────────────────

  /**
   * The mantle's axis: up from inside the head, leaning back as it climbs.
   *
   * X is negative going back (the model faces +X), and the rake is applied as a
   * horizontal offset per unit of rise rather than as a rotation of the tube, so
   * KRAKEN_MANTLE_TOP stays the exact height of the tip instead of its height
   * times a cosine.
   */
  function mantleAxis(): CatmullRomCurve3 {
    const totalRake = Math.tan(KRAKEN_MANTLE_RAKE_RADIANS) * KRAKEN_MANTLE_HEIGHT;
    const points: Vector3[] = [];
    for (let step = 0; step < MANTLE_AXIS_POINTS; step++) {
      const along = step / (MANTLE_AXIS_POINTS - 1);
      // Half way up the mantle has already taken MID_RAKE_FRACTION of the lean,
      // so the curve bends back rather than tilting.
      const rake = along === 0.5 ? totalRake * MANTLE_MID_RAKE_FRACTION : totalRake * along;
      points.push(new Vector3(-rake, KRAKEN_MANTLE_BASE_HEIGHT + KRAKEN_MANTLE_HEIGHT * along, 0));
    }
    return new CatmullRomCurve3(points);
  }

  /**
   * The mantle's radius profile: swelling from the collar to the shoulder, then
   * a long taper to the tip. Two segments, each stated as a lerp, so the widest
   * ring is exactly KRAKEN_MANTLE_RADIUS and exactly where the anatomy says.
   */
  function mantleRadiusAt(along: number): number {
    if (along <= KRAKEN_MANTLE_SHOULDER) {
      const swell = along / KRAKEN_MANTLE_SHOULDER;
      return KRAKEN_MANTLE_BASE_RADIUS + (KRAKEN_MANTLE_RADIUS - KRAKEN_MANTLE_BASE_RADIUS) * swell;
    }
    const taper = (along - KRAKEN_MANTLE_SHOULDER) / (1 - KRAKEN_MANTLE_SHOULDER);
    return (
      KRAKEN_MANTLE_RADIUS +
      (KRAKEN_MANTLE_TIP_RADIUS - KRAKEN_MANTLE_RADIUS) *
        Math.pow(taper, KRAKEN_MANTLE_TAPER_EXPONENT)
    );
  }

  const mantleGeometry = organicSurface(
    [
      taperedTube(
        mantleAxis(),
        mantleRadiusAt,
        segments(MANTLE_PATH_SEGMENTS_BASE),
        segments(MANTLE_RADIAL_SEGMENTS_BASE),
      ),
    ],
    krakenSkin(KRAKEN_MANTLE_WRINKLE_DEPTH),
  );

  // Both blades in one geometry: same material, same mass, one draw call. Each
  // spans from the axis outward, so its inner half is buried in the mantle
  // whatever the taper there is.
  const finGeometry = organicSurface(
    [1, -1].map((side) =>
      ellipsoid(
        KRAKEN_FIN_LENGTH,
        KRAKEN_FIN_RISE,
        KRAKEN_FIN_SPAN,
        segments(FIN_SPHERE_SEGMENTS_BASE),
        segments(FIN_SPHERE_RINGS_BASE),
        new Vector3(-KRAKEN_FIN_BACKSET, KRAKEN_FIN_CENTER_HEIGHT, (side * KRAKEN_FIN_SPAN) / 2),
      ),
    ),
    krakenSkin(KRAKEN_MANTLE_WRINKLE_DEPTH),
  );

  // ── Head and eyes ──────────────────────────────────────────────────────────

  const headHalfLength = KRAKEN_HEAD_LENGTH / 2;
  const headHalfHeight = KRAKEN_HEAD_HEIGHT / 2;
  const headHalfWidth = KRAKEN_HEAD_WIDTH / 2;
  const headCenter = new Vector3(0, KRAKEN_HEAD_CENTER_HEIGHT, 0);

  const headGeometry = organicSurface(
    [
      ellipsoid(
        KRAKEN_HEAD_LENGTH,
        KRAKEN_HEAD_HEIGHT,
        KRAKEN_HEAD_WIDTH,
        segments(HEAD_SPHERE_SEGMENTS_BASE),
        segments(HEAD_SPHERE_RINGS_BASE),
        headCenter,
      ),
    ],
    krakenSkin(KRAKEN_HEAD_WRINKLE_DEPTH),
  );

  /**
   * Where an eye sits: the point on the head's ellipsoid in the direction of the
   * anatomy's stated eye point, pushed out along the SURFACE NORMAL by its bulge
   * so the sphere breaks the skin instead of hiding under it.
   *
   * The normal of an ellipsoid at a point is that point divided by the squares
   * of its semi-axes — not the point itself, which is why an eye pushed along
   * the radius of a long head sinks into the cheek.
   */
  function eyePosition(side: number): Vector3 {
    const direction = new Vector3(
      (KRAKEN_EYE_FORWARD - headCenter.x) / headHalfLength,
      (KRAKEN_EYE_HEIGHT - headCenter.y) / headHalfHeight,
      (side * KRAKEN_EYE_OFFSET) / headHalfWidth,
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
    return surface.add(headCenter).addScaledVector(outward, KRAKEN_EYE_RADIUS * KRAKEN_EYE_BULGE);
  }

  const eyeGeometry = keepGeometry(
    new SphereGeometry(
      KRAKEN_EYE_RADIUS,
      segments(EYE_SPHERE_SEGMENTS_BASE),
      segments(EYE_SPHERE_RINGS_BASE),
    ),
  );

  // ── Limbs ──────────────────────────────────────────────────────────────────

  /** One limb's meshes, ready to be hung off a joint. */
  interface LimbGeometry {
    readonly limb: BufferGeometry;
    /** The club, or null for an arm. */
    readonly club: BufferGeometry | null;
    /** Where the club sits along the limb, in the limb's own joint space. */
    readonly clubAt: Vector3 | null;
  }

  /**
   * Builds limb `index` of the ring, in JOINT SPACE: the root is the origin and
   * the limb reaches along +X.
   *
   * The arc is three points — root, crest, tip — so the shape is exactly what
   * the anatomy claims: it leaves the head, rises to break the surface, and
   * falls away. The per-limb variation is a sample of the noise field at the
   * index, deterministic so every client grows the same crown, and it only ever
   * SHORTENS (see KRAKEN_ARM_LENGTH_VARIATION): every point is pulled back
   * toward the root, which can never push a tip outside the stated footprint.
   */
  function buildLimbGeometry(index: number, shape: LimbShape): LimbGeometry {
    // organicNoise is in [-1, 1]; this maps it to [0, 1] so the scale below is
    // in [1 - variation, 1] and the limb can only ever be shorter.
    const wobble = 0.5 + 0.5 * organicNoise(index, 0, 0, NOISE_CHANNEL_TENTACLE);
    const scale = 1 - wobble * KRAKEN_ARM_LENGTH_VARIATION;
    const drift = KRAKEN_ARM_DRIFT * organicNoise(0, index, 0, NOISE_CHANNEL_TENTACLE);

    const crest = new Vector3(
      (shape.crestReach - KRAKEN_ARM_ROOT_REACH) * scale,
      (shape.crestHeight - KRAKEN_ARM_ROOT_HEIGHT) * scale,
      drift,
    );
    const tip = new Vector3(
      (shape.tipReach - KRAKEN_ARM_ROOT_REACH) * scale,
      (shape.tipHeight - KRAKEN_ARM_ROOT_HEIGHT) * scale,
      0,
    );
    const curve = new CatmullRomCurve3([new Vector3(0, 0, 0), crest, tip]);

    const limb = taperedTube(
      curve,
      (along) =>
        shape.rootRadius +
        (shape.tipRadius - shape.rootRadius) * Math.pow(along, KRAKEN_ARM_TAPER_EXPONENT),
      segments(LIMB_PATH_SEGMENTS_BASE),
      segments(LIMB_RADIAL_SEGMENTS_BASE),
    );

    if (!shape.clubbed) {
      return { limb: organicSurface([limb], KRAKEN_SMOOTH_SKIN), club: null, clubAt: null };
    }

    // The club is its own mesh rather than merged into the limb: it is a
    // different colour, and it is the one part of a tentacle a player can see
    // move against the dark water.
    const club = ellipsoid(
      KRAKEN_CLUB_LENGTH,
      KRAKEN_CLUB_RISE,
      KRAKEN_CLUB_WIDTH,
      segments(CLUB_SPHERE_SEGMENTS_BASE),
      segments(CLUB_SPHERE_RINGS_BASE),
    );
    return {
      limb: organicSurface([limb], KRAKEN_SMOOTH_SKIN),
      club: organicSurface([club], KRAKEN_SMOOTH_SKIN),
      clubAt: curve.getPointAt(KRAKEN_CLUB_AT, new Vector3()),
    };
  }

  const limbGeometries: LimbGeometry[] = [];
  for (let index = 0; index < KRAKEN_LIMB_COUNT; index++) {
    limbGeometries.push(
      buildLimbGeometry(index, isTentacleIndex(index) ? TENTACLE_SHAPE : ARM_SHAPE),
    );
  }

  /** One limb's animated joint, kept so `animate` can drive the wave. */
  interface LimbRig {
    readonly joint: Group;
    /** Phase offset around the ring, radians — this is what makes it travel. */
    readonly phase: number;
  }

  /**
   * Rigs limb `index`: a bearing rotated to its place on the ring, carrying a
   * joint at the limb's root. Two nested Groups rather than one, so the wave can
   * swing the limb about its root without also swinging it around the ring.
   */
  function createLimb(index: number): { bearing: Group; rig: LimbRig } {
    const geometry = limbGeometries[index]!;
    const bearing = new Group();
    bearing.rotation.y = (index + 0.5) * KRAKEN_LIMB_STEP_RADIANS;

    const joint = new Group();
    joint.position.set(KRAKEN_ARM_ROOT_REACH, KRAKEN_ARM_ROOT_HEIGHT, 0);
    joint.add(new Mesh(geometry.limb, limbMaterial));
    if (geometry.club !== null && geometry.clubAt !== null) {
      const club = new Mesh(geometry.club, clubMaterial);
      club.position.copy(geometry.clubAt);
      joint.add(club);
    }
    bearing.add(joint);

    return { bearing, rig: { joint, phase: index * KRAKEN_ARM_PHASE_STEP } };
  }

  // ── Assembly ───────────────────────────────────────────────────────────────

  return function createKraken(): MonsterModel {
    const root = new Group();
    // The caller owns `root` (position + yaw); everything animated hangs off
    // `rig`, so the pulse cannot fight the placement maths.
    const rig = new Group();
    root.add(rig);

    // The mantle is its own Group so the pulse can swell it without scaling the
    // head, the eyes or the crown with it — a squid's mantle is the part that
    // moves water, and scaling the eyes would read as the whole animal
    // breathing in and out like a balloon.
    const mantle = new Group();
    mantle.add(new Mesh(mantleGeometry, mantleMaterial));
    mantle.add(new Mesh(finGeometry, finMaterial));
    rig.add(mantle);

    rig.add(new Mesh(headGeometry, headMaterial));

    for (const side of [1, -1]) {
      const position = eyePosition(side);
      const eye = new Mesh(eyeGeometry, eyeMaterial);
      eye.position.copy(position);
      rig.add(eye);

      const halo = new Mesh(eyeGeometry, haloMaterial);
      halo.position.copy(position);
      halo.scale.setScalar(KRAKEN_EYE_HALO_SCALE);
      rig.add(halo);
    }

    const limbs: LimbRig[] = [];
    for (let index = 0; index < KRAKEN_LIMB_COUNT; index++) {
      const limb = createLimb(index);
      limbs.push(limb.rig);
      rig.add(limb.bearing);
    }

    return {
      root,
      animate(seconds, phase) {
        // PULSE: the mantle swells and the whole animal rides with it. The two
        // are the same wave, so the rise reads as a consequence of the swell
        // rather than as a second animation happening at the same time.
        const pulse = Math.sin(seconds * KRAKEN_PULSE_HZ * TWO_PI + phase);
        rig.position.y = pulse * KRAKEN_PULSE_RISE;
        // Along the mantle's own axis only: swelling it in every direction would
        // fatten the fins with it, and a fin is a blade, not a bladder.
        mantle.scale.set(1 + pulse * KRAKEN_PULSE_SWELL, 1, 1 + pulse * KRAKEN_PULSE_SWELL);

        // THE WAVE: each limb leads the next by its phase step, so the crown
        // ripples around itself instead of flapping as one piece. One rotation
        // per limb and nothing else — the arc is baked into the swept geometry,
        // so nothing here re-curves a vertex.
        //
        // IT IS A YAW, AND THAT IS A FOOTPRINT DECISION rather than a taste one.
        // A limb's tip hangs about four cells BELOW its root, so swinging it in
        // the vertical plane would rotate that drop outward: at the wave's stated
        // amplitude an unshortened arm tip reaches 3.9 cells from the axis (3.55
        // on the built model, which shortens most limbs), past the 3.5 the server
        // steers by — the model would have put a limb through a cliff the
        // look-ahead probe called clear. Rotating about the model's own
        // vertical instead can only ever REDUCE a tip's distance from the axis
        // (the static pose is the aligned, and therefore maximal, case), so the
        // measured footprint stays true for every frame of the animation. It is
        // also the better motion: a crown that swirls reads as a swimming squid,
        // where one that flaps reads as a hand waving.
        for (const limb of limbs) {
          const wave = seconds * KRAKEN_ARM_WAVE_HZ * TWO_PI + phase + limb.phase;
          limb.joint.rotation.y = Math.sin(wave) * KRAKEN_ARM_WAVE_RADIANS;
        }
      },
    };
  };
}
