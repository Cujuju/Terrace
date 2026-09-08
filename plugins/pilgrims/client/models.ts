import {
  BufferAttribute,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshPhongMaterial,
  SphereGeometry,
  TorusGeometry,
  type Bone,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MoverGait } from '../../../client/src/plugins/kit/moverGait.ts';
import { applyMoverBodyTilt } from '../../../client/src/plugins/kit/moverBodyTilt.ts';
import { bakeRig, instantiateRig, type RigBlueprint } from '../../../client/src/render/rigSkin.ts';
import { SETTLER_RACES, WALKER_KINDS, type SettlerRace, type WalkerKind } from '../protocol.ts';

const PILGRIM_AUTHORED_HEIGHT = 0.62;

export const PILGRIM_MODEL_SCALE = 0.85;

export const PILGRIM_HEIGHT = PILGRIM_AUTHORED_HEIGHT * PILGRIM_MODEL_SCALE;

export const STRIDE_HZ = 1.6;

const TWO_PI = Math.PI * 2;

export const LEG_SWING_RADIANS = 0.35;

export const ARM_SWING_RADIANS = 0.25;

const BOB_AMPLITUDE = 0.012;

const WALKER_HIP_HEIGHT_WORLD_UNITS = 0.1;

const STAND_BREATH_HZ = 0.25;

const STAND_BREATH_WORLD_UNITS = BOB_AMPLITUDE / 3;

const SIT_LEG_RADIANS = Math.PI / 2;

const SIT_ARM_RADIANS = -0.3;

const CLIMB_REACH_HZ = 0.75;

const CLIMB_ARM_HIGH_RADIANS = 2.4;
const CLIMB_ARM_LOW_RADIANS = 1.4;

const CLIMB_LEG_HIGH_RADIANS = 0.95;
const CLIMB_LEG_LOW_RADIANS = 0.2;

const CLIMB_PULL_WORLD_UNITS = BOB_AMPLITUDE * 3;

const FALL_ARM_RADIANS = 2.9;
const FALL_FLAIL_HZ = 4;
const FALL_FLAIL_RADIANS = 0.3;
const FALL_LEG_SPREAD_RADIANS = 0.5;

const BLUEPRINT_KINDS = WALKER_KINDS;
const BLUEPRINT_RACES = SETTLER_RACES;

const RUDY_WAG_RADIANS = 0.45;
const UNO_SWAY_RADIANS = 0.14;

const RUDY_COAT_COLOR = 0xbe8f63;
const RUDY_EAR_COLOR = 0x9d7248;
const RUDY_CREAM_COLOR = 0xf2e7d3;
const RUDY_COLLAR_COLOR = 0xd2703c;
const RUDY_NOSE_COLOR = 0x46342a;
const UNO_COAT_COLOR = 0x9fa9bc;
const UNO_EAR_COLOR = 0x8791a5;
const UNO_CREAM_COLOR = 0xf0ede6;
const UNO_COLLAR_COLOR = 0x6f8fc9;
const UNO_NOSE_COLOR = 0xb08585;
const TAG_COLOR = 0xe3c56b;
const EYE_COLOR = 0x1d1a16;
const STAFF_COLOR = 0x6b4a2b;
const BUNDLE_COLOR = 0x9c7f52;
const BUNDLE_STRAP_COLOR = 0x5c4630;

export interface PilgrimModel {
  readonly root: Group;
  readonly joints: WalkerJoints;
  animate(seconds: number, phase: number, gait?: MoverGait): void;
  dispose(): void;
}

export interface PilgrimModels {
  create(race: SettlerRace, kind?: WalkerKind): PilgrimModel;
  dispose(): void;
}

interface WalkerRig {
  readonly blueprint: RigBlueprint;
  readonly jointIndices: Readonly<Record<string, number>>;
}

interface WalkerJoints {
  readonly rigRoot: Bone;
  readonly body: Bone;
  readonly leftLeg: Bone;
  readonly rightLeg: Bone;
  readonly leftArm: Bone;
  readonly rightArm: Bone;
  readonly tail: Bone;
  readonly staff: Bone | null;
}

function paint(geometry: BufferGeometry, hex: number): BufferGeometry {
  const linear = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = linear.r;
    colors[i * 3 + 1] = linear.g;
    colors[i * 3 + 2] = linear.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

function mergePainted(parts: [BufferGeometry, number][]): BufferGeometry {
  const merged = mergeGeometries(
    parts.map(([geometry, color]) => paint(geometry, color)),
    false,
  );
  if (merged === null) {
    throw new Error('pilgrims: geometry merge failed — attribute mismatch');
  }
  for (const [geometry] of parts) geometry.dispose();
  return merged;
}

function setHipHeight(joints: WalkerJoints, y: number): void {
  joints.leftLeg.position.y = y;
  joints.rightLeg.position.y = y;
}

function poseWalk(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  const stride = Math.sin(seconds * TWO_PI * STRIDE_HZ + phase);
  joints.leftLeg.rotation.z = stride * LEG_SWING_RADIANS;
  joints.rightLeg.rotation.z = -stride * LEG_SWING_RADIANS;
  joints.leftArm.rotation.z = -stride * ARM_SWING_RADIANS;
  joints.rightArm.rotation.z = stride * ARM_SWING_RADIANS;
  joints.body.position.y = Math.abs(stride) * BOB_AMPLITUDE;
}

function poseStand(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  joints.leftLeg.rotation.z = 0;
  joints.rightLeg.rotation.z = 0;
  joints.leftArm.rotation.z = 0;
  joints.rightArm.rotation.z = 0;
  const breath = (1 - Math.cos(seconds * TWO_PI * STAND_BREATH_HZ + phase)) / 2;
  joints.body.position.y = breath * STAND_BREATH_WORLD_UNITS;
}

function poseSit(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, 0);
  joints.leftLeg.rotation.z = SIT_LEG_RADIANS;
  joints.rightLeg.rotation.z = SIT_LEG_RADIANS;
  joints.leftArm.rotation.z = SIT_ARM_RADIANS;
  joints.rightArm.rotation.z = SIT_ARM_RADIANS;
  const breath = (1 - Math.cos(seconds * TWO_PI * STAND_BREATH_HZ + phase)) / 2;
  joints.body.position.y = -WALKER_HIP_HEIGHT_WORLD_UNITS + breath * STAND_BREATH_WORLD_UNITS;
}

function poseClimb(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  const reach = Math.sin(seconds * TWO_PI * CLIMB_REACH_HZ + phase);
  const high = (CLIMB_ARM_HIGH_RADIANS + CLIMB_ARM_LOW_RADIANS) / 2;
  const armSpan = (CLIMB_ARM_HIGH_RADIANS - CLIMB_ARM_LOW_RADIANS) / 2;
  joints.leftArm.rotation.z = high + reach * armSpan;
  joints.rightArm.rotation.z = high - reach * armSpan;
  const knee = (CLIMB_LEG_HIGH_RADIANS + CLIMB_LEG_LOW_RADIANS) / 2;
  const legSpan = (CLIMB_LEG_HIGH_RADIANS - CLIMB_LEG_LOW_RADIANS) / 2;
  joints.leftLeg.rotation.z = knee - reach * legSpan;
  joints.rightLeg.rotation.z = knee + reach * legSpan;
  joints.body.position.y = Math.abs(reach) * CLIMB_PULL_WORLD_UNITS;
}

const STAFF_CARRIED_SCALE = 1;
const STAFF_STOWED_SCALE = 0;

function setStaffCarried(joints: WalkerJoints, carried: boolean): void {
  joints.staff?.scale.setScalar(carried ? STAFF_CARRIED_SCALE : STAFF_STOWED_SCALE);
}

function poseFall(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  const flail = Math.sin(seconds * TWO_PI * FALL_FLAIL_HZ + phase) * FALL_FLAIL_RADIANS;
  joints.leftArm.rotation.z = FALL_ARM_RADIANS + flail;
  joints.rightArm.rotation.z = FALL_ARM_RADIANS - flail;
  joints.leftLeg.rotation.z = FALL_LEG_SPREAD_RADIANS + flail;
  joints.rightLeg.rotation.z = -FALL_LEG_SPREAD_RADIANS + flail;
  joints.body.position.y = 0;
}

export function createPilgrimModels(): PilgrimModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  function keep<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function matte(color: number): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color });
    materials.push(material);
    return material;
  }

  const bodyMaterial = new MeshLambertMaterial({ vertexColors: true });
  const glossMaterial = new MeshPhongMaterial({
    vertexColors: true,
    shininess: 90,
    specular: 0x777777,
  });
  materials.push(bodyMaterial, glossMaterial);

  const legGeometry = keep(new CapsuleGeometry(0.034, 0.052, 6, 16));
  legGeometry.translate(0, -0.048, 0);
  const armGeometry = keep(new CapsuleGeometry(0.028, 0.07, 6, 16));
  armGeometry.translate(0, -0.058, 0);

  const staffGeometry = keep(new CylinderGeometry(0.012, 0.012, 0.5, 12));

  const bundleGeometry = keep(new CapsuleGeometry(0.052, 0.09, 6, 14));
  bundleGeometry.rotateX(Math.PI / 2);
  const bundleStrapGeometry = keep(new TorusGeometry(0.058, 0.008, 6, 16));

  const staffMaterial = matte(STAFF_COLOR);
  const bundleMaterial = matte(BUNDLE_COLOR);
  const bundleStrapMaterial = matte(BUNDLE_STRAP_COLOR);
  const rudyFurMaterial = matte(RUDY_COAT_COLOR);
  const unoFurMaterial = matte(UNO_COAT_COLOR);

  const rudyBody = keep(
    mergePainted([
      [new SphereGeometry(0.125, 24, 18).scale(0.95, 1.2, 1).translate(0, 0.2, 0), RUDY_COAT_COLOR],
      [new SphereGeometry(0.105, 20, 14).scale(0.85, 1.05, 0.9).translate(0.045, 0.185, 0), RUDY_CREAM_COLOR],
      [new SphereGeometry(0.155, 28, 20).scale(1, 0.95, 1).translate(0.01, 0.46, 0), RUDY_COAT_COLOR],
      [new SphereGeometry(0.07, 20, 14).scale(1.15, 0.75, 0.95).translate(0.145, 0.415, 0), RUDY_CREAM_COLOR],
      [
        new SphereGeometry(0.066, 16, 12)
          .scale(0.42, 1.55, 0.85)
          .translate(0, -0.07, 0)
          .rotateX(-1.5)
          .translate(0.005, 0.545, -0.128),
        RUDY_EAR_COLOR,
      ],
      [
        new SphereGeometry(0.066, 16, 12)
          .scale(0.42, 1.55, 0.85)
          .translate(0, -0.07, 0)
          .rotateX(1.5)
          .translate(0.005, 0.545, 0.128),
        RUDY_EAR_COLOR,
      ],
      [new TorusGeometry(0.082, 0.013, 10, 24).rotateX(Math.PI / 2).translate(0.005, 0.345, 0), RUDY_COLLAR_COLOR],
      [new SphereGeometry(0.016, 10, 8).translate(0.09, 0.322, 0), TAG_COLOR],
    ]),
  );
  const rudyGloss = keep(
    mergePainted([
      [new SphereGeometry(0.026, 14, 12).translate(0.135, 0.49, -0.056), EYE_COLOR],
      [new SphereGeometry(0.026, 14, 12).translate(0.135, 0.49, 0.056), EYE_COLOR],
      [new SphereGeometry(0.023, 12, 10).scale(1.1, 0.85, 1).translate(0.218, 0.432, 0), RUDY_NOSE_COLOR],
    ]),
  );
  const rudyTail = keep(
    new TorusGeometry(0.05, 0.021, 10, 16, 2.1).translate(-0.05, 0, 0),
  );

  const unoBody = keep(
    mergePainted([
      [new SphereGeometry(0.115, 24, 18).scale(0.85, 1.25, 0.9).translate(0, 0.2, 0), UNO_COAT_COLOR],
      [new SphereGeometry(0.095, 20, 14).scale(0.8, 1.1, 0.85).translate(0.04, 0.19, 0), UNO_CREAM_COLOR],
      [new SphereGeometry(0.145, 28, 20).translate(0.01, 0.465, 0), UNO_COAT_COLOR],
      [new SphereGeometry(0.055, 18, 12).scale(1, 0.72, 0.95).translate(0.135, 0.42, 0), UNO_CREAM_COLOR],
      [
        new ConeGeometry(0.04, 0.1, 18, 4)
          .translate(0, 0.05, 0)
          .rotateX(-0.38)
          .rotateZ(-0.14)
          .translate(0.015, 0.582, -0.094),
        UNO_EAR_COLOR,
      ],
      [
        new ConeGeometry(0.04, 0.1, 18, 4)
          .translate(0, 0.05, 0)
          .rotateX(0.38)
          .rotateZ(-0.14)
          .translate(0.015, 0.582, 0.094),
        UNO_EAR_COLOR,
      ],
      [new TorusGeometry(0.076, 0.012, 10, 24).rotateX(Math.PI / 2).translate(0.005, 0.35, 0), UNO_COLLAR_COLOR],
      [new SphereGeometry(0.015, 10, 8).translate(0.093, 0.318, 0), TAG_COLOR],
    ]),
  );
  const unoGloss = keep(
    mergePainted([
      [new SphereGeometry(0.026, 14, 12).translate(0.128, 0.492, -0.052), EYE_COLOR],
      [new SphereGeometry(0.026, 14, 12).translate(0.128, 0.492, 0.052), EYE_COLOR],
      [new SphereGeometry(0.015, 12, 10).scale(1.1, 0.8, 1).translate(0.186, 0.437, 0), UNO_NOSE_COLOR],
    ]),
  );
  const unoTail = keep(
    new TorusGeometry(0.1, 0.015, 10, 20, 2.0).translate(-0.1, 0, 0),
  );

  function bakeWalker(race: SettlerRace, kind: WalkerKind): WalkerRig {
    const rudy = race === 'rudy';
    const fur = rudy ? rudyFurMaterial : unoFurMaterial;

    const root = new Group();
    root.name = `pilgrims:${kind}:${race}`;

    const body = new Group();
    root.add(body);

    const hipY = WALKER_HIP_HEIGHT_WORLD_UNITS;
    const shoulderY = 0.3;
    const shoulderZ = rudy ? 0.115 : 0.105;

    const leftLeg = new Mesh(legGeometry, fur);
    leftLeg.position.set(0, hipY, -0.048);
    const rightLeg = new Mesh(legGeometry, fur);
    rightLeg.position.set(0, hipY, 0.048);
    root.add(leftLeg, rightLeg);

    const trunk = new Mesh(rudy ? rudyBody : unoBody, bodyMaterial);
    const gloss = new Mesh(rudy ? rudyGloss : unoGloss, glossMaterial);
    body.add(trunk, gloss);

    const leftArm = new Mesh(armGeometry, fur);
    leftArm.position.set(0, shoulderY, -shoulderZ);
    const rightArm = new Mesh(armGeometry, fur);
    rightArm.position.set(0, shoulderY, shoulderZ);
    body.add(leftArm, rightArm);

    let staff: Mesh | null = null;
    if (kind === 'pilgrim') {
      staff = new Mesh(staffGeometry, staffMaterial);
      staff.position.set(0.045, -0.105, 0.012);
      rightArm.add(staff);
    } else if (kind === 'settler') {
      const bundle = new Mesh(bundleGeometry, bundleMaterial);
      bundle.position.set(-0.075, 0.235, 0);
      const strap = new Mesh(bundleStrapGeometry, bundleStrapMaterial);
      strap.position.set(-0.075, 0.235, 0);
      strap.rotation.y = Math.PI / 2;
      body.add(bundle, strap);
    }

    const tail = new Mesh(rudy ? rudyTail : unoTail, fur);
    tail.position.set(rudy ? -0.12 : -0.1, rudy ? 0.16 : 0.13, 0);
    body.add(tail);

    const blueprint = bakeRig(root);
    return {
      blueprint,
      jointIndices: {
        rigRoot: blueprint.jointIndex(root),
        body: blueprint.jointIndex(body),
        leftLeg: blueprint.jointIndex(leftLeg),
        rightLeg: blueprint.jointIndex(rightLeg),
        leftArm: blueprint.jointIndex(leftArm),
        rightArm: blueprint.jointIndex(rightArm),
        tail: blueprint.jointIndex(tail),
        ...(staff === null ? {} : { staff: blueprint.jointIndex(staff) }),
      },
    };
  }

  const walkerRigs = new Map<string, WalkerRig>();
  for (const bpRace of BLUEPRINT_RACES) {
    for (const bpKind of BLUEPRINT_KINDS) {
      walkerRigs.set(`${bpRace}:${bpKind}`, bakeWalker(bpRace, bpKind));
    }
  }

  function create(race: SettlerRace, kind: WalkerKind = 'pilgrim'): PilgrimModel {
    const rudy = race === 'rudy';
    const rigKey = `${race}:${kind}`;
    const rig = walkerRigs.get(rigKey);
    if (rig === undefined) throw new Error(`pilgrims: no baked rig for ${rigKey}`);
    const instance = instantiateRig(rig.blueprint);
    const joints: WalkerJoints = {
      rigRoot: instance.joints[rig.jointIndices.rigRoot]!,
      body: instance.joints[rig.jointIndices.body]!,
      leftLeg: instance.joints[rig.jointIndices.leftLeg]!,
      rightLeg: instance.joints[rig.jointIndices.rightLeg]!,
      leftArm: instance.joints[rig.jointIndices.leftArm]!,
      rightArm: instance.joints[rig.jointIndices.rightArm]!,
      tail: instance.joints[rig.jointIndices.tail]!,
      staff:
        rig.jointIndices.staff === undefined
          ? null
          : instance.joints[rig.jointIndices.staff]!,
    };
    const { root } = instance;
    root.name = `pilgrims:${kind}:${race}`;
    root.scale.setScalar(PILGRIM_MODEL_SCALE);

    return {
      root,
      joints,
      animate(seconds: number, phase: number, gait: MoverGait = 'walk'): void {
        if (gait === 'walk') poseWalk(joints, seconds, phase);
        else if (gait === 'stand') poseStand(joints, seconds, phase);
        else if (gait === 'sit') poseSit(joints, seconds, phase);
        else if (gait === 'climb') poseClimb(joints, seconds, phase);
        else poseFall(joints, seconds, phase);
        setStaffCarried(joints, gait !== 'climb' && gait !== 'fall');
        applyMoverBodyTilt(joints.rigRoot, gait, seconds, phase);
        if (rudy) {
          joints.tail.rotation.y = Math.sin(seconds * TWO_PI * STRIDE_HZ * 2 + phase) * RUDY_WAG_RADIANS;
        } else {
          joints.tail.rotation.y = Math.sin(seconds * TWO_PI * (STRIDE_HZ / 3) + phase) * UNO_SWAY_RADIANS;
        }
      },
      dispose(): void {
        instance.dispose();
      },
    };
  }

  return {
    create,
    dispose(): void {
      for (const rig of walkerRigs.values()) rig.blueprint.dispose();
      walkerRigs.clear();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
