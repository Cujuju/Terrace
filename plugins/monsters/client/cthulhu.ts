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

const BODY_SPHERE_SEGMENTS_BASE = 7;
const BODY_SPHERE_RINGS_BASE = 4;
const HEAD_SPHERE_SEGMENTS_BASE = 12;
const HEAD_SPHERE_RINGS_BASE = 8;
const EYE_SPHERE_SEGMENTS_BASE = 4;
const EYE_SPHERE_RINGS_BASE = 3;
const TENTACLE_PATH_SEGMENTS_BASE = 6;
const TENTACLE_RADIAL_SEGMENTS_BASE = 2;
const KNUCKLE_SEGMENTS_BASE = 3;
const KNUCKLE_RINGS_BASE = 2;
const WING_RIB_PATH_SEGMENTS_BASE = 3;
const WING_RIB_RADIAL_SEGMENTS_BASE = 2;
const WING_PATCH_SPAN_SEGMENTS_BASE = 2;
const WING_PATCH_RIDGE_SEGMENTS_BASE = 3;

function cthulhuSkin(wrinkleDepth: number): SkinFinish {
  return {
    wrinkleDepth,
    wrinkleFrequency: CTHULHU_WRINKLE_FREQUENCY,
    shadeVariation: CTHULHU_SHADE_VARIATION,
    shadeFrequency: CTHULHU_SHADE_FREQUENCY,
  };
}

const CTHULHU_SMOOTH_SKIN = cthulhuSkin(0);

export function createCthulhuFactory(workshop: ModelWorkshop): () => MonsterModel {
  const { segments, keepGeometry, keepMaterial, lambert, organicSurface } = workshop;

  const bodyMaterial = lambert(CTHULHU_BODY_COLOR);
  const headMaterial = lambert(CTHULHU_HEAD_COLOR);
  const membraneMaterial = lambert(CTHULHU_WING_COLOR, { doubleSided: true });
  const ribMaterial = lambert(CTHULHU_WING_RIB_COLOR);
  const tentacleMaterial = lambert(CTHULHU_TENTACLE_COLOR);
  const eyeMaterial = lambert(CTHULHU_EYE_COLOR, {
    emissive: CTHULHU_EYE_EMISSIVE,
    shaded: false,
  });
  const haloMaterial = keepMaterial(
    new MeshBasicMaterial({
      color: CTHULHU_EYE_EMISSIVE,
      transparent: true,
      opacity: CTHULHU_EYE_HALO_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );

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

  const headHalfLength = CTHULHU_HEAD_LENGTH / 2;
  const headHalfHeight = CTHULHU_HEAD_HEIGHT / 2;
  const headHalfWidth = CTHULHU_HEAD_WIDTH / 2;
  const headCenter = new Vector3(CTHULHU_HEAD_FORWARD, CTHULHU_HEAD_CENTER_HEIGHT, 0);

  interface HeadSculpt {
    readonly vertical: number;
    readonly lateral: number;
  }

  function headSculpt(u: number, above: boolean): HeadSculpt {
    const front = Math.max(0, u);
    const muzzle = 1 - CTHULHU_HEAD_MUZZLE_TAPER * front * front;
    const brow = above ? 1 - CTHULHU_HEAD_BROW_SLOPE * front * front : 1;
    return { vertical: muzzle * brow, lateral: muzzle };
  }

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

  interface TentacleRig {
    readonly root: Group;
    readonly mid: Group;
    readonly restFan: number;
    readonly phase: number;
  }

  interface TentacleGeometry {
    readonly upper: BufferGeometry;
    readonly lower: BufferGeometry;
    readonly joint: Vector3;
  }

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

  function createTentacle(index: number): TentacleRig {
    const geometry = tentacleGeometries[index]!;
    const root = new Group();
    root.position.set(CTHULHU_TENTACLE_ROOT_FORWARD, CTHULHU_TENTACLE_ROOT_HEIGHT, 0);

    const gaps = Math.max(1, CTHULHU_FACE_TENTACLE_COUNT - 1);
    const spread = (index / gaps - 0.5) * CTHULHU_TENTACLE_FAN_RADIANS;
    root.rotation.set(spread, 0, CTHULHU_TENTACLE_PITCH_RADIANS);
    root.add(new Mesh(geometry.upper, tentacleMaterial));

    const mid = new Group();
    mid.position.copy(geometry.joint);
    mid.rotation.z = -CTHULHU_TENTACLE_BEND_RADIANS;
    mid.add(new Mesh(geometry.lower, tentacleMaterial));
    root.add(mid);

    return { root, mid, restFan: spread, phase: index * CTHULHU_TENTACLE_PHASE_STEP };
  }

  interface WingSkeleton {
    readonly ridges: readonly CatmullRomCurve3[];
    readonly bones: readonly (((along: number) => number) | null)[];
    readonly wrist: Vector3;
    readonly sagDirection: Vector3;
  }

  function wingSkeleton(side: number): WingSkeleton {
    const backPerRise = Math.tan(CTHULHU_WING_RAKE_RADIANS);
    const outPerRise = Math.tan(CTHULHU_WING_LEAN_RADIANS);

    function wingPoint(rise: number, back: number, out: number): Vector3 {
      return new Vector3(
        -CTHULHU_WING_BACKSET - back,
        CTHULHU_WING_HEIGHT + rise,
        side * (CTHULHU_WING_OFFSET + out),
      );
    }

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

    return {
      membrane: organicSurface(panels, CTHULHU_SMOOTH_SKIN),
      ribs: organicSurface(bones, CTHULHU_SMOOTH_SKIN),
    };
  }

  const wingGeometries = [buildWingGeometry(1), buildWingGeometry(-1)];

  const authored = (() => {
    const root = new Group();
    const rig = new Group();
    root.add(rig);

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
        const breath = Math.sin(seconds * CTHULHU_BREATH_HZ * TWO_PI + phase);
        rig.position.y = breath * CTHULHU_BREATH_RISE;
        rig.rotation.z = breath * CTHULHU_BREATH_ROLL_RADIANS;

        for (const tentacle of tentacles) {
          const wave = seconds * CTHULHU_TENTACLE_SWAY_HZ * TWO_PI + phase + tentacle.phase;
          tentacle.root.rotation.x =
            tentacle.restFan + Math.sin(wave) * CTHULHU_TENTACLE_SWAY_RADIANS;
          tentacle.mid.rotation.z =
            -CTHULHU_TENTACLE_BEND_RADIANS +
            Math.sin(wave - 1) * CTHULHU_TENTACLE_SWAY_RADIANS * 0.6;
        }
      },
      dispose(): void {
        instance.dispose();
      },
    };
  };
}
