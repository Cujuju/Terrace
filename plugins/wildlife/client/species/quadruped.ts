import { Group, type Material, type Object3D } from 'three';
import { limb, smoothEllipsoid } from './bodyKit.ts';
import type { SpeciesJoints, SpeciesModelPool } from './speciesModel.ts';

export interface QuadrupedLegSpec {
  readonly hipY: number;
  readonly foreX: number;
  readonly hindX: number;
  readonly halfStance: number;
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly radialSegments: number;
  readonly heightSegments: number;
  readonly hoofHeight: number;
  readonly haunch: readonly [number, number, number] | null;
}

export interface QuadrupedLegs {
  readonly foreLeft: Object3D;
  readonly foreRight: Object3D;
  readonly hindLeft: Object3D;
  readonly hindRight: Object3D;
}

const HOOF_RADIAL_SEGMENTS = 8;
const HAUNCH_SEGMENTS = 8;
const HAUNCH_SEAT_FRACTION = 0.25;
const HOOF_SEAT_FRACTION = 0.1;

export function addQuadrupedLegs(
  pool: SpeciesModelPool,
  rig: Group,
  spec: QuadrupedLegSpec,
  legMaterial: Material,
  hoofMaterial: Material,
  haunchMaterial: Material = legMaterial,
): QuadrupedLegs {
  const legLength = spec.hipY - spec.hoofHeight;
  const legGeometry = pool.keepGeometry(limb({
    rootRadius: spec.rootRadius,
    tipRadius: spec.tipRadius,
    length: legLength,
    radialSegments: spec.radialSegments,
    heightSegments: spec.heightSegments,
  }));
  const hoofGeometry = spec.hoofHeight > 0
    ? pool.keepGeometry(limb({
      rootRadius: spec.tipRadius,
      tipRadius: spec.tipRadius * 0.9,
      length: spec.hoofHeight * (1 + HOOF_SEAT_FRACTION),
      radialSegments: HOOF_RADIAL_SEGMENTS,
      heightSegments: 1,
    }))
    : null;
  const haunchGeometry = spec.haunch
    ? pool.keepGeometry(smoothEllipsoid(...spec.haunch, HAUNCH_SEGMENTS, HAUNCH_SEGMENTS))
    : null;

  function leg(x: number, z: number): Object3D {
    const hinge = new Group();
    hinge.position.set(x, spec.hipY, z);
    if (haunchGeometry) hinge.add(pool.part(haunchGeometry, haunchMaterial, 0, spec.haunch![1] * HAUNCH_SEAT_FRACTION, 0));
    hinge.add(pool.part(legGeometry, legMaterial, 0, 0, 0));
    if (hoofGeometry) hinge.add(pool.part(hoofGeometry, hoofMaterial, 0, -legLength + spec.hoofHeight * HOOF_SEAT_FRACTION, 0));
    rig.add(hinge);
    return hinge;
  }

  return {
    foreLeft: leg(spec.foreX, spec.halfStance),
    foreRight: leg(spec.foreX, -spec.halfStance),
    hindLeft: leg(spec.hindX, spec.halfStance),
    hindRight: leg(spec.hindX, -spec.halfStance),
  };
}

export function legJoints(legs: QuadrupedLegs): Record<string, Object3D> {
  return {
    foreLeft: legs.foreLeft,
    foreRight: legs.foreRight,
    hindLeft: legs.hindLeft,
    hindRight: legs.hindRight,
  };
}

export function poseWalk(
  joints: SpeciesJoints,
  beat: number,
  swingRadians: number,
  bobAmplitude: number,
): void {
  const swing = Math.sin(beat) * swingRadians;
  joints.foreLeft!.rotation.z = swing;
  joints.hindRight!.rotation.z = swing;
  joints.foreRight!.rotation.z = -swing;
  joints.hindLeft!.rotation.z = -swing;
  joints.rig!.position.y = Math.abs(Math.sin(beat)) * bobAmplitude;
}

const REST_BREATH_HZ = 0.25;

const BREATH_TO_BOB_RATIO = 1 / 3;

const SIT_TUCK_RADIANS = 1.2;

function breath(seconds: number, phase: number, bobAmplitude: number): number {
  const cycle = (1 - Math.cos(seconds * REST_BREATH_HZ * TWO_PI + phase)) / 2;
  return cycle * bobAmplitude * BREATH_TO_BOB_RATIO;
}

export function poseStand(
  joints: SpeciesJoints,
  seconds: number,
  phase: number,
  bobAmplitude: number,
): void {
  joints.foreLeft!.rotation.z = 0;
  joints.foreRight!.rotation.z = 0;
  joints.hindLeft!.rotation.z = 0;
  joints.hindRight!.rotation.z = 0;
  joints.rig!.position.y = breath(seconds, phase, bobAmplitude);
}

export function poseSit(
  joints: SpeciesJoints,
  seconds: number,
  phase: number,
  bobAmplitude: number,
): void {
  joints.foreLeft!.rotation.z = SIT_TUCK_RADIANS;
  joints.foreRight!.rotation.z = SIT_TUCK_RADIANS;
  joints.hindLeft!.rotation.z = SIT_TUCK_RADIANS;
  joints.hindRight!.rotation.z = SIT_TUCK_RADIANS;
  const hipY = Math.min(joints.foreLeft!.position.y, joints.hindLeft!.position.y);
  const drop = hipY * (1 - Math.cos(SIT_TUCK_RADIANS)) * joints.rig!.scale.y;
  joints.rig!.position.y = -drop + breath(seconds, phase, bobAmplitude);
}

interface LeapKey {
  readonly at: number;
  readonly fore: number;
  readonly hind: number;
  readonly lift: number;
}

const LEAP_CYCLE: readonly LeapKey[] = [
  { at: 0, fore: 0.35, hind: -0.25, lift: 0 },
  { at: 0.2, fore: 0.15, hind: -0.1, lift: -1 },
  { at: 0.42, fore: 1.5, hind: -0.95, lift: 2.4 },
  { at: 0.7, fore: 1, hind: -0.35, lift: 3 },
  { at: 1, fore: 0.35, hind: -0.25, lift: 0 },
];

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

const FALL_FLAIL_HZ = 4;
const FALL_LEG_SPLAY_RADIANS = 0.7;
const FALL_FLAIL_RADIANS = 0.35;

export function poseLeap(
  joints: SpeciesJoints,
  seconds: number,
  phase: number,
  bobAmplitude: number,
  secondsPerLeap: number,
): void {
  const cycles = seconds / secondsPerLeap + phase / TWO_PI;
  const u = cycles - Math.floor(cycles);

  let previous = LEAP_CYCLE[0]!;
  let next = LEAP_CYCLE[LEAP_CYCLE.length - 1]!;
  for (let i = 1; i < LEAP_CYCLE.length; i++) {
    if (u <= LEAP_CYCLE[i]!.at) {
      previous = LEAP_CYCLE[i - 1]!;
      next = LEAP_CYCLE[i]!;
      break;
    }
  }
  const span = next.at - previous.at;
  const t = span <= 0 ? 0 : smoothstep((u - previous.at) / span);
  const fore = previous.fore + (next.fore - previous.fore) * t;
  const hind = previous.hind + (next.hind - previous.hind) * t;
  const lift = previous.lift + (next.lift - previous.lift) * t;

  joints.foreLeft!.rotation.z = fore;
  joints.foreRight!.rotation.z = fore;
  joints.hindLeft!.rotation.z = hind;
  joints.hindRight!.rotation.z = hind;
  joints.rig!.position.y = lift * bobAmplitude;
}

export function poseFall(joints: SpeciesJoints, seconds: number, phase: number): void {
  const flail = Math.sin(seconds * FALL_FLAIL_HZ * TWO_PI + phase) * FALL_FLAIL_RADIANS;
  joints.foreLeft!.rotation.z = FALL_LEG_SPLAY_RADIANS + flail;
  joints.foreRight!.rotation.z = FALL_LEG_SPLAY_RADIANS - flail;
  joints.hindLeft!.rotation.z = -FALL_LEG_SPLAY_RADIANS - flail;
  joints.hindRight!.rotation.z = -FALL_LEG_SPLAY_RADIANS + flail;
  joints.rig!.position.y = 0;
}

const TWO_PI = Math.PI * 2;
