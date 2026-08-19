// Low-poly pilgrim folk: RUDYS (little dog people) and UNOS (cat people).
//
// Same construction discipline as wildlife's creatures: shared geometries and
// materials built once, per-pilgrim Meshes referencing them, boxes and cones
// with flatShading so the chunky read matches everything else in the world.
// Models face +X (the repo-wide convention); the caller positions and yaws
// the root and drives `animate`.
//
// SILHOUETTE OVER DETAIL. At gameplay zoom a pilgrim is ~15 px tall, so the
// races must separate by OUTLINE, not texture: a Rudy is stocky with floppy
// ears, a broad snout and an up-curled wagging tail; an Uno is slender with
// tall triangular ears, a short muzzle and a long raised tail that sways
// rather than wags. Both carry the same pilgrim staff — the one prop that
// says "journey" at any distance. Tunic colours echo the district tints the
// structures plugin paints their home towns with (its RACE_TINTS), so a
// pilgrim on the road visibly belongs to the architecture it came from.

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  type BufferGeometry,
} from 'three';
import type { SettlerRace } from '../protocol.ts';

/** Overall height, world units — a little person: knee-high to a yeti. */
export const PILGRIM_HEIGHT = 0.62;

/**
 * Stride frequency at the shipped walk speed, cycles per second.
 *
 * 1.6 — small legs step quickly: at 0.5 cells/s and this cadence each stride
 * covers ~0.31 cells, which reads as bustling-but-unhurried on a body this
 * size (a 1:1 stride-to-height ratio, roughly a human walk scaled down).
 */
export const STRIDE_HZ = 1.6;

const TWO_PI = Math.PI * 2;

/** Peak leg swing, radians, either side of vertical. */
const LEG_SWING_RADIANS = 0.35;

/** Peak arm swing — counter-phase to the legs, a touch smaller. */
const ARM_SWING_RADIANS = 0.25;

/** Body bob amplitude, world units — a hair; more reads as hopping. */
const BOB_AMPLITUDE = 0.012;

/** Rudy tail wag: fast and wide. Uno tail sway: slow and slight. */
const RUDY_WAG_RADIANS = 0.45;
const UNO_SWAY_RADIANS = 0.14;

// Palettes. Tunics echo structures' district tints (warm hearth / cool
// moonlit); fur and details stay in the same temperature family.
const RUDY_TUNIC_COLOR = 0xb5713a;
const RUDY_FUR_COLOR = 0xa9834f;
const RUDY_EAR_COLOR = 0x7c5a33;
const UNO_TUNIC_COLOR = 0x5a6b8c;
const UNO_FUR_COLOR = 0x9aa0ad;
const UNO_EAR_COLOR = 0x6e7480;
const STAFF_COLOR = 0x6b4a2b;
const EYE_COLOR = 0x241d15;

export interface PilgrimModel {
  /** Positioned and yawed by the caller; never touched by `animate`. */
  readonly root: Group;
  /** `seconds` is elapsed time; `phase` a per-pilgrim offset in radians. */
  animate(seconds: number, phase: number): void;
}

export interface PilgrimModels {
  create(race: SettlerRace): PilgrimModel;
  dispose(): void;
}

export function createPilgrimModels(): PilgrimModels {
  const geometries: BufferGeometry[] = [];
  const materials: MeshLambertMaterial[] = [];

  function keep<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function lambert(color: number): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color, flatShading: true });
    materials.push(material);
    return material;
  }

  // ── Shared resources, built once ───────────────────────────────────────────
  // Legs pivot at the hip: the geometry is shifted so its TOP sits at the
  // mesh origin, and the mesh is placed at hip height — rotation about Z then
  // swings the leg forward/back (+X is forward) about the hip for free.
  const legGeometry = keep(new BoxGeometry(0.055, 0.17, 0.055));
  legGeometry.translate(0, -0.085, 0);

  // Arms pivot at the shoulder, same trick as the legs.
  const armGeometry = keep(new BoxGeometry(0.04, 0.14, 0.04));
  armGeometry.translate(0, -0.07, 0);

  const rudyTorso = keep(new BoxGeometry(0.17, 0.22, 0.2)); // stocky
  const unoTorso = keep(new BoxGeometry(0.14, 0.24, 0.15)); // slender
  const rudyHead = keep(new BoxGeometry(0.14, 0.13, 0.15));
  const unoHead = keep(new BoxGeometry(0.12, 0.12, 0.12));
  const rudySnout = keep(new BoxGeometry(0.08, 0.05, 0.07));
  const unoMuzzle = keep(new BoxGeometry(0.04, 0.035, 0.05));

  // Eyes: two dark studs on the face — the single cheapest thing that makes
  // a box with ears read as a PERSON at preview distance.
  const eyeGeometry = keep(new BoxGeometry(0.012, 0.022, 0.022));

  // Rudy ears hang from the head's SIDES: origin at the top edge so an
  // X-rotation drapes them outward, never over the face.
  const rudyEar = keep(new BoxGeometry(0.03, 0.1, 0.05));
  rudyEar.translate(0, -0.05, 0);
  // Uno ears stand on the head's top corners: cones, origin at the base.
  const unoEar = keep(new ConeGeometry(0.026, 0.075, 4));
  unoEar.translate(0, 0.0375, 0);

  // Tails pivot where they meet the body (origin at the near end), LOW on the
  // rear — at shoulder height a tail reads as a third arm from any angle.
  const rudyTail = keep(new BoxGeometry(0.09, 0.035, 0.035));
  rudyTail.translate(-0.045, 0, 0);
  const unoTail = keep(new BoxGeometry(0.15, 0.022, 0.022));
  unoTail.translate(-0.075, 0, 0);

  const staffGeometry = keep(new CylinderGeometry(0.012, 0.012, 0.5, 5));

  const rudyTunicMaterial = lambert(RUDY_TUNIC_COLOR);
  const rudyFurMaterial = lambert(RUDY_FUR_COLOR);
  const rudyEarMaterial = lambert(RUDY_EAR_COLOR);
  const unoTunicMaterial = lambert(UNO_TUNIC_COLOR);
  const unoFurMaterial = lambert(UNO_FUR_COLOR);
  const unoEarMaterial = lambert(UNO_EAR_COLOR);
  const staffMaterial = lambert(STAFF_COLOR);
  const eyeMaterial = lambert(EYE_COLOR);

  function create(race: SettlerRace): PilgrimModel {
    const rudy = race === 'rudy';
    const tunic = rudy ? rudyTunicMaterial : unoTunicMaterial;
    const fur = rudy ? rudyFurMaterial : unoFurMaterial;

    const root = new Group();
    root.name = `pilgrims:${race}`;

    // The bobbing body carries everything but the legs, so the bob never
    // lifts the feet off the ground.
    const body = new Group();
    root.add(body);

    const hipY = 0.17;
    const torsoHeight = rudy ? 0.22 : 0.24;
    const torsoCentreY = hipY + torsoHeight / 2 - 0.02;
    const shoulderY = torsoCentreY + torsoHeight / 2 - 0.02;
    const torsoHalfWidth = (rudy ? 0.2 : 0.15) / 2;
    const headY = hipY + torsoHeight + 0.05;
    const headHalfDepth = (rudy ? 0.15 : 0.12) / 2;
    const faceX = rudy ? 0.14 / 2 : 0.12 / 2; // the head's front plane (+X)

    const leftLeg = new Mesh(legGeometry, fur);
    leftLeg.position.set(0, hipY, -0.05);
    const rightLeg = new Mesh(legGeometry, fur);
    rightLeg.position.set(0, hipY, 0.05);
    root.add(leftLeg, rightLeg);

    const torso = new Mesh(rudy ? rudyTorso : unoTorso, tunic);
    torso.position.set(0, torsoCentreY, 0);
    body.add(torso);

    // Arms hang from the shoulders, just outside the tunic; the right hand is
    // the staff hand, so the staff is parented to THAT arm and swings with it.
    const leftArm = new Mesh(armGeometry, fur);
    leftArm.position.set(0, shoulderY, -(torsoHalfWidth + 0.025));
    const rightArm = new Mesh(armGeometry, fur);
    rightArm.position.set(0, shoulderY, torsoHalfWidth + 0.025);
    body.add(leftArm, rightArm);

    const staff = new Mesh(staffGeometry, staffMaterial);
    // In the arm's own frame: at the hand (the arm's low end), standing tall.
    staff.position.set(0.05, -0.1, 0.03);
    rightArm.add(staff);

    const head = new Mesh(rudy ? rudyHead : unoHead, fur);
    head.position.set(0.02, headY, 0);
    body.add(head);

    const snout = new Mesh(rudy ? rudySnout : unoMuzzle, fur);
    snout.position.set(0.02 + faceX + (rudy ? 0.03 : 0.015), headY - 0.02, 0);
    body.add(snout);

    const leftEye = new Mesh(eyeGeometry, eyeMaterial);
    leftEye.position.set(0.02 + faceX + 0.002, headY + 0.025, -0.035);
    const rightEye = new Mesh(eyeGeometry, eyeMaterial);
    rightEye.position.set(0.02 + faceX + 0.002, headY + 0.025, 0.035);
    body.add(leftEye, rightEye);

    const earMaterial = rudy ? rudyEarMaterial : unoEarMaterial;
    const leftEar = new Mesh(rudy ? rudyEar : unoEar, earMaterial);
    const rightEar = new Mesh(rudy ? rudyEar : unoEar, earMaterial);
    if (rudy) {
      // Hung from the head's top SIDE edges, draped outward — never over the
      // face (review round 1: draping forward covered it).
      leftEar.position.set(0.02, headY + 0.05, -(headHalfDepth + 0.005));
      leftEar.rotation.x = -0.45;
      rightEar.position.set(0.02, headY + 0.05, headHalfDepth + 0.005);
      rightEar.rotation.x = 0.45;
    } else {
      // Standing on the head's top corners, spread wide enough that a side
      // view shows TWO ears, not one party hat (review round 1).
      leftEar.position.set(0.02, headY + 0.058, -0.045);
      leftEar.rotation.x = -0.15;
      rightEar.position.set(0.02, headY + 0.058, 0.045);
      rightEar.rotation.x = 0.15;
    }
    body.add(leftEar, rightEar);

    // Low on the rear (review round 1: at shoulder height it reads as a third
    // arm). Rudy's short tail curls steeply up; Uno's long tail sweeps back.
    const tail = new Mesh(rudy ? rudyTail : unoTail, fur);
    tail.position.set(-(rudy ? 0.085 : 0.07), hipY + 0.06, 0);
    tail.rotation.z = rudy ? 0.9 : 0.35;
    body.add(tail);

    return {
      root,
      animate(seconds: number, phase: number): void {
        const stride = Math.sin(seconds * TWO_PI * STRIDE_HZ + phase);
        leftLeg.rotation.z = stride * LEG_SWING_RADIANS;
        rightLeg.rotation.z = -stride * LEG_SWING_RADIANS;
        // Arms counter-swing their own side's leg — the natural gait.
        leftArm.rotation.z = -stride * ARM_SWING_RADIANS;
        rightArm.rotation.z = stride * ARM_SWING_RADIANS;
        // Two footfalls per stride cycle → the bob runs at double frequency.
        body.position.y = Math.abs(stride) * BOB_AMPLITUDE;
        if (rudy) {
          tail.rotation.y = Math.sin(seconds * TWO_PI * STRIDE_HZ * 2 + phase) * RUDY_WAG_RADIANS;
        } else {
          tail.rotation.y = Math.sin(seconds * TWO_PI * (STRIDE_HZ / 3) + phase) * UNO_SWAY_RADIANS;
        }
      },
    };
  }

  return {
    create,
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
