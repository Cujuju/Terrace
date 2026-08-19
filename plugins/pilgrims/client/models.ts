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
const LEG_SWING_RADIANS = 0.55;

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

  const rudyTorso = keep(new BoxGeometry(0.17, 0.24, 0.2)); // stocky
  const unoTorso = keep(new BoxGeometry(0.14, 0.26, 0.15)); // slender
  const rudyHead = keep(new BoxGeometry(0.14, 0.13, 0.15));
  const unoHead = keep(new BoxGeometry(0.12, 0.12, 0.12));
  const rudySnout = keep(new BoxGeometry(0.08, 0.05, 0.07));
  const unoMuzzle = keep(new BoxGeometry(0.04, 0.035, 0.05));

  // Rudy ears hang: origin at the top edge so a Z-rotation drapes them.
  const rudyEar = keep(new BoxGeometry(0.03, 0.11, 0.06));
  rudyEar.translate(0, -0.055, 0);
  // Uno ears stand: cones, origin at the base.
  const unoEar = keep(new ConeGeometry(0.032, 0.09, 4));
  unoEar.translate(0, 0.045, 0);

  // Tails pivot where they meet the body (origin at the near end).
  const rudyTail = keep(new BoxGeometry(0.1, 0.035, 0.035));
  rudyTail.translate(-0.05, 0, 0);
  const unoTail = keep(new BoxGeometry(0.16, 0.025, 0.025));
  unoTail.translate(-0.08, 0, 0);

  const staffGeometry = keep(new CylinderGeometry(0.012, 0.012, 0.5, 5));

  const rudyTunicMaterial = lambert(RUDY_TUNIC_COLOR);
  const rudyFurMaterial = lambert(RUDY_FUR_COLOR);
  const rudyEarMaterial = lambert(RUDY_EAR_COLOR);
  const unoTunicMaterial = lambert(UNO_TUNIC_COLOR);
  const unoFurMaterial = lambert(UNO_FUR_COLOR);
  const unoEarMaterial = lambert(UNO_EAR_COLOR);
  const staffMaterial = lambert(STAFF_COLOR);

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
    const torsoHeight = rudy ? 0.24 : 0.26;
    const torsoCentreY = hipY + torsoHeight / 2 - 0.02;
    const headY = hipY + torsoHeight + 0.05;

    const leftLeg = new Mesh(legGeometry, fur);
    leftLeg.position.set(0, hipY, -0.05);
    const rightLeg = new Mesh(legGeometry, fur);
    rightLeg.position.set(0, hipY, 0.05);
    root.add(leftLeg, rightLeg);

    const torso = new Mesh(rudy ? rudyTorso : unoTorso, tunic);
    torso.position.set(0, torsoCentreY, 0);
    body.add(torso);

    const head = new Mesh(rudy ? rudyHead : unoHead, fur);
    head.position.set(0.02, headY, 0);
    body.add(head);

    const snout = new Mesh(rudy ? rudySnout : unoMuzzle, fur);
    snout.position.set(rudy ? 0.1 : 0.07, headY - 0.02, 0);
    body.add(snout);

    const earMaterial = rudy ? rudyEarMaterial : unoEarMaterial;
    const leftEar = new Mesh(rudy ? rudyEar : unoEar, earMaterial);
    const rightEar = new Mesh(rudy ? rudyEar : unoEar, earMaterial);
    if (rudy) {
      // Draped from the head's sides, splayed outward.
      leftEar.position.set(0, headY + 0.055, -0.08);
      leftEar.rotation.x = 0.5;
      rightEar.position.set(0, headY + 0.055, 0.08);
      rightEar.rotation.x = -0.5;
    } else {
      // Standing on the head's top corners.
      leftEar.position.set(0, headY + 0.06, -0.04);
      rightEar.position.set(0, headY + 0.06, 0.04);
    }
    body.add(leftEar, rightEar);

    const tail = new Mesh(rudy ? rudyTail : unoTail, fur);
    tail.position.set(rudy ? -0.09 : -0.08, torsoCentreY + (rudy ? 0.08 : 0.11), 0);
    tail.rotation.z = rudy ? 0.7 : 0.5; // both carried raised — travellers in good spirits
    body.add(tail);

    const staff = new Mesh(staffGeometry, staffMaterial);
    staff.position.set(0.05, hipY + 0.13, rudy ? 0.13 : 0.11);
    staff.rotation.x = 0.08; // planted a touch outward, walking-stick style
    body.add(staff);

    return {
      root,
      animate(seconds: number, phase: number): void {
        const stride = Math.sin(seconds * TWO_PI * STRIDE_HZ + phase);
        leftLeg.rotation.z = stride * LEG_SWING_RADIANS;
        rightLeg.rotation.z = -stride * LEG_SWING_RADIANS;
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
