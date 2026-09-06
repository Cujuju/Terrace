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
/**
 * How far up into the leg tip the hoof is seated, as a fraction of the hoof's
 * height. Butted end to end, the leg's bottom cap and the hoof's top cap share
 * one plane and z-fight; seated inside the (wider) tapering leg, the join is
 * hidden and cannot open under float error. The hoof is lengthened by the same
 * amount so its sole still meets the ground.
 */
const HOOF_SEAT_FRACTION = 0.1;

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
    // The haunch rides the hinge too, so the thigh swings with the leg.
    // Seated a little above the hinge, so most of the mass sits inside the
    // body and only the lower curve of the thigh shows.
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

// ── The wall gaits ─────────────────────────────────────────────────────────
// A quadruped that climbs (the ibex — @terrace/shared's climb.ts and the
// species' own `climb` rule) is drawn scrambling, not walking up a cliff.
// Positive Z lifts a hanging leg forward, toward the rock it is facing.

/**
 * Scrambles per second on the wall.
 *
 * 1.2 — faster than either biped climber (the peep's 0.75, the yeti's 0.5) and
 * deliberately so: a goat on a crag takes short quick placements where a
 * primate takes long deliberate reaches, and that difference is most of what
 * makes it read as a goat. Against the shipped climb (CLIMB_SECONDS_PER_BAND,
 * 4 s) it is five placements per band.
 */
const CLIMB_SCRAMBLE_HZ = 1.2;

/**
 * How far a scrambling leg reaches up the rock, and how far the one bearing
 * weight stays extended, in radians from hanging straight down.
 *
 * A quadruped's reach is SHORTER than a biped's (the peep's 2.4): its limbs
 * carry it rather than pull it, so the pose is a body pressed against the face
 * with the legs gathered under it — anything more reads as a bear.
 */
const CLIMB_LEG_HIGH_RADIANS = 1.1;
const CLIMB_LEG_LOW_RADIANS = 0.25;

/**
 * A fall: legs splayed and flailing at a rate nothing else here uses, because
 * the drop is eight times the climb (climb.ts's FALL_DROP_HEIGHT_UNITS_PER_
 * SECOND) and a fall that reads as a controlled descent is the one thing it
 * must not look like.
 */
const FALL_FLAIL_HZ = 4;
const FALL_LEG_SPLAY_RADIANS = 0.7;
const FALL_FLAIL_RADIANS = 0.35;

/**
 * Poses the four legs and the body for one instant of a CLIMB.
 *
 * DRIVEN BY THE CLOCK, not by ground covered: a climber's x/y are pinned at the
 * foot of the wall for the whole ascent, so there is no distance to pace off —
 * and the ascent runs at a fixed rate anyway. `phase` stays the individual's
 * offset along that clock. `bobAmplitude` is the walk's, and
 * the pull uses it directly: a climbing body heaves at the same scale it bobs.
 */
export function poseClimb(
  joints: SpeciesJoints,
  seconds: number,
  phase: number,
  bobAmplitude: number,
): void {
  // The phase offset is still the individual's: two goats on the same face must
  // not scramble in lockstep, and it is what makes the herd's pose slots hold
  // 32 different instants of the climb rather than 32 copies of one.
  const scramble = Math.sin(seconds * CLIMB_SCRAMBLE_HZ * TWO_PI + phase);
  const mid = (CLIMB_LEG_HIGH_RADIANS + CLIMB_LEG_LOW_RADIANS) / 2;
  const span = (CLIMB_LEG_HIGH_RADIANS - CLIMB_LEG_LOW_RADIANS) / 2;
  // The same diagonal pairs the walk uses — three feet on the rock at a time.
  joints.foreLeft!.rotation.z = mid + scramble * span;
  joints.hindRight!.rotation.z = mid + scramble * span;
  joints.foreRight!.rotation.z = mid - scramble * span;
  joints.hindLeft!.rotation.z = mid - scramble * span;
  joints.rig!.position.y = Math.abs(scramble) * bobAmplitude;
}

/** Poses the four legs and the body for one instant of a FALL: nothing holds. */
export function poseFall(joints: SpeciesJoints, seconds: number, phase: number): void {
  const flail = Math.sin(seconds * FALL_FLAIL_HZ * TWO_PI + phase) * FALL_FLAIL_RADIANS;
  // Fore legs thrown forward, hind legs back — the splay of a body with
  // nothing under it.
  joints.foreLeft!.rotation.z = FALL_LEG_SPLAY_RADIANS + flail;
  joints.foreRight!.rotation.z = FALL_LEG_SPLAY_RADIANS - flail;
  joints.hindLeft!.rotation.z = -FALL_LEG_SPLAY_RADIANS - flail;
  joints.hindRight!.rotation.z = -FALL_LEG_SPLAY_RADIANS + flail;
  // Nothing is bearing weight, so nothing bobs.
  joints.rig!.position.y = 0;
}

/** One full turn, the unit every cycle above is written in. */
const TWO_PI = Math.PI * 2;
