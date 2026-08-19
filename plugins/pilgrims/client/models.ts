// High-resolution pilgrim folk: RUDYS (little dog people) and UNOS (cat
// people), matching the owner-approved concept (artifact d6cf5ca4, decision
// 2026-08-19): chibi ~1:2 head-to-body proportions, soft rounded forms with
// SMOOTH normals — the one family of models in the world that is deliberately
// not blocky. The environment stays flat-shaded; these little people are lit
// by the same hemisphere + sun rig as everything else, their smoothness comes
// from curved geometry and smooth shading, not from any lighting change.
//
// CONSTRUCTION. Every static part of a race's body (coat, cream mask, muzzle,
// ears, collar, tag base) is baked into ONE merged, vertex-colored geometry
// per race, built once and shared by every instance — so a whole pilgrim is
// eight draw calls: merged body, merged glossy bits (eyes + nose), two legs,
// two arms, tail, staff. The glossy bits are a separate merge because they
// carry the model's single specular material (dark wet eyes and nose are what
// make a soft face read as alive); everything else is matte Lambert. Animated
// parts (legs, arms, tail) stay their own meshes because they rotate at
// joints, exactly like the previous low-poly rig — the animate() contract and
// the gait constants are unchanged, this is a model swap, not a behaviour
// change.
//
// SILHOUETTE STILL WINS AT DISTANCE: a Rudy is round and tan with floppy ears
// and an up-curled wagging tail; an Uno is slimmer and slate with tall
// pointed ears and a long swaying tail. Collars echo the district tints the
// structures plugin paints their home towns with (warm hearth / cool
// moonlit), same as the old tunics did.

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
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

// ── Palettes, from the approved concept stills ─────────────────────────────
// Rudy: russet/tan coat over a cream muzzle-and-belly mask, warm collar.
// Uno: slate-grey coat over a cream chest, cool collar. Collar hues echo
// structures' RACE_TINTS temperature families.
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

/**
 * Bakes a solid vertex color onto a geometry so same-material parts can merge
 * into one draw call. `new Color(hex)` already converts the sRGB hex into the
 * renderer's working color space (three r152+ color management) — converting
 * again here double-darkens every merged part, which is exactly how round 1's
 * coats came out chocolate instead of tan while the plain-material limbs
 * stayed correct. Store the managed color as-is.
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

/** Merge helper: paints, merges, and asserts the merge succeeded (it only
 *  fails if attribute sets diverge, which would be a programming error). */
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

  // ── Shared resources, built once ─────────────────────────────────────────
  // The matte body material reads its color from the merged geometry's vertex
  // colors; the glossy material does the same for eyes vs nose. Both are lit
  // by the world's existing rig — no new lights, no shadow maps.
  const bodyMaterial = new MeshLambertMaterial({ vertexColors: true });
  const glossMaterial = new MeshPhongMaterial({
    vertexColors: true,
    shininess: 90,
    specular: 0x777777,
  });
  materials.push(bodyMaterial, glossMaterial);

  // Limbs pivot at the hip/shoulder: geometry shifted so its TOP sits at the
  // mesh origin, mesh placed at joint height — rotation about Z then swings
  // the limb forward/back (+X is forward), exactly the old rig's trick.
  // Capsules give rounded stubby chibi limbs with smooth normals for free.
  const legGeometry = keep(new CapsuleGeometry(0.034, 0.052, 6, 16));
  legGeometry.translate(0, -0.048, 0);
  const armGeometry = keep(new CapsuleGeometry(0.028, 0.07, 6, 16));
  armGeometry.translate(0, -0.058, 0);

  const staffGeometry = keep(new CylinderGeometry(0.012, 0.012, 0.5, 12));

  const staffMaterial = matte(STAFF_COLOR);
  const rudyFurMaterial = matte(RUDY_COAT_COLOR);
  const unoFurMaterial = matte(UNO_COAT_COLOR);

  // ── Rudy: static body, one merged vertex-colored geometry ────────────────
  // Baked in place (feet at y=0, +X forward). The egg body overlaps the big
  // head so no neck seam shows; the cream belly and muzzle bulge through the
  // coat as slightly smaller inset spheres — the concept's two-tone mask
  // without any texture.
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
      // floppy ears: long flattened spheres hung from the head's top sides,
      // draped well outward so they frame the face (round 1: small nubs on
      // top read as a bear, not a dog)
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
  // Up-curled wagging tail: a torus arc with its BASE at the mesh origin and
  // base tangent vertical — the circle's centre sits directly behind the base
  // (translate −r), so the arc rises from the pivot and bows back over the
  // rump. rotation.y at the pivot then wags it side to side.
  const rudyTail = keep(
    new TorusGeometry(0.05, 0.021, 10, 16, 2.1).translate(-0.05, 0, 0),
  );

  // ── Uno: same construction, feline proportions ────────────────────────────
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
      // tall pointed ears on the head's top FRONT corners, spread wide and
      // tilted outward — round 1 had them centred and rear, which read as one
      // wizard hat from the side
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
  // Long swaying tail: same base-at-origin construction as Rudy's, wider and
  // thinner — a question-mark sweep up and back.
  const unoTail = keep(
    new TorusGeometry(0.1, 0.015, 10, 20, 2.0).translate(-0.1, 0, 0),
  );

  function create(race: SettlerRace): PilgrimModel {
    const rudy = race === 'rudy';
    const fur = rudy ? rudyFurMaterial : unoFurMaterial;

    const root = new Group();
    root.name = `pilgrims:${race}`;

    // The bobbing body carries everything but the legs, so the bob never
    // lifts the feet off the ground.
    const body = new Group();
    root.add(body);

    const hipY = 0.1;
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

    const staff = new Mesh(staffGeometry, staffMaterial);
    // In the arm's own frame: seated IN the paw (the arm's low end) — round 2
    // had it floating a visible gap outside the hand.
    staff.position.set(0.045, -0.105, 0.012);
    rightArm.add(staff);

    // Tail pivots where it meets the body — LOW on the rear (at shoulder
    // height a tail reads as a third arm from any angle; hard-learned).
    const tail = new Mesh(rudy ? rudyTail : unoTail, fur);
    tail.position.set(rudy ? -0.12 : -0.1, rudy ? 0.16 : 0.13, 0);
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
