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
  KRAKEN_MANTLE_APEX_BACKSET,
  KRAKEN_MANTLE_APEX_HEIGHT,
  KRAKEN_MANTLE_COLOR,
  KRAKEN_MANTLE_RISE_BACKSET,
  KRAKEN_MANTLE_RISE_HEIGHT,
  KRAKEN_MANTLE_ROOT_BACKSET,
  KRAKEN_MANTLE_ROOT_HEIGHT,
  KRAKEN_MANTLE_TIP_BACKSET,
  KRAKEN_MANTLE_TIP_HEIGHT,
  KRAKEN_MANTLE_WRINKLE_DEPTH,
  krakenMantleRadiusAt,
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

const HEAD_SPHERE_SEGMENTS_BASE = 9;
const HEAD_SPHERE_RINGS_BASE = 5;
const FIN_SPHERE_SEGMENTS_BASE = 4;
const FIN_SPHERE_RINGS_BASE = 3;
const EYE_SPHERE_SEGMENTS_BASE = 4;
const EYE_SPHERE_RINGS_BASE = 3;
const CLUB_SPHERE_SEGMENTS_BASE = 3;
const CLUB_SPHERE_RINGS_BASE = 2;
const MANTLE_PATH_SEGMENTS_BASE = 6;
const MANTLE_RADIAL_SEGMENTS_BASE = 3;
const LIMB_PATH_SEGMENTS_BASE = 5;
const LIMB_RADIAL_SEGMENTS_BASE = 2;

function krakenSkin(wrinkleDepth: number): SkinFinish {
  return {
    wrinkleDepth,
    wrinkleFrequency: KRAKEN_WRINKLE_FREQUENCY,
    shadeVariation: KRAKEN_SHADE_VARIATION,
    shadeFrequency: KRAKEN_SHADE_FREQUENCY,
  };
}

const KRAKEN_SMOOTH_SKIN = krakenSkin(0);

interface LimbShape {
  readonly crestReach: number;
  readonly crestHeight: number;
  readonly tipReach: number;
  readonly tipHeight: number;
  readonly rootRadius: number;
  readonly tipRadius: number;
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

function isTentacleIndex(index: number): boolean {
  const half = KRAKEN_TENTACLE_COUNT / 2;
  return index < half || index >= KRAKEN_LIMB_COUNT - half;
}

export function createKrakenFactory(workshop: ModelWorkshop): () => MonsterModel {
  const { segments, keepGeometry, keepMaterial, lambert, organicSurface } = workshop;

  const mantleMaterial = lambert(KRAKEN_MANTLE_COLOR);
  const finMaterial = lambert(KRAKEN_FIN_COLOR);
  const headMaterial = lambert(KRAKEN_HEAD_COLOR);
  const limbMaterial = lambert(KRAKEN_ARM_COLOR);
  const clubMaterial = lambert(KRAKEN_CLUB_COLOR);
  const eyeMaterial = lambert(KRAKEN_EYE_COLOR, {
    emissive: KRAKEN_EYE_EMISSIVE,
    shaded: false,
  });
  const haloMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: KRAKEN_EYE_EMISSIVE,
      transparent: true,
      opacity: KRAKEN_EYE_HALO_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );

  function mantleAxis(): CatmullRomCurve3 {
    return new CatmullRomCurve3([
      new Vector3(-KRAKEN_MANTLE_ROOT_BACKSET, KRAKEN_MANTLE_ROOT_HEIGHT, 0),
      new Vector3(-KRAKEN_MANTLE_RISE_BACKSET, KRAKEN_MANTLE_RISE_HEIGHT, 0),
      new Vector3(-KRAKEN_MANTLE_APEX_BACKSET, KRAKEN_MANTLE_APEX_HEIGHT, 0),
      new Vector3(-KRAKEN_MANTLE_TIP_BACKSET, KRAKEN_MANTLE_TIP_HEIGHT, 0),
    ]);
  }

  const mantleGeometry = organicSurface(
    [
      taperedTube(
        mantleAxis(),
        krakenMantleRadiusAt,
        segments(MANTLE_PATH_SEGMENTS_BASE),
        segments(MANTLE_RADIAL_SEGMENTS_BASE),
      ),
    ],
    krakenSkin(KRAKEN_MANTLE_WRINKLE_DEPTH),
  );

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

  interface LimbGeometry {
    readonly limb: BufferGeometry;
    readonly club: BufferGeometry | null;
    readonly clubAt: Vector3 | null;
  }

  function buildLimbGeometry(index: number, shape: LimbShape): LimbGeometry {
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

  interface LimbRig {
    readonly joint: Group;
  }

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

    return { bearing, rig: { joint } };
  }

  const authored = (() => {
    const root = new Group();
    const rig = new Group();
    root.add(rig);

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

    const limbJoints: Group[] = [];
    for (let index = 0; index < KRAKEN_LIMB_COUNT; index++) {
      const limb = createLimb(index);
      limbJoints.push(limb.rig.joint);
      rig.add(limb.bearing);
    }

    return { root, rig, mantle, limbJoints };
  })();

  const blueprint = workshop.keepRig(bakeRig(authored.root));
  const rigJoint = blueprint.jointIndex(authored.rig);
  const mantleJoint = blueprint.jointIndex(authored.mantle);
  const limbJointIndices = authored.limbJoints.map((joint) => blueprint.jointIndex(joint));

  return function createKraken(): MonsterModel {
    const instance = instantiateRig(blueprint);
    const rig = instance.joints[rigJoint]!;
    const mantle = instance.joints[mantleJoint]!;
    const limbs = limbJointIndices.map((index, ordinal) => ({
      joint: instance.joints[index]!,
      phase: ordinal * KRAKEN_ARM_PHASE_STEP,
    }));

    return {
      root: instance.root,
      animate(seconds, phase) {
        const pulse = Math.sin(seconds * KRAKEN_PULSE_HZ * TWO_PI + phase);
        rig.position.y = pulse * KRAKEN_PULSE_RISE;
        mantle.scale.set(1, 1 + pulse * KRAKEN_PULSE_SWELL, 1 + pulse * KRAKEN_PULSE_SWELL);

        for (const limb of limbs) {
          const wave = seconds * KRAKEN_ARM_WAVE_HZ * TWO_PI + phase + limb.phase;
          limb.joint.rotation.y = Math.sin(wave) * KRAKEN_ARM_WAVE_RADIANS;
        }
      },
      dispose(): void {
        instance.dispose();
      },
    };
  };
}
