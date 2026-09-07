// Rudys (dog people) and Unos (cat people), matching the owner-approved concept
// (artifact d6cf5ca4, decision 2026-08-19): chibi ~1:2 head-to-body proportions
// with SMOOTH normals — the one family of models deliberately not blocky.
//
// The glossy bits (wet eyes and nose) are a separate specular surface;
// everything else is matte Lambert merged into one — two draw calls per walker.
//
// Silhouette wins at distance: a Rudy is round and tan with floppy ears and an
// up-curled wagging tail; an Uno is slimmer and slate with tall pointed ears and
// a long swaying tail. Collars echo structures' district tints.

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
// Reached by path, the same way wildlife/client/models.ts reaches it.
import type { MoverGait } from '../../../client/src/plugins/kit/moverGait.ts';
import { applyMoverBodyTilt } from '../../../client/src/plugins/kit/moverBodyTilt.ts';
import { bakeRig, instantiateRig, type RigBlueprint } from '../../../client/src/render/rigSkin.ts';
import { SETTLER_RACES, WALKER_KINDS, type SettlerRace, type WalkerKind } from '../protocol.ts';

/**
 * Every literal in this file is measured against it. Nothing is drawn at this
 * size — see PILGRIM_MODEL_SCALE.
 */
const PILGRIM_AUTHORED_HEIGHT = 0.62;

/**
 * Owner, 2026-09-05: peeps 15% smaller. Applied to the INSTANCE ROOT, not by
 * re-measuring geometry — the bake is shared per (race, kind), so one scale
 * leaves the authored numbers meaning what they say.
 */
export const PILGRIM_MODEL_SCALE = 0.85;

/** Overall height AS DRAWN, world units — a little person: knee-high to a yeti. */
export const PILGRIM_HEIGHT = PILGRIM_AUTHORED_HEIGHT * PILGRIM_MODEL_SCALE;

/**
 * 1.6 — small legs step quickly: at 0.5 cells/s each stride covers ~0.31 cells,
 * which reads as bustling-but-unhurried on a body this size (a 1:1
 * stride-to-height ratio, roughly a human walk scaled down).
 */
export const STRIDE_HZ = 1.6;

const TWO_PI = Math.PI * 2;

/** Peak leg swing, radians, either side of vertical. */
export const LEG_SWING_RADIANS = 0.35;

/** Peak arm swing — counter-phase to the legs, a touch smaller. */
export const ARM_SWING_RADIANS = 0.25;

/** Body bob amplitude, world units — a hair; more reads as hopping. */
const BOB_AMPLITUDE = 0.012;

/**
 * Also the LEG'S OWN LENGTH: the leg geometry is shifted so its top sits at the
 * pivot and its foot reaches the ground, so one number states both. `poseSit` is
 * nothing but that identity used twice.
 */
const WALKER_HIP_HEIGHT_WORLD_UNITS = 0.1;

// A stopped walker is NOT a stalled walk cycle (owner, 2026-09-06: "if they're
// not walking ... they should look like they are standing in place. And if they
// haven't moved for a while, then they should sit").
//
// Which of the three is the server's answer, not a guess from the position
// stream — @terrace/shared's stance.ts.

/**
 * 0.25 — fifteen a minute, a resting mammal. The ONE clock term a standing
 * walker gets: a body held perfectly still for eight seconds reads as a frozen
 * frame rather than a peep waiting.
 */
const STAND_BREATH_HZ = 0.25;

/** How far the breath lifts the trunk: a third of a footfall's bob. */
const STAND_BREATH_WORLD_UNITS = BOB_AMPLITUDE / 3;

/**
 * A right angle exactly, the same statement as the hips going to zero: a quarter
 * turn forward lays the leg flat and drops the hip precisely where the foot was.
 * Nothing floats or sinks if the walker is re-proportioned.
 */
const SIT_LEG_RADIANS = Math.PI / 2;

/**
 * A little BEHIND vertical; negative is backwards on this rig. A body on the
 * ground props itself, and arms hanging dead straight read as a puppet set down
 * rather than as someone sitting.
 */
const SIT_ARM_RADIANS = -0.3;

// A climb and a fall are POSES, not speeds (owner, 2026-09-05, on the shipped
// climb: a peep rose up a cliff playing its walk cycle).
//
// Both run off the CLOCK, not ground covered: a climber's x/y are pinned at the
// foot of the wall for the whole ascent (@terrace/shared's climb.ts), and the
// ascent is at a fixed rate — which is what makes a clock honest here.
//
// Every limb angle is about Z, the axis the walk already swings on: the models
// face +X, so a positive rotation lifts a hanging limb forward, and π puts it
// straight overhead.

/**
 * 0.75 — one hand over the other every 1.33 s, three reaches per band of wall
 * (CLIMB_SECONDS_PER_BAND, 4 s). Fewer reads as sliding up on stiff arms; more
 * reads as scrabbling, which is the fall's register and must stay its own.
 */
const CLIMB_REACH_HZ = 0.75;

/**
 * The high arm is PAST vertical (π/2 is straight forward, π straight up): 2.4 is
 * up and into the wall, where a hand takes a hold. The low arm bears the weight,
 * still bent well up in front of the chest.
 */
const CLIMB_ARM_HIGH_RADIANS = 2.4;
const CLIMB_ARM_LOW_RADIANS = 1.4;

/** The same, for the legs: a high knee finding a foothold, the other extended. */
const CLIMB_LEG_HIGH_RADIANS = 0.95;
const CLIMB_LEG_LOW_RADIANS = 0.2;

/**
 * Three times the walk's bob: a pull-up is the whole body moving where a footfall
 * is a hip. Small in absolute terms — the climb itself supplies the rise, and
 * this only has to say the rise is being WORKED for.
 */
const CLIMB_PULL_WORLD_UNITS = BOB_AMPLITUDE * 3;

/**
 * 2.9 is very nearly straight up — unmistakable against the climb's 2.4, and the
 * flail is the fastest motion this model has (4 Hz vs the walk's 1.6). A fall
 * reading as a controlled descent is the one thing it must not look like.
 */
const FALL_ARM_RADIANS = 2.9;
const FALL_FLAIL_HZ = 4;
const FALL_FLAIL_RADIANS = 0.3;
/** Legs part fore and aft as they lose the wall. */
const FALL_LEG_SPREAD_RADIANS = 0.5;

/**
 * Both are fixed at author time, so neither can be a per-instance parameter.
 *
 * Taken from the protocol, never restated: a local copy could bake no blueprint
 * for a newly added race, crashing the first walker of that race to arrive.
 */
const BLUEPRINT_KINDS = WALKER_KINDS;
const BLUEPRINT_RACES = SETTLER_RACES;

/** Rudy tail wag: fast and wide. Uno tail sway: slow and slight. */
const RUDY_WAG_RADIANS = 0.45;
const UNO_SWAY_RADIANS = 0.14;

// From the approved concept stills. Collar hues echo structures' RACE_TINTS
// temperature families: warm hearth for Rudy, cool moonlit for Uno.
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
/** Oiled canvas, a shade warmer than the staff's wood so the two props never read as one object at distance. */
const BUNDLE_COLOR = 0x9c7f52;
const BUNDLE_STRAP_COLOR = 0x5c4630;

export interface PilgrimModel {
  /** Positioned and yawed by the caller; never touched by `animate`. */
  readonly root: Group;
  /** The animated bones, exposed so tests (and only tests) can pin the gait. */
  readonly joints: WalkerJoints;
  /**
   * `phase` is a per-pilgrim offset in radians; `gait` comes from the server's
   * climb and stance fields. Defaults to 'walk' so a caller with nothing to
   * report — and every test written before the wall gaits — keeps its answers.
   */
  animate(seconds: number, phase: number, gait?: MoverGait): void;
  /**
   * Frees what THIS walker allocated; shared geometry and materials belong to
   * PilgrimModels.dispose. Call on despawn — removing the root from the scene
   * does not free the skeleton's bone texture.
   */
  dispose(): void;
}

export interface PilgrimModels {
  /** `kind` decides the PROPS alone — body, gait and palette are the race's. Defaults to 'pilgrim' for old callers. */
  create(race: SettlerRace, kind?: WalkerKind): PilgrimModel;
  dispose(): void;
}

/**
 * Named joints rather than positional, for the reason wildlife/models.ts gives:
 * a bake that reordered its nodes would otherwise silently swap limbs.
 */
interface WalkerRig {
  readonly blueprint: RigBlueprint;
  readonly jointIndices: Readonly<Record<string, number>>;
}

interface WalkerJoints {
  /**
   * The whole walker as one bone, legs included. The gait's body tilt goes here;
   * no pose below writes it.
   */
  readonly rigRoot: Bone;
  readonly body: Bone;
  readonly leftLeg: Bone;
  readonly rightLeg: Bone;
  readonly leftArm: Bone;
  readonly rightArm: Bone;
  readonly tail: Bone;
  /**
   * A JOINT, not just a part: the staff's vertices bind to its own bone, and
   * collapsing that bone is what stows it. Null on the kinds carrying no staff.
   */
  readonly staff: Bone | null;
}

/**
 * Lets same-material parts merge into one draw call. `new Color(hex)` already
 * converts sRGB to the working colour space — converting again double-darkens
 * the part (round 1's coats came out chocolate, not tan).
 */
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

/** The merge only fails if attribute sets diverge, which would be a programming error. */
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

/**
 * Written by EVERY pose, so no pose can inherit half of another's. Only the sit
 * moves them, and only because a body on the ground has nothing to stand on.
 */
function setHipHeight(joints: WalkerJoints, y: number): void {
  joints.leftLeg.position.y = y;
  joints.rightLeg.position.y = y;
}

/** Free functions, not branches inside `animate`, so a climb reads as a pose rather than a set of exceptions to a walk. */
function poseWalk(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  // Bone extends Object3D, so these are the pre-skinning rig's own transforms.
  const stride = Math.sin(seconds * TWO_PI * STRIDE_HZ + phase);
  joints.leftLeg.rotation.z = stride * LEG_SWING_RADIANS;
  joints.rightLeg.rotation.z = -stride * LEG_SWING_RADIANS;
  // Arms counter-swing their own side's leg — the natural gait.
  joints.leftArm.rotation.z = -stride * ARM_SWING_RADIANS;
  joints.rightArm.rotation.z = stride * ARM_SWING_RADIANS;
  // Two footfalls per stride cycle → the bob runs at double frequency.
  joints.body.position.y = Math.abs(stride) * BOB_AMPLITUDE;
}

/**
 * `phase` offsets the breath so a crowd standing in a square is not a row of
 * metronomes — the same job it does in the walk.
 */
function poseStand(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  joints.leftLeg.rotation.z = 0;
  joints.rightLeg.rotation.z = 0;
  joints.leftArm.rotation.z = 0;
  joints.rightArm.rotation.z = 0;
  // (1 - cos)/2 runs 0…1, so the breath only ever LIFTS: a walker standing on
  // the ground the client just placed it on may not sink into it.
  const breath = (1 - Math.cos(seconds * TWO_PI * STAND_BREATH_HZ + phase)) / 2;
  joints.body.position.y = breath * STAND_BREATH_WORLD_UNITS;
}

/** Legs out front along the ground, hips on it, arms propping. */
function poseSit(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, 0);
  joints.leftLeg.rotation.z = SIT_LEG_RADIANS;
  joints.rightLeg.rotation.z = SIT_LEG_RADIANS;
  joints.leftArm.rotation.z = SIT_ARM_RADIANS;
  joints.rightArm.rotation.z = SIT_ARM_RADIANS;
  // Still breathing, and still only upward — but from the hips, which are now
  // the ground.
  const breath = (1 - Math.cos(seconds * TWO_PI * STAND_BREATH_HZ + phase)) / 2;
  joints.body.position.y = -WALKER_HIP_HEIGHT_WORLD_UNITS + breath * STAND_BREATH_WORLD_UNITS;
}

/** Hand over hand up the wall: one side reaching while the other bears weight. */
function poseClimb(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  const reach = Math.sin(seconds * TWO_PI * CLIMB_REACH_HZ + phase);
  // `reach` runs -1…1; map it onto the low…high span so each limb spends half
  // the cycle reaching and half anchored, and the two sides are opposite.
  const high = (CLIMB_ARM_HIGH_RADIANS + CLIMB_ARM_LOW_RADIANS) / 2;
  const armSpan = (CLIMB_ARM_HIGH_RADIANS - CLIMB_ARM_LOW_RADIANS) / 2;
  joints.leftArm.rotation.z = high + reach * armSpan;
  joints.rightArm.rotation.z = high - reach * armSpan;
  const knee = (CLIMB_LEG_HIGH_RADIANS + CLIMB_LEG_LOW_RADIANS) / 2;
  const legSpan = (CLIMB_LEG_HIGH_RADIANS - CLIMB_LEG_LOW_RADIANS) / 2;
  // Legs follow the OPPOSITE arm: the diagonal that keeps three points on the
  // rock, which is how anything with four limbs climbs.
  joints.leftLeg.rotation.z = knee - reach * legSpan;
  joints.rightLeg.rotation.z = knee + reach * legSpan;
  // One pull per reach, so the body rises with the arm that is pulling.
  joints.body.position.y = Math.abs(reach) * CLIMB_PULL_WORLD_UNITS;
}

/**
 * Carried on the ground, STOWED on the wall (owner, 2026-09-06): both hands are
 * on the rock during a climb, and a walker that has let go of the rock has let
 * go of the staff with it.
 *
 * Scale, not `visible`: the merge leaves no per-part mesh to hide, and
 * collapsing the bone rasterises nothing without splitting the draw call.
 */
const STAFF_CARRIED_SCALE = 1;
const STAFF_STOWED_SCALE = 0;

function setStaffCarried(joints: WalkerJoints, carried: boolean): void {
  joints.staff?.scale.setScalar(carried ? STAFF_CARRIED_SCALE : STAFF_STOWED_SCALE);
}

/** Let go: arms overhead, legs parted, everything flailing. */
function poseFall(joints: WalkerJoints, seconds: number, phase: number): void {
  setHipHeight(joints, WALKER_HIP_HEIGHT_WORLD_UNITS);
  const flail = Math.sin(seconds * TWO_PI * FALL_FLAIL_HZ + phase) * FALL_FLAIL_RADIANS;
  joints.leftArm.rotation.z = FALL_ARM_RADIANS + flail;
  joints.rightArm.rotation.z = FALL_ARM_RADIANS - flail;
  joints.leftLeg.rotation.z = FALL_LEG_SPREAD_RADIANS + flail;
  joints.rightLeg.rotation.z = -FALL_LEG_SPREAD_RADIANS + flail;
  // Nothing is bearing weight, so nothing bobs.
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

  // Both read their colour from the merged geometry's vertex colors, and both
  // are lit by the world's existing rig — no new lights, no shadow maps.
  const bodyMaterial = new MeshLambertMaterial({ vertexColors: true });
  const glossMaterial = new MeshPhongMaterial({
    vertexColors: true,
    shininess: 90,
    specular: 0x777777,
  });
  materials.push(bodyMaterial, glossMaterial);

  // Limbs pivot at the hip/shoulder: geometry shifted so its TOP sits at the mesh
  // origin, mesh placed at joint height, so rotation about Z swings the limb
  // forward and back. Capsules give smooth normals for free.
  const legGeometry = keep(new CapsuleGeometry(0.034, 0.052, 6, 16));
  legGeometry.translate(0, -0.048, 0);
  const armGeometry = keep(new CapsuleGeometry(0.028, 0.07, 6, 16));
  armGeometry.translate(0, -0.058, 0);

  const staffGeometry = keep(new CylinderGeometry(0.012, 0.012, 0.5, 12));

  // A capsule lying across the shoulders, not a box: it must read as soft goods
  // from any angle, at a fraction of the vertices a bag with a flap would take.
  // The strap is the one detail keeping it from looking stuck on.
  const bundleGeometry = keep(new CapsuleGeometry(0.052, 0.09, 6, 14));
  bundleGeometry.rotateX(Math.PI / 2);
  const bundleStrapGeometry = keep(new TorusGeometry(0.058, 0.008, 6, 16));

  const staffMaterial = matte(STAFF_COLOR);
  const bundleMaterial = matte(BUNDLE_COLOR);
  const bundleStrapMaterial = matte(BUNDLE_STRAP_COLOR);
  const rudyFurMaterial = matte(RUDY_COAT_COLOR);
  const unoFurMaterial = matte(UNO_COAT_COLOR);

  // Baked in place, feet at y=0 and +X forward. The egg body overlaps the head so
  // no neck seam shows; belly and muzzle bulge through the coat as smaller inset
  // spheres — the concept's two-tone mask without a texture.
  const rudyBody = keep(
    mergePainted([
      // coat: egg torso
      [new SphereGeometry(0.125, 24, 18).scale(0.95, 1.2, 1).translate(0, 0.2, 0), RUDY_COAT_COLOR],
      // cream belly, bulging forward-low through the coat
      [new SphereGeometry(0.105, 20, 14).scale(0.85, 1.05, 0.9).translate(0.045, 0.185, 0), RUDY_CREAM_COLOR],
      // head — the chibi half of the 1:2 ratio
      [new SphereGeometry(0.155, 28, 20).scale(1, 0.95, 1).translate(0.01, 0.46, 0), RUDY_COAT_COLOR],
      // broad cream muzzle
      [new SphereGeometry(0.07, 20, 14).scale(1.15, 0.75, 0.95).translate(0.145, 0.415, 0), RUDY_CREAM_COLOR],
      // floppy ears, draped well outward so they frame the face (round 1: small
      // nubs on top read as a bear, not a dog)
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
      // collar + hanging tag
      [new TorusGeometry(0.082, 0.013, 10, 24).rotateX(Math.PI / 2).translate(0.005, 0.345, 0), RUDY_COLLAR_COLOR],
      [new SphereGeometry(0.016, 10, 8).translate(0.09, 0.322, 0), TAG_COLOR],
    ]),
  );
  // Glossy bits: eyes + nose. Separate merge, single specular material.
  const rudyGloss = keep(
    mergePainted([
      [new SphereGeometry(0.026, 14, 12).translate(0.135, 0.49, -0.056), EYE_COLOR],
      [new SphereGeometry(0.026, 14, 12).translate(0.135, 0.49, 0.056), EYE_COLOR],
      [new SphereGeometry(0.023, 12, 10).scale(1.1, 0.85, 1).translate(0.218, 0.432, 0), RUDY_NOSE_COLOR],
    ]),
  );
  // A torus arc with its BASE at the mesh origin and base tangent vertical: the
  // circle's centre sits directly behind the base (translate −r), so the arc
  // rises from the pivot and bows back over the rump.
  const rudyTail = keep(
    new TorusGeometry(0.05, 0.021, 10, 16, 2.1).translate(-0.05, 0, 0),
  );

  const unoBody = keep(
    mergePainted([
      // coat: slimmer egg
      [new SphereGeometry(0.115, 24, 18).scale(0.85, 1.25, 0.9).translate(0, 0.2, 0), UNO_COAT_COLOR],
      // cream chest
      [new SphereGeometry(0.095, 20, 14).scale(0.8, 1.1, 0.85).translate(0.04, 0.19, 0), UNO_CREAM_COLOR],
      // rounder, slightly smaller head
      [new SphereGeometry(0.145, 28, 20).translate(0.01, 0.465, 0), UNO_COAT_COLOR],
      // short cream muzzle
      [new SphereGeometry(0.055, 18, 12).scale(1, 0.72, 0.95).translate(0.135, 0.42, 0), UNO_CREAM_COLOR],
      // tall pointed ears, spread wide and tilted outward — round 1 had them
      // centred and rear, which read as one wizard hat from the side
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
      // collar + tag
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
  // Same base-at-origin construction as Rudy's, wider and thinner — a
  // question-mark sweep up and back.
  const unoTail = keep(
    new TorusGeometry(0.1, 0.015, 10, 20, 2.0).translate(-0.1, 0, 0),
  );

  /**
   * A Group per joint, a Mesh per part. Every node `animate()` writes to must be
   * captured as a joint index HERE, at author time — after the bake the authored
   * nodes are inert data.
   */
  function bakeWalker(race: SettlerRace, kind: WalkerKind): WalkerRig {
    const rudy = race === 'rudy';
    const fur = rudy ? rudyFurMaterial : unoFurMaterial;

    const root = new Group();
    root.name = `pilgrims:${kind}:${race}`;

    // The bobbing body carries everything but the legs, so the bob never
    // lifts the feet off the ground.
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

    // Arms hang from the shoulders, just outside the coat; the right hand is
    // the staff hand, so the staff is parented to THAT arm and swings with it.
    const leftArm = new Mesh(armGeometry, fur);
    leftArm.position.set(0, shoulderY, -shoulderZ);
    const rightArm = new Mesh(armGeometry, fur);
    rightArm.position.set(0, shoulderY, shoulderZ);
    body.add(leftArm, rightArm);

    // The kinds' single visual distinguisher: a pilgrim has the staff of a long
    // journey, a settler its household on its back and both paws free, a
    // wanderer nothing at all.
    let staff: Mesh | null = null;
    if (kind === 'pilgrim') {
      staff = new Mesh(staffGeometry, staffMaterial);
      // The arm's own frame, seated IN the paw — round 2 had it floating a
      // visible gap outside the hand.
      staff.position.set(0.045, -0.105, 0.012);
      rightArm.add(staff);
    } else if (kind === 'settler') {
      // Parented to the BODY, not an arm: a pack rides the trunk, so it bobs
      // with the walk instead of swinging with a limb.
      const bundle = new Mesh(bundleGeometry, bundleMaterial);
      bundle.position.set(-0.075, 0.235, 0);
      const strap = new Mesh(bundleStrapGeometry, bundleStrapMaterial);
      // Round the roll, standing in the walker's own vertical plane.
      strap.position.set(-0.075, 0.235, 0);
      strap.rotation.y = Math.PI / 2;
      body.add(bundle, strap);
    }

    // LOW on the rear: at shoulder height a tail reads as a third arm from any
    // angle (hard-learned).
    const tail = new Mesh(rudy ? rudyTail : unoTail, fur);
    tail.position.set(rudy ? -0.12 : -0.1, rudy ? 0.16 : 0.13, 0);
    body.add(tail);

    // Bake at the identity transform, unparented — see bakeRig's contract.
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

  // Both race and kind are fixed at author time, so each pair gets its own bake
  // rather than trying to make one rig cover both.
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
    // Belt and suspenders: the loop above walks the protocol's own lists, so
    // every wire-carryable pair has a rig. If that stops being true, fail naming
    // the pair rather than dereferencing undefined several frames later.
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
    // The one place the drawn size is set. ../client/index.ts writes position and
    // yaw on this same node and never touches scale.
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
        // The staff is in the paw on the GROUND — standing and sitting
        // included — and stowed on the wall. See setStaffCarried.
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
      // The baked rigs own buffers of their own, on top of the authored pool the
      // two loops below free.
      for (const rig of walkerRigs.values()) rig.blueprint.dispose();
      walkerRigs.clear();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
