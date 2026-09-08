import { YETI_VARIANTS, type YetiVariant } from '../protocol.ts';

export const PEEP_HEIGHT_WORLD_UNITS = 0.527;

export const YETI_HEIGHT_IN_PEEPS = 2;

export const YETI_TOTAL_HEIGHT = PEEP_HEIGHT_WORLD_UNITS * YETI_HEIGHT_IN_PEEPS;

export interface YetiPoint {
  readonly forward: number;
  readonly height: number;
  readonly lateral: number;
}

export type YetiJoint = 'upper' | 'head' | 'leg' | 'ankle' | 'arm';

export type YetiSurface =
  | 'coat'
  | 'saddle'
  | 'hide'
  | 'face'
  | 'nose'
  | 'maw'
  | 'eye'
  | 'glint'
  | 'horn'
  | 'ivory';

export type YetiPartSize =
  | 'trunk'
  | 'head'
  | 'feature'
  | 'limb'
  | 'joint'
  | 'digit'
  | 'horn';

export interface YetiShells {
  readonly length: number;
  readonly layers: number;
}

interface YetiPartCommon {
  readonly joint: YetiJoint;
  readonly side: number;
  readonly surface: YetiSurface;
  readonly size: YetiPartSize;
  readonly shells: YetiShells | null;
}

export interface YetiMassPart extends YetiPartCommon {
  readonly kind: 'mass';
  readonly center: YetiPoint;
  readonly radii: YetiPoint;
  readonly tilt: number;
}

export interface YetiLimbPart extends YetiPartCommon {
  readonly kind: 'limb';
  readonly from: YetiPoint;
  readonly to: YetiPoint;
  readonly rootRadius: number;
  readonly tipRadius: number;
}

export interface YetiSweepPart extends YetiPartCommon {
  readonly kind: 'sweep';
  readonly path: readonly YetiPoint[];
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly taperPower: number;
}

export type YetiPart = YetiMassPart | YetiLimbPart | YetiSweepPart;

export interface YetiJointRest {
  readonly leg: YetiPoint;
  readonly ankle: YetiPoint;
  readonly arm: YetiPoint;
}

export interface YetiBody {
  readonly parts: readonly YetiPart[];
  readonly joints: YetiJointRest;
}

export interface YetiSkull {
  readonly forward: number;
  readonly height: number;
  readonly lateral: number;
}

export interface YetiArmSpec {
  readonly upper: number;
  readonly fore: number;
  readonly upperForward: number;
  readonly foreForward: number;
  readonly elbowFlare: number;
  readonly wristFlare: number;
  readonly shoulderRadius: number;
  readonly elbowRadius: number;
  readonly wristRadius: number;
}

export interface YetiLegSpec {
  readonly thigh: number;
  readonly shin: number;
  readonly thighForward: number;
  readonly shinForward: number;
  readonly kneeFlare: number;
  readonly hipRadius: number;
  readonly kneeRadius: number;
  readonly ankleRadius: number;
  readonly footLength: number;
  readonly footWidth: number;
  readonly footHeight: number;
}

export type YetiHornStyle = 'none' | 'ram' | 'ibex' | 'stub';

export interface YetiVariantSpec {
  readonly coat: number;
  readonly underTint: number;
  readonly skin: number;
  readonly faceColor: number;
  readonly saddle: number;
  readonly shag: number;
  readonly coatLength: number;
  readonly shellLayers: number;

  readonly hipHeight: number;
  readonly shoulderHeight: number;
  readonly hunch: number;
  readonly hipRadii: YetiPoint;
  readonly bellyRadii: YetiPoint;
  readonly bellyOut: number;
  readonly chestRadii: YetiPoint;
  readonly chestOut: number;
  readonly shoulderHalfSpan: number;
  readonly shoulderRadius: number;

  readonly neckLength: number;
  readonly neckRadius: number;
  readonly headDrop: number;
  readonly headForward: number;
  readonly skull: YetiSkull;
  readonly crest: number;
  readonly faceWidth: number;
  readonly muzzleOut: number;
  readonly muzzleFur: boolean;
  readonly fangs: number;
  readonly horns: YetiHornStyle;

  readonly arm: YetiArmSpec;
  readonly leg: YetiLegSpec;
  readonly stanceHalfWidth: number;
  readonly fingers: number;
  readonly knuckle: boolean;
}

const BASE_SPEC: YetiVariantSpec = {
  coat: 0xdcdfdc,
  underTint: 0x6a7480,
  skin: 0x3a3339,
  faceColor: 0x45393c,
  saddle: 0,
  shag: 1,
  coatLength: 0.09,
  shellLayers: 3,

  hipHeight: 0.86,
  shoulderHeight: 1.62,
  hunch: 0.22,
  hipRadii: { forward: 0.3, height: 0.24, lateral: 0.36 },
  bellyRadii: { forward: 0.34, height: 0.42, lateral: 0.4 },
  bellyOut: 0.04,
  chestRadii: { forward: 0.4, height: 0.4, lateral: 0.5 },
  chestOut: 0.02,
  shoulderHalfSpan: 0.46,
  shoulderRadius: 0.22,

  neckLength: 0.12,
  neckRadius: 0.18,
  headDrop: 0.35,
  headForward: 0.06,
  skull: { forward: 0.28, height: 0.3, lateral: 0.26 },
  crest: 0,
  faceWidth: 0.62,
  muzzleOut: 0.35,
  muzzleFur: false,
  fangs: 0,
  horns: 'none',

  arm: {
    upper: 0.62,
    fore: 0.62,
    upperForward: 0.22,
    foreForward: 0.02,
    elbowFlare: 0.08,
    wristFlare: 0.04,
    shoulderRadius: 0.16,
    elbowRadius: 0.13,
    wristRadius: 0.11,
  },
  leg: {
    thigh: 0.42,
    shin: 0.36,
    thighForward: 0.12,
    shinForward: 0.08,
    kneeFlare: 0.02,
    hipRadius: 0.17,
    kneeRadius: 0.13,
    ankleRadius: 0.11,
    footLength: 0.42,
    footWidth: 0.15,
    footHeight: 0.09,
  },
  stanceHalfWidth: 0.24,
  fingers: 4,
  knuckle: false,
};

export const YETI_VARIANT_SPECS: Readonly<Record<YetiVariant, YetiVariantSpec>> = {
  silverback: {
    ...BASE_SPEC,
    coat: 0x5c6068,
    underTint: 0x1e2024,
    skin: 0x26232a,
    faceColor: 0x2c2830,
    saddle: 0xd9dde0,
    shag: 0.89,
    coatLength: 0.07,
    hunch: 0.52,
    headDrop: 0.55,
    hipHeight: 0.8,
    shoulderHeight: 1.5,
    chestRadii: { forward: 0.46, height: 0.4, lateral: 0.58 },
    shoulderHalfSpan: 0.52,
    shoulderRadius: 0.26,
    skull: { forward: 0.27, height: 0.27, lateral: 0.24 },
    crest: 0.55,
    knuckle: true,
    arm: {
      ...BASE_SPEC.arm,
      upper: 0.7,
      fore: 0.7,
      upperForward: 0.15,
      foreForward: 0.35,
      shoulderRadius: 0.19,
      elbowRadius: 0.16,
      wristRadius: 0.13,
    },
    leg: { ...BASE_SPEC.leg, thigh: 0.38, shin: 0.32, hipRadius: 0.19 },
    stanceHalfWidth: 0.27,
  },
  ram: {
    ...BASE_SPEC,
    coat: 0xdcdfdc,
    underTint: 0x6a7480,
    skin: 0x3a3339,
    faceColor: 0x45393c,
    shag: 1.11,
    coatLength: 0.1,
    horns: 'ram',
    fangs: 0.06,
    muzzleFur: true,
    skull: { forward: 0.29, height: 0.3, lateral: 0.27 },
  },
  ibex: {
    ...BASE_SPEC,
    coat: 0xe2e1da,
    underTint: 0x7a7266,
    skin: 0x2b2628,
    faceColor: 0x342c2e,
    shag: 0.78,
    coatLength: 0.07,
    horns: 'ibex',
    hunch: 0.1,
    headDrop: 0.15,
    hipHeight: 0.8,
    shoulderHeight: 1.5,
    chestRadii: { forward: 0.34, height: 0.4, lateral: 0.42 },
    bellyRadii: { forward: 0.28, height: 0.42, lateral: 0.34 },
    shoulderHalfSpan: 0.4,
    shoulderRadius: 0.18,
    skull: { forward: 0.26, height: 0.28, lateral: 0.22 },
    neckLength: 0.18,
    arm: {
      ...BASE_SPEC.arm,
      upper: 0.56,
      fore: 0.56,
      shoulderRadius: 0.13,
      elbowRadius: 0.11,
      wristRadius: 0.09,
    },
    leg: {
      ...BASE_SPEC.leg,
      thigh: 0.4,
      shin: 0.36,
      hipRadius: 0.14,
      kneeRadius: 0.11,
      ankleRadius: 0.09,
      footWidth: 0.13,
    },
  },
  fanged: {
    ...BASE_SPEC,
    coat: 0xe6e2d6,
    underTint: 0x8a7b66,
    skin: 0x3b3236,
    faceColor: 0x4b3d40,
    shag: 1.11,
    coatLength: 0.1,
    faceWidth: 0.7,
    muzzleFur: true,
    fangs: 0.11,
    horns: 'stub',
    skull: { forward: 0.3, height: 0.3, lateral: 0.3 },
    muzzleOut: 0.4,
    hunch: 0.26,
  },
};

export const YETI_MAW_COLOR = 0x241416;
export const YETI_NOSE_COLOR = 0x1c1a1c;
export const YETI_EYE_COLOR = 0x0c0e12;
export const YETI_GLINT_COLOR = 0xcfe6f5;
export const YETI_EYE_EMISSIVE = 0x16283a;
export const YETI_IVORY_COLOR = 0xf2ead8;
export const YETI_HORN_COLOR = 0x6b5c4b;
export const YETI_IBEX_HORN_COLOR = 0x54473a;
export const YETI_STUB_HORN_COLOR = 0x3c332c;

const FUR_WRINKLE_DEPTH_OF_HEIGHT = 0.01744;
const SKIN_WRINKLE_DEPTH_OF_HEIGHT = 0.00581;
const WRINKLE_CYCLES_PER_HEIGHT = 17.888;
const SHADE_CYCLES_PER_HEIGHT = 6.192;
const FUR_TILES_PER_HEIGHT = 6.88;

export const YETI_FUR_WRINKLE_DEPTH = FUR_WRINKLE_DEPTH_OF_HEIGHT * YETI_TOTAL_HEIGHT;
export const YETI_SKIN_WRINKLE_DEPTH = SKIN_WRINKLE_DEPTH_OF_HEIGHT * YETI_TOTAL_HEIGHT;
export const YETI_WRINKLE_FREQUENCY = WRINKLE_CYCLES_PER_HEIGHT / YETI_TOTAL_HEIGHT;
export const YETI_SHADE_FREQUENCY = SHADE_CYCLES_PER_HEIGHT / YETI_TOTAL_HEIGHT;
export const YETI_FUR_TEXTURE_FREQUENCY = FUR_TILES_PER_HEIGHT / YETI_TOTAL_HEIGHT;
export const YETI_SHADE_VARIATION = 0.22;
export const YETI_SHELL_STRAND_FACTOR = 3;

export const YETI_SHELL_UNDERTINT_STRENGTH = 0.35;

const HORN_ROOT_IN_SKULL = 0.26;
const IBEX_HORN_ROOT_IN_SKULL = 0.22;
const STUB_HORN_ROOT_IN_SKULL = 0.2;
const HORN_TIP_RADIUS = 0.012;
const IBEX_HORN_TIP_RADIUS = 0.01;

function point(forward: number, height: number, lateral: number): YetiPoint {
  return { forward, height, lateral };
}

function ramHornPath(skull: YetiSkull, side: number): readonly YetiPoint[] {
  const curl = skull.lateral;
  const lateral0 = side * skull.lateral * 0.5;
  const height0 = skull.height * 0.55;
  const forward0 = -skull.forward * 0.1;
  return [
    point(forward0, height0 - 0.02 * curl, lateral0),
    point(forward0 - 0.33 * curl, height0 + 0.33 * curl, lateral0 + side * 0.19 * curl),
    point(forward0 - 0.7 * curl, height0 + 0.15 * curl, lateral0 + side * 0.52 * curl),
    point(forward0 - 0.52 * curl, height0 - 0.37 * curl, lateral0 + side * 0.74 * curl),
    point(forward0 + 0.07 * curl, height0 - 0.56 * curl, lateral0 + side * 0.74 * curl),
    point(forward0 + 0.44 * curl, height0 - 0.3 * curl, lateral0 + side * 0.81 * curl),
  ];
}

function ibexHornPath(skull: YetiSkull, side: number): readonly YetiPoint[] {
  const lateral0 = side * skull.lateral * 0.4;
  const height0 = skull.height * 0.7;
  const forward0 = -skull.forward * 0.05;
  return [
    point(forward0, height0 - 0.04, lateral0),
    point(forward0 - 0.12, height0 + 0.25, lateral0 + side * 0.05),
    point(forward0 - 0.35, height0 + 0.5, lateral0 + side * 0.12),
    point(forward0 - 0.6, height0 + 0.62, lateral0 + side * 0.2),
  ];
}

function stubHornPath(skull: YetiSkull, side: number): readonly YetiPoint[] {
  const lateral0 = side * skull.lateral * 0.5;
  const height0 = skull.height * 0.62;
  return [
    point(0, height0 - 0.04, lateral0),
    point(-0.04, height0 + 0.14, lateral0 + side * 0.06),
    point(-0.1, height0 + 0.24, lateral0 + side * 0.12),
  ];
}

function hornFinish(style: YetiHornStyle): { color: number; rootInSkull: number; tip: number } {
  if (style === 'ibex') {
    return { color: YETI_IBEX_HORN_COLOR, rootInSkull: IBEX_HORN_ROOT_IN_SKULL, tip: IBEX_HORN_TIP_RADIUS };
  }
  if (style === 'stub') {
    return { color: YETI_STUB_HORN_COLOR, rootInSkull: STUB_HORN_ROOT_IN_SKULL, tip: HORN_TIP_RADIUS };
  }
  return { color: YETI_HORN_COLOR, rootInSkull: HORN_ROOT_IN_SKULL, tip: HORN_TIP_RADIUS };
}

export function yetiHornColor(style: YetiHornStyle): number {
  return hornFinish(style).color;
}

const SIDES = [1, -1] as const;

const BROW_HEIGHT_IN_SKULL = 0.25;
const BROW_FORWARD_IN_SKULL = 0.72;
const BROW_RADII_IN_SKULL = { forward: 0.3, height: 0.22, lateral: 0.85 };
const FACE_PLATE_FORWARD_IN_SKULL = 0.8;
const FACE_PLATE_HEIGHT_IN_SKULL = -0.12;
const FACE_PLATE_DEPTH_IN_SKULL = 0.28;
const FACE_PLATE_HEIGHT_RADIUS_IN_SKULL = 0.62;
const MUZZLE_HEIGHT_IN_SKULL = -0.28;
const MUZZLE_RADII_IN_SKULL = { forward: 0.42, height: 0.36, lateral: 0.5 };
const NOSE_RADII_IN_SKULL = { forward: 0.13, height: 0.14, lateral: 0.26 };
const MOUTH_RADII_IN_SKULL = { forward: 0.16, height: 0.045, lateral: 0.36 };
const JAW_RADII_IN_SKULL = { forward: 0.36, height: 0.24, lateral: 0.42 };
const EYE_RADII_IN_SKULL = { forward: 0.1, height: 0.11, lateral: 0.12 };
const EYE_LATERAL_IN_SKULL = 0.34;
const EYE_HEIGHT_IN_SKULL = 0.06;
const GLINT_RADIUS_IN_SKULL = 0.028;
const GLINT_HEIGHT_IN_SKULL = 0.13;
const GLINT_LATERAL_IN_SKULL = 0.38;
const EYE_FORWARD_IN_SKULL = 0.24;
const GLINT_FORWARD_IN_SKULL = 0.32;
const CREST_HEIGHT_IN_SKULL = 0.7;
const CREST_RADII_IN_SKULL = { forward: 0.6, lateral: 0.55 };
const SADDLE_LENGTH_OF_TORSO = 0.34;
const SADDLE_DROP_OF_TORSO = 0.1;
const SADDLE_WIDTH_OF_CHEST = 1.02;
const SADDLE_DEPTH_OF_CHEST = 0.36;
const SADDLE_BEHIND_CHEST = 0.85;
const SADDLE_COAT_LENGTH = 0.7;

const FANG_FORWARD_IN_SKULL = 0.34;

const HEAD_COAT_LENGTH = 0.8;
const ARM_COAT_LENGTH = 1.3;
const CREST_COAT_LENGTH = 1.1;
const MUZZLE_COAT_LENGTH = 0.5;
const JAW_COAT_LENGTH = 0.9;
const BROW_COAT_LENGTH = 1.3;

const FINGER_SPREAD_IN_WRIST = 0.55;
const FINGER_ROOT_RADIUS_IN_WRIST = 0.24;
const FINGER_TIP_RADIUS_IN_WRIST = 0.14;
const FINGER_CURL_WALKING = 1;
const FINGER_CURL_HANGING = 0.45;
const THUMB_RADIUS_IN_WRIST = 0.25;
const TOE_COUNT = 5;
const TOE_SPREAD_IN_FOOT = 0.42;
const TOE_RADII_IN_FOOT = { forward: 0.14, height: 0.36, lateral: 0.2 };
const JOINT_BALL_IN_LIMB = 0.98;

function scalePoint(p: YetiPoint, k: number): YetiPoint {
  return { forward: p.forward * k, height: p.height * k, lateral: p.lateral * k };
}

export function yetiParts(spec: YetiVariantSpec): YetiBody {
  const parts: YetiPart[] = [];
  const coatShells = (length: number): YetiShells => ({
    length: spec.coatLength * length,
    layers: spec.shellLayers,
  });

  const torsoLength = spec.shoulderHeight - spec.hipHeight;
  const shoulderForward = Math.sin(spec.hunch) * torsoLength;
  const shoulderHeight = spec.hipHeight + Math.cos(spec.hunch) * torsoLength;

  const coat = (
    joint: YetiJoint,
    side: number,
    center: YetiPoint,
    radii: YetiPoint,
    size: YetiPartSize,
    options: { surface?: YetiSurface; coatLength?: number; tilt?: number } = {},
  ): void => {
    parts.push({
      kind: 'mass',
      joint,
      side,
      surface: options.surface ?? 'coat',
      size,
      shells: coatShells(options.coatLength ?? 1),
      center,
      radii,
      tilt: options.tilt ?? 0,
    });
  };

  const bare = (
    joint: YetiJoint,
    side: number,
    surface: YetiSurface,
    center: YetiPoint,
    radii: YetiPoint,
    size: YetiPartSize,
  ): void => {
    parts.push({ kind: 'mass', joint, side, surface, size, shells: null, center, radii, tilt: 0 });
  };

  const limb = (
    joint: YetiJoint,
    side: number,
    from: YetiPoint,
    to: YetiPoint,
    rootRadius: number,
    tipRadius: number,
    coatLength: number,
  ): void => {
    parts.push({
      kind: 'limb',
      joint,
      side,
      surface: 'coat',
      size: 'limb',
      shells: coatShells(coatLength),
      from,
      to,
      rootRadius,
      tipRadius,
    });
    for (const [at, radius] of [
      [from, rootRadius],
      [to, tipRadius],
    ] as const) {
      parts.push({
        kind: 'mass',
        joint,
        side,
        surface: 'coat',
        size: 'joint',
        shells: null,
        center: at,
        radii: {
          forward: radius * JOINT_BALL_IN_LIMB,
          height: radius * JOINT_BALL_IN_LIMB,
          lateral: radius * JOINT_BALL_IN_LIMB,
        },
        tilt: 0,
      });
    }
  };

  coat('upper', 0, point(0, spec.hipHeight, 0), spec.hipRadii, 'trunk');
  const midHeight = spec.hipHeight + torsoLength * 0.45;
  const midForward = Math.sin(spec.hunch) * torsoLength * 0.45;
  coat(
    'upper',
    0,
    point(midForward + spec.bellyOut, midHeight, 0),
    { ...spec.bellyRadii, height: torsoLength * 0.55 },
    'trunk',
  );
  coat(
    'upper',
    0,
    point(
      shoulderForward + spec.chestOut,
      shoulderHeight - spec.chestRadii.height * 0.35,
      0,
    ),
    spec.chestRadii,
    'trunk',
    { tilt: spec.hunch },
  );
  for (const side of SIDES) {
    coat(
      'upper',
      side,
      point(shoulderForward, shoulderHeight, side * spec.shoulderHalfSpan),
      {
        forward: spec.shoulderRadius,
        height: spec.shoulderRadius * 0.9,
        lateral: spec.shoulderRadius,
      },
      'trunk',
    );
  }
  if (spec.saddle !== 0) {
    coat(
      'upper',
      0,
      point(
        shoulderForward + spec.chestOut - spec.chestRadii.forward * SADDLE_BEHIND_CHEST,
        shoulderHeight - torsoLength * SADDLE_DROP_OF_TORSO,
        0,
      ),
      {
        forward: spec.chestRadii.forward * SADDLE_DEPTH_OF_CHEST,
        height: torsoLength * SADDLE_LENGTH_OF_TORSO,
        lateral: spec.chestRadii.lateral * SADDLE_WIDTH_OF_CHEST,
      },
      'trunk',
      { surface: 'saddle', coatLength: SADDLE_COAT_LENGTH },
    );
  }

  const skull = spec.skull;
  const headHeight =
    shoulderHeight + spec.neckLength * Math.cos(spec.hunch + spec.headDrop);
  const headForward =
    shoulderForward + spec.neckLength * Math.sin(spec.hunch + spec.headDrop) + spec.headForward;
  limb(
    'head',
    0,
    point(shoulderForward, shoulderHeight, 0),
    point(headForward, headHeight, 0),
    spec.neckRadius,
    spec.neckRadius * 0.9,
    1,
  );
  coat('head', 0, point(headForward, headHeight, 0), skull, 'head', {
    coatLength: HEAD_COAT_LENGTH,
  });
  if (spec.crest !== 0) {
    coat(
      'head',
      0,
      point(
        headForward - skull.forward * 0.15,
        headHeight + skull.height * CREST_HEIGHT_IN_SKULL,
        0,
      ),
      {
        forward: skull.forward * CREST_RADII_IN_SKULL.forward,
        height: skull.height * spec.crest,
        lateral: skull.lateral * CREST_RADII_IN_SKULL.lateral,
      },
      'head',
      { coatLength: CREST_COAT_LENGTH },
    );
  }
  coat(
    'head',
    0,
    point(
      headForward + skull.forward * BROW_FORWARD_IN_SKULL,
      headHeight + skull.height * BROW_HEIGHT_IN_SKULL,
      0,
    ),
    {
      forward: skull.forward * BROW_RADII_IN_SKULL.forward,
      height: skull.height * BROW_RADII_IN_SKULL.height,
      lateral: skull.lateral * BROW_RADII_IN_SKULL.lateral,
    },
    'feature',
    { coatLength: BROW_COAT_LENGTH },
  );

  const faceForward = headForward + skull.forward * 0.78;
  bare(
    'head',
    0,
    'face',
    point(
      headForward + skull.forward * FACE_PLATE_FORWARD_IN_SKULL,
      headHeight + skull.height * FACE_PLATE_HEIGHT_IN_SKULL,
      0,
    ),
    {
      forward: skull.forward * FACE_PLATE_DEPTH_IN_SKULL,
      height: skull.height * FACE_PLATE_HEIGHT_RADIUS_IN_SKULL,
      lateral: skull.lateral * spec.faceWidth,
    },
    'feature',
  );

  const muzzleHeight = headHeight + skull.height * MUZZLE_HEIGHT_IN_SKULL;
  const muzzleForward = faceForward + skull.forward * spec.muzzleOut;
  const muzzleRadii = {
    forward: skull.forward * MUZZLE_RADII_IN_SKULL.forward,
    height: skull.height * MUZZLE_RADII_IN_SKULL.height,
    lateral: skull.lateral * MUZZLE_RADII_IN_SKULL.lateral,
  };
  const muzzleCenter = point(muzzleForward - skull.forward * 0.1, muzzleHeight, 0);
  if (spec.muzzleFur) {
    coat('head', 0, muzzleCenter, muzzleRadii, 'feature', { coatLength: MUZZLE_COAT_LENGTH });
  } else {
    bare('head', 0, 'face', muzzleCenter, muzzleRadii, 'feature');
  }
  bare(
    'head',
    0,
    'nose',
    point(muzzleForward + skull.forward * 0.3, muzzleHeight + skull.height * 0.1, 0),
    {
      forward: skull.forward * NOSE_RADII_IN_SKULL.forward,
      height: skull.height * NOSE_RADII_IN_SKULL.height,
      lateral: skull.lateral * NOSE_RADII_IN_SKULL.lateral,
    },
    'feature',
  );
  bare(
    'head',
    0,
    'maw',
    point(muzzleForward + skull.forward * 0.2, muzzleHeight - skull.height * 0.2, 0),
    {
      forward: skull.forward * MOUTH_RADII_IN_SKULL.forward,
      height: skull.height * MOUTH_RADII_IN_SKULL.height,
      lateral: skull.lateral * MOUTH_RADII_IN_SKULL.lateral,
    },
    'feature',
  );
  const jawCenter = point(
    muzzleForward - skull.forward * 0.22,
    muzzleHeight - skull.height * 0.36,
    0,
  );
  const jawRadii = {
    forward: skull.forward * JAW_RADII_IN_SKULL.forward,
    height: skull.height * JAW_RADII_IN_SKULL.height,
    lateral: skull.lateral * JAW_RADII_IN_SKULL.lateral,
  };
  if (spec.muzzleFur) {
    coat('head', 0, jawCenter, jawRadii, 'feature', { coatLength: JAW_COAT_LENGTH });
  } else {
    bare('head', 0, 'face', jawCenter, jawRadii, 'feature');
  }

  for (const side of SIDES) {
    bare(
      'head',
      side,
      'eye',
      point(
        faceForward + skull.forward * EYE_FORWARD_IN_SKULL,
        headHeight + skull.height * EYE_HEIGHT_IN_SKULL,
        side * skull.lateral * EYE_LATERAL_IN_SKULL,
      ),
      {
        forward: skull.forward * EYE_RADII_IN_SKULL.forward,
        height: skull.height * EYE_RADII_IN_SKULL.height,
        lateral: skull.lateral * EYE_RADII_IN_SKULL.lateral,
      },
      'feature',
    );
    const glint = skull.lateral * GLINT_RADIUS_IN_SKULL;
    bare(
      'head',
      side,
      'glint',
      point(
        faceForward + skull.forward * GLINT_FORWARD_IN_SKULL,
        headHeight + skull.height * GLINT_HEIGHT_IN_SKULL,
        side * skull.lateral * GLINT_LATERAL_IN_SKULL,
      ),
      point(glint, glint, glint),
      'digit',
    );
  }

  if (spec.fangs !== 0) {
    for (const side of SIDES) {
      const lateral = side * skull.lateral * 0.22;
      const forward = muzzleForward + skull.forward * FANG_FORWARD_IN_SKULL;
      const height = muzzleHeight - skull.height * 0.16;
      parts.push({
        kind: 'sweep',
        joint: 'head',
        side,
        surface: 'ivory',
        size: 'digit',
        shells: null,
        path: [
          point(forward - 0.02, height + 0.02, lateral),
          point(forward + 0.01, height - spec.fangs * 0.6, lateral * 1.05),
          point(forward + 0.02, height - spec.fangs, lateral * 1.1),
        ],
        rootRadius: skull.lateral * 0.09,
        tipRadius: 0.004,
        taperPower: 1,
      });
    }
  }

  if (spec.horns !== 'none') {
    const finish = hornFinish(spec.horns);
    for (const side of SIDES) {
      const path =
        spec.horns === 'ram'
          ? ramHornPath(skull, side)
          : spec.horns === 'ibex'
            ? ibexHornPath(skull, side)
            : stubHornPath(skull, side);
      const root = path[0]!;
      coat(
        'head',
        side,
        point(headForward + root.forward, headHeight + root.height, root.lateral),
        {
          forward: skull.forward * 0.22,
          height: skull.height * 0.16,
          lateral: skull.lateral * 0.24,
        },
        'feature',
      );
      parts.push({
        kind: 'sweep',
        joint: 'head',
        side,
        surface: 'horn',
        size: 'horn',
        shells: null,
        path: path.map((p) =>
          point(headForward + p.forward, headHeight + p.height, p.lateral),
        ),
        rootRadius: skull.lateral * finish.rootInSkull,
        tipRadius: finish.tip,
        taperPower: spec.horns === 'ram' ? 0.8 : 0.9,
      });
    }
  }

  const arm = spec.arm;
  const armJoint = point(
    shoulderForward,
    shoulderHeight - spec.shoulderRadius * 0.15,
    spec.shoulderHalfSpan,
  );
  for (const side of SIDES) {
    const shoulder = point(0, 0, 0);
    const elbow = point(
      arm.upper * Math.sin(arm.upperForward),
      -arm.upper * Math.cos(arm.upperForward),
      side * arm.elbowFlare,
    );
    let wristHeight = elbow.height - arm.fore * Math.cos(arm.foreForward);
    let wristForward = elbow.forward + arm.fore * Math.sin(arm.foreForward);
    if (spec.knuckle) {
      const groundHeight = arm.wristRadius * 1.1 - armJoint.height;
      const drop = Math.min(arm.fore * 0.98, elbow.height - groundHeight);
      wristHeight = elbow.height - drop;
      wristForward = elbow.forward + Math.sqrt(Math.max(0, arm.fore * arm.fore - drop * drop));
    }
    const wrist = point(wristForward, wristHeight, elbow.lateral + side * arm.wristFlare);

    limb('arm', side, shoulder, elbow, arm.shoulderRadius, arm.elbowRadius, ARM_COAT_LENGTH);
    limb('arm', side, elbow, wrist, arm.elbowRadius, arm.wristRadius, ARM_COAT_LENGTH);

    const curl = spec.knuckle ? FINGER_CURL_WALKING : FINGER_CURL_HANGING;
    bare(
      'arm',
      side,
      'hide',
      point(
        wrist.forward + arm.wristRadius * 0.3,
        wrist.height - arm.wristRadius * 0.6,
        wrist.lateral,
      ),
      {
        forward: arm.wristRadius * 1.5,
        height: arm.wristRadius * 0.75,
        lateral: arm.wristRadius * 1.25,
      },
      'limb',
    );
    const middle = (spec.fingers - 1) / 2;
    for (let finger = 0; finger < spec.fingers; finger++) {
      const lateral =
        wrist.lateral + side * (finger - middle) * arm.wristRadius * FINGER_SPREAD_IN_WRIST;
      const rootForward = wrist.forward + arm.wristRadius * 1.5;
      const rootHeight = wrist.height - arm.wristRadius * 0.75;
      parts.push({
        kind: 'sweep',
        joint: 'arm',
        side,
        surface: 'hide',
        size: 'digit',
        shells: null,
        path: [
          point(rootForward, rootHeight, lateral),
          point(
            rootForward + arm.wristRadius * 0.55 * (1 - curl * 0.6),
            rootHeight - arm.wristRadius * 0.5 * curl,
            lateral,
          ),
          point(
            rootForward + arm.wristRadius * 0.75 * (1 - curl * 0.7),
            rootHeight - arm.wristRadius * 1.05 * curl,
            lateral,
          ),
        ],
        rootRadius: arm.wristRadius * FINGER_ROOT_RADIUS_IN_WRIST,
        tipRadius: arm.wristRadius * FINGER_TIP_RADIUS_IN_WRIST,
        taperPower: 1,
      });
    }
    const thumb = arm.wristRadius * THUMB_RADIUS_IN_WRIST;
    bare(
      'arm',
      side,
      'hide',
      point(
        wrist.forward + arm.wristRadius * 0.7,
        wrist.height - arm.wristRadius * 0.5,
        wrist.lateral + side * arm.wristRadius * 1.15,
      ),
      { forward: thumb * 2, height: thumb, lateral: thumb },
      'digit',
    );
  }

  const leg = spec.leg;
  const legJoint = point(0, spec.hipHeight - spec.hipRadii.height * 0.15, spec.stanceHalfWidth);
  for (const side of SIDES) {
    const hip = point(0, 0, 0);
    const knee = point(
      leg.thigh * Math.sin(leg.thighForward),
      -leg.thigh * Math.cos(leg.thighForward),
      side * leg.kneeFlare,
    );
    const ankle = point(
      knee.forward - leg.shin * Math.sin(leg.shinForward),
      knee.height - leg.shin * Math.cos(leg.shinForward),
      knee.lateral,
    );
    coat(
      'leg',
      side,
      point(0, -leg.thigh * 0.2, 0),
      {
        forward: leg.hipRadius * 1.5,
        height: leg.thigh * 0.55,
        lateral: leg.hipRadius * 1.45,
      },
      'trunk',
    );
    limb('leg', side, hip, knee, leg.hipRadius, leg.kneeRadius, 1);
    limb('leg', side, knee, ankle, leg.kneeRadius, leg.ankleRadius, 1);

    const soleHeight = leg.footHeight / 2 - (legJoint.height + ankle.height);
    bare(
      'ankle',
      side,
      'hide',
      point(leg.footLength * 0.28, soleHeight, 0),
      {
        forward: leg.footLength * 0.55,
        height: leg.footHeight / 2,
        lateral: leg.footWidth,
      },
      'limb',
    );
    const middleToe = (TOE_COUNT - 1) / 2;
    for (let toe = 0; toe < TOE_COUNT; toe++) {
      const spread = toe - middleToe;
      bare(
        'ankle',
        side,
        'hide',
        point(
          leg.footLength * 0.78 - Math.abs(spread) * leg.footLength * 0.06,
          soleHeight - leg.footHeight / 2 + leg.footHeight * 0.38,
          side * spread * leg.footWidth * TOE_SPREAD_IN_FOOT,
        ),
        {
          forward: leg.footLength * TOE_RADII_IN_FOOT.forward,
          height: leg.footHeight * TOE_RADII_IN_FOOT.height,
          lateral: leg.footWidth * TOE_RADII_IN_FOOT.lateral,
        },
        'digit',
      );
    }
    coat(
      'ankle',
      side,
      point(
        leg.footLength * 0.05,
        soleHeight + leg.footHeight / 2 + leg.ankleRadius * 0.3,
        0,
      ),
      {
        forward: leg.ankleRadius * 1.3,
        height: leg.ankleRadius * 0.6,
        lateral: leg.ankleRadius * 1.1,
      },
      'limb',
    );
  }

  const ankleJoint = point(
    leg.thigh * Math.sin(leg.thighForward) - leg.shin * Math.sin(leg.shinForward),
    -(leg.thigh * Math.cos(leg.thighForward) + leg.shin * Math.cos(leg.shinForward)),
    leg.kneeFlare,
  );

  return { parts, joints: { leg: legJoint, ankle: ankleJoint, arm: armJoint } };
}

export const YETI_LEAN_RADIANS = 0.05;

const STEP_OF_LEG_LENGTH = 0.39;

export const YETI_LEG_SWING_RADIANS = Math.asin(STEP_OF_LEG_LENGTH / 2);

export const YETI_ARM_SWING_FRACTION = 0.7;
export const YETI_ARM_SWING_RADIANS = YETI_LEG_SWING_RADIANS * YETI_ARM_SWING_FRACTION;

interface PartBound {
  readonly topHeight: number;
  readonly lateral: number;
  readonly forwardExtent: number;
}

function boundOf(part: YetiPart): PartBound {
  const grow = part.shells === null ? 1 : 1 + part.shells.length;
  let topHeight = -Infinity;
  let lateral = 0;
  let forwardExtent = 0;
  const consider = (at: YetiPoint, radius: YetiPoint): void => {
    topHeight = Math.max(topHeight, at.height + radius.height);
    lateral = Math.max(lateral, Math.abs(at.lateral) + radius.lateral);
    forwardExtent = Math.max(forwardExtent, Math.abs(at.forward) + radius.forward);
  };
  if (part.kind === 'mass') {
    const height =
      part.tilt === 0
        ? part.radii.height
        : Math.hypot(
            part.radii.height * Math.cos(part.tilt),
            part.radii.forward * Math.sin(part.tilt),
          );
    consider(part.center, scalePoint({ ...part.radii, height }, grow));
  } else if (part.kind === 'limb') {
    const root = part.rootRadius * grow;
    const tip = part.tipRadius * grow;
    consider(part.from, point(root, root, root));
    consider(part.to, point(tip, tip, tip));
  } else {
    const radius = Math.max(part.rootRadius, part.tipRadius) * grow;
    for (const at of part.path) consider(at, point(radius, radius, radius));
  }
  return { topHeight, lateral, forwardExtent };
}

function jointOrigin(body: YetiBody, part: YetiPart): YetiPoint {
  if (part.joint === 'leg') {
    return point(body.joints.leg.forward, body.joints.leg.height, part.side * body.joints.leg.lateral);
  }
  if (part.joint === 'ankle') {
    return point(
      body.joints.leg.forward + body.joints.ankle.forward,
      body.joints.leg.height + body.joints.ankle.height,
      part.side * (body.joints.leg.lateral + body.joints.ankle.lateral),
    );
  }
  if (part.joint === 'arm') {
    return point(body.joints.arm.forward, body.joints.arm.height, part.side * body.joints.arm.lateral);
  }
  return point(0, 0, 0);
}

function solveBounds(body: YetiBody): { apex: number; reach: number } {
  let apex = 0;
  let reach = 0;
  for (const part of body.parts) {
    const bound = boundOf(part);
    const origin = jointOrigin(body, part);
    apex = Math.max(apex, origin.height + bound.topHeight);
    const lateral = Math.abs(origin.lateral) + bound.lateral;
    if (part.joint === 'leg' || part.joint === 'ankle') {
      reach = Math.max(reach, lateral);
      continue;
    }
    const swing = part.joint === 'arm' ? YETI_ARM_SWING_RADIANS : 0;
    const swungTop =
      origin.height +
      bound.topHeight * Math.cos(swing) +
      bound.forwardExtent * Math.sin(swing);
    reach = Math.max(
      reach,
      lateral * Math.cos(YETI_LEAN_RADIANS) + swungTop * Math.sin(YETI_LEAN_RADIANS),
    );
  }
  return { apex, reach };
}

export const YETI_AMBLE_SPEED_CELLS_PER_SECOND = 0.08110465116279071;

const BOB_OF_HEIGHT = 0.00872;
export const YETI_BOB_CELLS = BOB_OF_HEIGHT * YETI_TOTAL_HEIGHT;

export const YETI_CLIMB_REACH_HZ = 0.5;

export const YETI_CLIMB_ARM_HIGH_RADIANS = 2.3;
export const YETI_CLIMB_ARM_LOW_RADIANS = 1.3;

export const YETI_CLIMB_LEG_HIGH_RADIANS = 0.8;
export const YETI_CLIMB_LEG_LOW_RADIANS = 0.15;

export const YETI_CLIMB_PULL_CELLS = YETI_BOB_CELLS * 2;

export const YETI_BREATH_HZ = 0.15;

export const YETI_BREATH_CELLS = YETI_BOB_CELLS / 2;

export const YETI_SIT_LEG_RADIANS = 1.35;

export const YETI_SIT_ARM_RADIANS = -0.35;

export const YETI_FALL_ARM_RADIANS = 2.9;
export const YETI_FALL_FLAIL_HZ = 3;
export const YETI_FALL_FLAIL_RADIANS = 0.35;
export const YETI_FALL_LEG_SPREAD_RADIANS = 0.45;

export const YETI_HEAD_SCAN_HZ = 0.09;
export const YETI_HEAD_SCAN_RADIANS = 0.14;

export interface YetiMetrics {
  readonly scale: number;
  readonly totalHeight: number;
  readonly reachFromAxis: number;
  readonly width: number;
  readonly footGroundHalfExtent: number;

  readonly hipHeight: number;
  readonly headCenterHeight: number;
  readonly headRadius: number;
  readonly hipsWidth: number;
  readonly legLength: number;
  readonly handHeight: number;

  readonly legJoint: YetiPoint;
  readonly ankleHeight: number;
  readonly armJoint: YetiPoint;

  readonly strideCells: number;
  readonly ambleHz: number;
  readonly legSwingRadians: number;
  readonly armSwingRadians: number;
}

function metricsOf(spec: YetiVariantSpec): YetiMetrics {
  const body = yetiParts(spec);
  const { apex, reach } = solveBounds(body);
  const scale = YETI_TOTAL_HEIGHT / apex;

  const torsoLength = spec.shoulderHeight - spec.hipHeight;
  const headHeight =
    spec.hipHeight +
    Math.cos(spec.hunch) * torsoLength +
    spec.neckLength * Math.cos(spec.hunch + spec.headDrop);
  const ankleDrop =
    spec.leg.thigh * Math.cos(spec.leg.thighForward) +
    spec.leg.shin * Math.cos(spec.leg.shinForward);
  const legLength = ankleDrop * scale;
  const strideCells = 2 * STEP_OF_LEG_LENGTH * legLength;
  const handDrop =
    spec.arm.upper * Math.cos(spec.arm.upperForward) +
    spec.arm.fore * Math.cos(spec.arm.foreForward);
  const legJoint = scalePoint(body.joints.leg, scale);

  return {
    scale,
    totalHeight: apex * scale,
    reachFromAxis: reach * scale,
    width: 2 * reach * scale,
    footGroundHalfExtent: (spec.stanceHalfWidth + spec.leg.footWidth) * scale,
    hipHeight: spec.hipHeight * scale,
    headCenterHeight: headHeight * scale,
    headRadius:
      Math.max(spec.skull.forward, spec.skull.height, spec.skull.lateral) * scale,
    hipsWidth: 2 * spec.hipRadii.lateral * scale,
    legLength,
    handHeight: (spec.shoulderHeight - spec.shoulderRadius * 0.15 - handDrop) * scale,
    legJoint,
    ankleHeight: legJoint.height - legLength,
    armJoint: scalePoint(body.joints.arm, scale),
    strideCells,
    ambleHz: YETI_AMBLE_SPEED_CELLS_PER_SECOND / strideCells,
    legSwingRadians: YETI_LEG_SWING_RADIANS,
    armSwingRadians: YETI_ARM_SWING_RADIANS,
  };
}

export const YETI_VARIANT_METRICS: Readonly<Record<YetiVariant, YetiMetrics>> = {
  silverback: metricsOf(YETI_VARIANT_SPECS.silverback),
  ram: metricsOf(YETI_VARIANT_SPECS.ram),
  ibex: metricsOf(YETI_VARIANT_SPECS.ibex),
  fanged: metricsOf(YETI_VARIANT_SPECS.fanged),
};

export function yetiWorldParts(variant: YetiVariant): YetiBody {
  const body = yetiParts(YETI_VARIANT_SPECS[variant]);
  const scale = YETI_VARIANT_METRICS[variant].scale;
  const scaleRadii = (p: YetiPoint): YetiPoint => scalePoint(p, scale);
  return {
    parts: body.parts.map((part): YetiPart => {
      if (part.kind === 'mass') {
        return { ...part, center: scaleRadii(part.center), radii: scaleRadii(part.radii) };
      }
      if (part.kind === 'limb') {
        return {
          ...part,
          from: scaleRadii(part.from),
          to: scaleRadii(part.to),
          rootRadius: part.rootRadius * scale,
          tipRadius: part.tipRadius * scale,
        };
      }
      return {
        ...part,
        path: part.path.map(scaleRadii),
        rootRadius: part.rootRadius * scale,
        tipRadius: part.tipRadius * scale,
      };
    }),
    joints: {
      leg: scaleRadii(body.joints.leg),
      ankle: scaleRadii(body.joints.ankle),
      arm: scaleRadii(body.joints.arm),
    },
  };
}

export const YETI_VARIANT_WIDTH_CELLS: Readonly<Record<YetiVariant, number>> = {
  silverback: YETI_VARIANT_METRICS.silverback.width,
  ram: YETI_VARIANT_METRICS.ram.width,
  ibex: YETI_VARIANT_METRICS.ibex.width,
  fanged: YETI_VARIANT_METRICS.fanged.width,
};

export const YETI_WIDEST_VARIANT_WIDTH_CELLS = Math.max(
  ...YETI_VARIANTS.map((variant) => YETI_VARIANT_WIDTH_CELLS[variant]),
);

export const YETI_WIDTH_CELLS = YETI_WIDEST_VARIANT_WIDTH_CELLS;

export const YETI_FOOT_GROUND_HALF_EXTENT = Math.max(
  ...YETI_VARIANTS.map((variant) => YETI_VARIANT_METRICS[variant].footGroundHalfExtent),
);
