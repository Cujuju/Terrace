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

// ── The ground gaits ───────────────────────────────────────────────────────
// A stopped animal is NOT a walk cycle that has stopped advancing (owner,
// 2026-09-06). A walker's beat is the ground it covers, so a stopped one froze
// mid-stride with a foot in the air; standing and sitting are poses of their
// own. Which one it is in is the server's answer — @terrace/shared's stance.ts.

/**
 * Breaths per second while standing or sitting.
 *
 * 0.25 — fifteen a minute, a resting mammal. It is the ONE clock term a stopped
 * quadruped gets, and it exists because a body held perfectly still for eight
 * seconds reads as a frozen frame rather than as an animal at rest.
 */
const REST_BREATH_HZ = 0.25;

/** How big a breath is against a footfall's bob: a third of it. */
const BREATH_TO_BOB_RATIO = 1 / 3;

/**
 * How far a couched animal folds its legs under itself, radians from hanging.
 *
 * 1.2 (~69°) FOLDS RATHER THAN SPLAYS. The fore legs tuck BACK and the hind
 * legs FORWARD, so both pairs come in under the belly the way a bedded ungulate
 * carries them; a quarter turn would lay them flat out in front, which is a
 * dead animal, and half of this would read as a crouch about to spring.
 */
const SIT_TUCK_RADIANS = 1.2;

/** Only ever upward: a body may not sink into the ground it was placed on. */
function breath(seconds: number, phase: number, bobAmplitude: number): number {
  const cycle = (1 - Math.cos(seconds * REST_BREATH_HZ * TWO_PI + phase)) / 2;
  return cycle * bobAmplitude * BREATH_TO_BOB_RATIO;
}

/** Poses the four legs and the body STANDING: weight on all four, breathing. */
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

/**
 * Poses the four legs and the body COUCHED: legs folded under, belly down.
 *
 * THE DROP IS MEASURED OFF THE RIG, NOT GIVEN. A leg hinge sits at the hip and
 * its foot reaches the ground, so the hinge's own height IS the leg's length —
 * and a leg folded by `SIT_TUCK_RADIANS` lifts its foot by `hipY (1 - cos)`.
 * Lowering the body by exactly that puts the feet back where they were. It is
 * read from the rig rather than passed in because the two asset species'
 * skeletons come out of a .glb and have no authored spec to state it.
 *
 * THROUGH THE RIG'S OWN SCALE, and that is not a detail: a hinge's height is in
 * RIG space and `rig.position` is in its PARENT's, so a species that scales its
 * rig (bison.ts's BISON_SCALE, ibex.ts's IBEX_SCALE) would be dropped by its
 * unscaled leg length and buried to the shoulders. Measured on the bison
 * before this factor was here: 0.41 world units of drop against a 0.54-unit
 * animal.
 *
 * THE SHORTEST LEG DECIDES, so nothing is driven through the ground: a species
 * whose shoulders and hips differ leaves the taller pair's feet a hair above
 * it, which is the same direction of error the bob is written to make.
 */
export function poseSit(
  joints: SpeciesJoints,
  seconds: number,
  phase: number,
  bobAmplitude: number,
): void {
  // Fore legs back and hind legs forward: both pairs come in under the belly.
  joints.foreLeft!.rotation.z = -SIT_TUCK_RADIANS;
  joints.foreRight!.rotation.z = -SIT_TUCK_RADIANS;
  joints.hindLeft!.rotation.z = SIT_TUCK_RADIANS;
  joints.hindRight!.rotation.z = SIT_TUCK_RADIANS;
  const hipY = Math.min(joints.foreLeft!.position.y, joints.hindLeft!.position.y);
  const drop = hipY * (1 - Math.cos(SIT_TUCK_RADIANS)) * joints.rig!.scale.y;
  joints.rig!.position.y = -drop + breath(seconds, phase, bobAmplitude);
}

// ── The wall gaits ─────────────────────────────────────────────────────────
// A quadruped that climbs (the ibex — @terrace/shared's climb.ts and the
// species' own `climb` rule) is drawn scrambling, not walking up a cliff.
// Positive Z lifts a hanging leg forward, toward the rock it is facing.

/**
 * THE IBEX DOES NOT SCRAMBLE, IT LEAPS (owner, 2026-09-06: "Ibex are known for
 * being incredible jumpers, so let's do a proper jumping motion as they go
 * across the bands"). What was here before was a hand-over-hand scramble at
 * 1.2 placements a second, which is a goat climbing like a small bear.
 *
 * ONE LEAP PER BAND, and the cycle length is passed in rather than stated here
 * so it is the ascent's own rate: the ibex rises a band in
 * IBEX_CLIMB_SECONDS_PER_BAND (../../protocol.ts, the same figure its server
 * climb rule carries), and a leap that did not fill exactly that would drift
 * against the height every band.
 */

/**
 * One leap, as the four instants that define it. `at` is the fraction of the
 * cycle, `fore`/`hind` are leg rotations in radians from hanging straight down
 * (positive lifts a leg forward, toward the rock), and `lift` is the body's
 * rise in multiples of the walk's own bob — a leap heaves several times what a
 * footfall does, which is what separates the two silhouettes.
 *
 * BOTH LEGS OF A PAIR MOVE TOGETHER, unlike every other gait here, and that is
 * the whole read: a bound is symmetric where a walk is diagonal.
 */
interface LeapKey {
  readonly at: number;
  readonly fore: number;
  readonly hind: number;
  readonly lift: number;
}

const LEAP_CYCLE: readonly LeapKey[] = [
  // Gathered on the ledge, weight back, about to go.
  { at: 0, fore: 0.35, hind: -0.25, lift: 0 },
  // COIL: everything folded under a body dropped below its standing height.
  { at: 0.2, fore: 0.15, hind: -0.1, lift: -1 },
  // DRIVE: hind legs straight out behind, forelegs thrown up at the next ledge.
  { at: 0.42, fore: 1.5, hind: -0.95, lift: 2.4 },
  // FLIGHT: tucked at the top of the arc, nothing touching rock.
  { at: 0.7, fore: 1, hind: -0.35, lift: 3 },
  // LAND, which is the gather again — one band higher.
  { at: 1, fore: 0.35, hind: -0.25, lift: 0 },
];

/** Smooth in and out of every keyframe, so no joint changes direction abruptly. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

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
 * Poses the four legs and the body for one instant of a LEAP up the wall.
 *
 * DRIVEN BY THE CLOCK against a cycle exactly one band long: a climber's x/y are
 * pinned at the face and its height rises at a fixed rate, so the cycle and the
 * ascent stay in step for free — the animal lands on each band edge at the same
 * instant of the pose. `phase` stays the individual's offset, so two goats on
 * one face are never in lockstep and the herd's pose palette holds real
 * different instants rather than copies of one.
 *
 * `bobAmplitude` is the walk's own, and the lifts above are multiples of it: a
 * re-proportioned ibex leaps at the same scale it walks.
 */
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
