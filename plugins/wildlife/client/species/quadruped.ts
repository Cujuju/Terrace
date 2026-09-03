// What every four-legged walker in this directory shares: the legs, the hinge
// per leg, and the walk cycle that swings them.
//
// A leg is a Group AT THE HIP (or shoulder) with the tapered limb hanging under
// it, so rotating the Group swings the whole leg from the joint — the same
// pivot-per-hinge recipe the bird's wings and the fish's tail use. The model
// faces +X, so Z is the axis a leg swings fore-and-aft about.
//
// THE GAIT is a walk: diagonal pairs move together (front-left with back-right),
// which is what a walking ungulate does and what stops a model reading as a
// hobby-horse. The body bobs twice per stride, once per pair of legs landing.
import { Group, type Material, type Object3D } from 'three';
import { limb, smoothEllipsoid } from './bodyKit.ts';
import type { SpeciesJoints, SpeciesModelPool } from './speciesModel.ts';

export interface QuadrupedLegSpec {
  /** Hip/shoulder height above the feet (the leg's length). */
  readonly hipY: number;
  /** Fore and hind hip stations along the body. */
  readonly foreX: number;
  readonly hindX: number;
  /** Half the stance width. */
  readonly halfStance: number;
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly radialSegments: number;
  readonly heightSegments: number;
  /** A darker hoof at the tip, this tall, or 0 for none. */
  readonly hoofHeight: number;
  /**
   * The muscle mass over each joint — a haunch on the hind legs, a shoulder on
   * the fore — as an ellipsoid's full extents (length, height, width), or null
   * for a leg that goes straight into the body.
   */
  readonly haunch: readonly [number, number, number] | null;
}

/** The four leg hinges, named the way an animation reads them. */
export interface QuadrupedLegs {
  readonly foreLeft: Object3D;
  readonly foreRight: Object3D;
  readonly hindLeft: Object3D;
  readonly hindRight: Object3D;
}

/** Radial segments a hoof needs: it is a stub seen from above, never close. */
const HOOF_RADIAL_SEGMENTS = 8;
const HAUNCH_SEGMENTS = 8;
/** How far up its own height a haunch's centre sits above the hinge. */
const HAUNCH_SEAT_FRACTION = 0.25;

/** Builds four legs under `rig` and returns their hinges. */
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
      length: spec.hoofHeight,
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
    // The haunch rides the hinge too, so the thigh swings with the leg.
    // Seated a little above the hinge, so most of the mass sits inside the
    // body and only the lower curve of the thigh shows.
    if (haunchGeometry) hinge.add(pool.part(haunchGeometry, haunchMaterial, 0, spec.haunch![1] * HAUNCH_SEAT_FRACTION, 0));
    hinge.add(pool.part(legGeometry, legMaterial, 0, 0, 0));
    if (hoofGeometry) hinge.add(pool.part(hoofGeometry, hoofMaterial, 0, -legLength, 0));
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

/** The joint names `addQuadrupedLegs` returns, for a species' `joints` map. */
export function legJoints(legs: QuadrupedLegs): Record<string, Object3D> {
  return {
    foreLeft: legs.foreLeft,
    foreRight: legs.foreRight,
    hindLeft: legs.hindLeft,
    hindRight: legs.hindRight,
  };
}

/**
 * Poses the four legs and the body for one instant of a walk.
 *
 * `beat` is the stride phase in radians (one full turn per stride);
 * `swingRadians` is how far a leg swings either side of vertical;
 * `bobAmplitude` is how far the body rises at each footfall pair.
 */
export function poseWalk(
  joints: SpeciesJoints,
  beat: number,
  swingRadians: number,
  bobAmplitude: number,
): void {
  const swing = Math.sin(beat) * swingRadians;
  // Diagonal pairs: fore-left with hind-right, fore-right with hind-left.
  joints.foreLeft!.rotation.z = swing;
  joints.hindRight!.rotation.z = swing;
  joints.foreRight!.rotation.z = -swing;
  joints.hindLeft!.rotation.z = -swing;
  // Two rises per stride: |sin| peaks at each pair's footfall.
  joints.rig!.position.y = Math.abs(Math.sin(beat)) * bobAmplitude;
}
