// The yeti, built procedurally — FOUR of him since 2026-08-26, and this file
// builds whichever one the server rolled.
//
// WHAT THIS FILE OWNS AND WHAT IT DOES NOT. ./yeti-anatomy.ts owns the ANIMAL:
// four specs, and a `yetiParts` that turns one into the list of masses, limbs
// and swept tapers a body is made of, already in world units and already in
// each joint's own space. This file owns the RENDERING of that list — which
// material a surface takes, how finely each class of part is tessellated, how
// the rig is hung, and how it moves. Neither half restates a number the other
// has: the bounds the server steers by are solved over the same part list this
// file builds, which is the only arrangement under which a footprint is a fact
// rather than a hope.
//
// HIS COAT IS FUR IN THREE WAYS, and each does something the others cannot:
//   * a CARVE, which breaks the silhouette at mass scale (a dozen dents across
//     his chest — see YETI_FUR_WRINKLE_DEPTH);
//   * a SHADE TILE, sampled triplanar, which puts hundreds of strands on the
//     lit surface where geometry could never afford them (geometry.ts,
//     furShadeTexture);
//   * and, since 2026-08-26, three FUR SHELLS — the furred masses drawn again,
//     pushed outward about their own centres, with the strand tile cutting most
//     of each copy away (geometry.ts, furStrandAlphaTexture). Owner: the first
//     two leave the animal ending at a smooth ellipsoid edge, and the EDGE is
//     the one thing a white animal on white snow is read by.
//
// Same rules and same tools as the other two builders (./geometry.ts): no
// external assets, no per-model lights, no Math.random anywhere in the geometry,
// shared resources freed exactly once.
//
// THE RIG, top to bottom:
//
//   root          — placed and yawed by index.ts; never touched by animate()
//    └ rig        — the bob rides here, and it only ever LIFTS
//       ├ leg k: joint at the hip (rotation.z is the stride)
//       │          ├ haunch + thigh + shin
//       │          └ ankle (counter-rotated, so the sole stays flat) → foot
//       └ upper   — the lean rides here, so no foot can ever be rolled into the
//          │        ground the client placed him on
//          ├ body                           (static, rig space)
//          ├ head (rotation.y is the scan)  → skull, brow, face, horns, fangs
//          └ arm k: joint at the shoulder (rotation.z is the counter-swing)
//                     ├ upper arm + forearm
//                     └ the hand
//
// COST, MEASURED at MONSTER_MODEL_DETAIL = 4 rather than estimated
// (`node --experimental-strip-types` over the built geometry, summing index
// counts — see the note at the bottom of this header):
//
//   silverback  145 828 triangles      ram      144 072
//   ibex        141 384                fanged   144 072
//
// in SIX draw calls, up from three and from the 79 896 of the single body that
// stood here before. MOST OF THE RISE IS THE SHELLS AND THE PART COUNT, not the
// resolution: these bodies are seventy-odd masses, limbs and tapers where the
// old one was thirty, and each furred one of them is drawn four times. The
// per-class counts below came DOWN from the old file's to pay for it, and the
// first thing measured when they did was the joint balls — sixteen of them at
// the limbs' own tessellation, entirely buried, were a sixth of the animal. THE THREE NEW CALLS ARE THE SHELLS: a layer differs from
// its neighbours in a shader constant (its alpha threshold), and a material
// whose SHADER differs cannot be drawn with one whose does not — see
// rigSkin.ts, materialSignature. The other three are what they always were: the
// furred surfaces, the hard ones (hide, horn, ivory, maw, glint) and the eyes,
// which emit.
//
// IT IS AFFORDABLE FOR ONE REASON AND THE REASON SHOULD BE CHECKED BEFORE IT IS
// SPENT AGAIN: MAX_LIVING_MONSTERS_PER_KIND is 1. There is never more than one
// of these in a world, and the shells are tessellated at a FRACTION of the base
// surface's counts (SHELL_DETAIL_FRACTION) because a layer that is mostly
// discarded fragments does not need the roundness the skin under it does.

// Render kit, reached the same way client/src/plugins/registry.ts reaches this
// plugin — by path. See that module's header for why it lives there.
import { bakeRig, instantiateRig } from '../../../client/src/render/rigSkin.ts';
import type { YetiVariant } from '../protocol.ts';
import { CatmullRomCurve3, Color, Group, Mesh, Vector3, type BufferGeometry } from 'three';
import {
  TWO_PI,
  ellipsoid,
  taperedTube,
  type ModelWorkshop,
  type MonsterModel,
  type SkinFinish,
} from './geometry.ts';
import {
  YETI_BOB_CELLS,
  YETI_EYE_COLOR,
  YETI_EYE_EMISSIVE,
  YETI_FUR_TEXTURE_FREQUENCY,
  YETI_FUR_WRINKLE_DEPTH,
  YETI_GLINT_COLOR,
  YETI_HEAD_SCAN_HZ,
  YETI_HEAD_SCAN_RADIANS,
  YETI_IVORY_COLOR,
  YETI_LEAN_RADIANS,
  YETI_MAW_COLOR,
  YETI_NOSE_COLOR,
  YETI_SHADE_FREQUENCY,
  YETI_SHADE_VARIATION,
  YETI_SHELL_STRAND_FACTOR,
  YETI_SHELL_UNDERTINT_STRENGTH,
  YETI_SKIN_WRINKLE_DEPTH,
  YETI_VARIANT_METRICS,
  YETI_VARIANT_SPECS,
  YETI_WRINKLE_FREQUENCY,
  yetiHornColor,
  yetiWorldParts,
  type YetiPart,
  type YetiPartSize,
  type YetiPoint,
  type YetiSurface,
} from './yeti-anatomy.ts';

/**
 * Base tessellations, in segments at detail 1, by the CLASS of part rather than
 * by the part: ./yeti-anatomy.ts tags each mass with what it is (a trunk, a
 * skull, a feature on a face, a limb, a digit, a horn) and the counts live here,
 * because how fine a model is drawn is a rendering decision and how it is shaped
 * is not.
 *
 * The counts are chosen by what each class has to hold. A trunk and a skull are
 * broad curved profiles that ARE the silhouette and need both axes; a feature on
 * the face is small but looked at directly; a digit is never seen end-on and
 * needs neither. Affordable at all only because MAX_LIVING_MONSTERS_PER_KIND
 * is 1.
 */
const MASS_SEGMENTS: Readonly<Record<YetiPartSize, { segments: number; rings: number }>> = {
  trunk: { segments: 12, rings: 9 },
  head: { segments: 15, rings: 11 },
  feature: { segments: 8, rings: 6 },
  limb: { segments: 8, rings: 7 },
  // A joint ball is INSIDE the limb it closes — none of it is silhouette, and
  // the only thing it has to do is leave no gap at a bend. It was drawn at the
  // limb's own count until it was measured: sixteen of them at forty segments
  // apiece was a sixth of the animal's triangles, all of it buried.
  joint: { segments: 6, rings: 5 },
  digit: { segments: 6, rings: 5 },
  horn: { segments: 8, rings: 6 },
};

/**
 * Swept parts: along the sweep, and around it.
 *
 * A HORN is the one part whose PATH count matters as much as its radial one: it
 * is a long, strongly curved taper seen against the sky from every angle, and
 * too few segments along the sweep turn the curve into two straight pieces with
 * a kink — the single most obvious way a horn reads as a prop. A limb needs
 * RADIAL segments most (thirty-two sides to a leg, not eight); a finger needs
 * neither.
 */
const SWEEP_SEGMENTS: Readonly<Record<YetiPartSize, { path: number; radial: number }>> = {
  trunk: { path: 6, radial: 10 },
  head: { path: 6, radial: 10 },
  feature: { path: 4, radial: 8 },
  limb: { path: 5, radial: 9 },
  joint: { path: 4, radial: 8 },
  digit: { path: 2, radial: 4 },
  horn: { path: 10, radial: 8 },
};

/**
 * How finely a shell layer is tessellated against the surface it stands over.
 *
 * A shell is mostly discarded fragments and carries no silhouette of its own —
 * what a viewer sees of it is a scatter of strand tips — so the roundness the
 * skin under it needs would be spent on an edge that is never drawn. Half the
 * segments on each axis is a quarter of the triangles per layer, which is what
 * makes three layers affordable at all.
 */
const SHELL_DETAIL_FRACTION = 0.5;

/** The two sides, in a fixed order. +1 is the model's left (+Z). */
const SIDES = [1, -1] as const;

/** This creature's skin, at a given carve depth. See cthulhu.ts for the shape. */
function yetiSkin(wrinkleDepth: number): SkinFinish {
  return {
    wrinkleDepth,
    wrinkleFrequency: YETI_WRINKLE_FREQUENCY,
    shadeVariation: YETI_SHADE_VARIATION,
    shadeFrequency: YETI_SHADE_FREQUENCY,
  };
}

/**
 * Which surfaces are FUR — the ones that take the coat's shade tile, the fur
 * carve, and shells.
 */
const FURRED_SURFACES: ReadonlySet<YetiSurface> = new Set<YetiSurface>(['coat', 'saddle']);

/**
 * Builds every variant's geometry and returns ONE CONSTRUCTOR PER VARIANT.
 *
 * Everything expensive happens ONCE, when the plugin attaches: the returned
 * functions only assemble Meshes over geometries that already exist.
 *
 * A RECORD RATHER THAN A FUNCTION TAKING A VARIANT, because the variants differ
 * in their GEOMETRY, and geometry is built here, at attach — a `create(variant)`
 * would either branch inside the per-instance path (paying the choice on every
 * summon) or hide four blueprints behind one signature. A total record over
 * YetiVariant also makes the compiler the thing that notices a fifth variant, at
 * the one place that has to answer for it.
 *
 * ALL FOUR ARE BUILT AT ATTACH, not on first sight of one, for the reason
 * models.ts gives for building every kind up front: the alternative trades a
 * fixed invisible cost at load for a visible hitch at the exact moment a monster
 * arrives, and only one of the four is ever alive at a time.
 */
export function createYetiFactory(
  workshop: ModelWorkshop,
): Readonly<Record<YetiVariant, () => MonsterModel>> {
  return {
    silverback: buildVariant(workshop, 'silverback'),
    ram: buildVariant(workshop, 'ram'),
    ibex: buildVariant(workshop, 'ibex'),
    fanged: buildVariant(workshop, 'fanged'),
  };
}

/** Where a part's meshes hang: one of the six animated groups. */
type PartTarget = 'upper' | 'head' | 'legLeft' | 'legRight' | 'armLeft' | 'armRight' | 'ankleLeft' | 'ankleRight';

function targetOf(part: YetiPart): PartTarget {
  const left = part.side >= 0;
  if (part.joint === 'leg') return left ? 'legLeft' : 'legRight';
  if (part.joint === 'ankle') return left ? 'ankleLeft' : 'ankleRight';
  if (part.joint === 'arm') return left ? 'armLeft' : 'armRight';
  return part.joint;
}

/** A point on the animal, in three's frame: forward is +X, lateral is +Z. */
function vector(at: YetiPoint): Vector3 {
  return new Vector3(at.forward, at.height, at.lateral);
}

/**
 * Builds ONE variant and returns its constructor.
 *
 * The whole body is authored, baked and thrown away here; what survives is the
 * blueprint and the joint indices the animation drives.
 */
function buildVariant(workshop: ModelWorkshop, variant: YetiVariant): () => MonsterModel {
  const { segments, lambert, shellMaterial, organicSurface } = workshop;
  const spec = YETI_VARIANT_SPECS[variant];
  const metrics = YETI_VARIANT_METRICS[variant];
  const body = yetiWorldParts(variant);

  // ── Materials ──────────────────────────────────────────────────────────────
  //
  // BOTH FURRED TONES SAMPLE THE ONE TILE, so they still merge into a single
  // draw call (rigSkin.ts keys the merge on texture identity and on the injected
  // shader, both of which are shared here) while each keeps its own colour. The
  // tile is a SHADE multiplier, so "pale saddle over a charcoal coat" survives
  // it untouched.
  const furOptions = { furFrequency: YETI_FUR_TEXTURE_FREQUENCY };
  const materials: Readonly<Record<YetiSurface, ReturnType<typeof lambert>>> = {
    coat: lambert(spec.coat, furOptions),
    saddle: lambert(spec.saddle === 0 ? spec.coat : spec.saddle, furOptions),
    hide: lambert(spec.skin),
    face: lambert(spec.faceColor),
    nose: lambert(YETI_NOSE_COLOR),
    maw: lambert(YETI_MAW_COLOR),
    horn: lambert(yetiHornColor(spec.horns)),
    ivory: lambert(YETI_IVORY_COLOR),
    // The glint takes the IVORY material rather than one of its own: it is a
    // four-pixel bead, and a material for it would be a seventh draw call for
    // two of them. Ivory in daylight beside a black socket is a catchlight.
    glint: lambert(YETI_GLINT_COLOR),
    /**
     * LIT, with a trace of emission under it — unlike the two sea kinds', whose
     * eyes are unshaded because they ARE lamps burning in dark water. This one
     * is a wet eye in daylight: an unshaded sphere renders as a flat disc of
     * solid colour whatever its geometry, which on a face this close is the
     * difference between an eye and a sticker.
     */
    eye: lambert(YETI_EYE_COLOR, { emissive: YETI_EYE_EMISSIVE }),
  };

  /**
   * A shell layer's material, cached per (colour, layer).
   *
   * THE INNER LAYERS ARE DARKER, and that is the shell trick that makes a coat
   * read as deep rather than as a fuzzy outline: the bottom of a pile is in its
   * own shadow. The tint is the variant's under-tint, and how far each layer is
   * pulled towards it falls off outward, so the tips are the coat's own colour.
   */
  const shellMaterials = new Map<string, ReturnType<typeof shellMaterial>>();
  const shellMaterialFor = (color: number, layer: number, layers: number) => {
    const key = `${color}|${layer}`;
    const existing = shellMaterials.get(key);
    if (existing !== undefined) return existing;
    const tinted = new Color(color).lerp(
      new Color(spec.underTint),
      (1 - layer / layers) * YETI_SHELL_UNDERTINT_STRENGTH,
    );
    const made = shellMaterial(
      tinted.getHex(),
      layer,
      layers,
      YETI_FUR_TEXTURE_FREQUENCY * YETI_SHELL_STRAND_FACTOR,
    );
    shellMaterials.set(key, made);
    return made;
  };

  // ── Skins ──────────────────────────────────────────────────────────────────
  //
  // THE CARVE IS PER VARIANT, through its own shag: the silverback's coat is
  // short and close, the ram's and the fanged one's are deeper. It is the same
  // surface at four depths, not four surfaces.
  const furSkin = yetiSkin(YETI_FUR_WRINKLE_DEPTH * spec.shag);
  /** Bare skin: the face plate, the nose, the hands and the feet. A shallower
   *  carve — hide, not fur. */
  const bareSkin = yetiSkin(YETI_SKIN_WRINKLE_DEPTH);
  /**
   * Parts that must keep their exact shape: the horns, the fangs, the eyes and
   * — above all — the FEET, whose soles are the surface the client's placement
   * maths puts on the ground.
   */
  const smoothSkin = yetiSkin(0);
  /**
   * The shells take no carve at all. A carve may only ever push INWARD, and a
   * shell that dented would open holes in the coat exactly where the layer under
   * it has already been thinned — the two would beat against each other. The
   * strand tile is what breaks a shell's surface, and it does it in the shader.
   */
  const shellSkin = yetiSkin(0);

  function skinFor(surface: YetiSurface): SkinFinish {
    if (FURRED_SURFACES.has(surface)) return furSkin;
    if (surface === 'hide' || surface === 'face') return bareSkin;
    return smoothSkin;
  }

  // ── Parts into geometry ────────────────────────────────────────────────────

  /**
   * One part, at a given outward growth: 1 for the skin itself, more for a
   * shell.
   *
   * A MASS GROWS ABOUT ITS OWN CENTRE and a LIMB about its own axis — never
   * about the model's origin, which would slide every shell down the animal and
   * leave the coat thickest wherever the origin happens to be.
   */
  function geometryOf(part: YetiPart, grow: number, detail: number): BufferGeometry {
    if (part.kind === 'mass') {
      const counts = MASS_SEGMENTS[part.size];
      const geometry = ellipsoid(
        part.radii.forward * 2 * grow,
        part.radii.height * 2 * grow,
        part.radii.lateral * 2 * grow,
        segments(counts.segments * detail),
        segments(counts.rings * detail),
      );
      // A tilt about the LATERAL axis is a rotation about +Z, and it is applied
      // before the move into rig space so the mass turns about itself.
      if (part.tilt !== 0) geometry.rotateZ(-part.tilt);
      geometry.translate(part.center.forward, part.center.height, part.center.lateral);
      return geometry;
    }
    if (part.kind === 'limb') {
      const counts = SWEEP_SEGMENTS[part.size];
      const root = part.rootRadius * grow;
      const tip = part.tipRadius * grow;
      return taperedTube(
        new CatmullRomCurve3([vector(part.from), vector(part.to)]),
        (along) => root + (tip - root) * along,
        segments(counts.path * detail),
        segments(counts.radial * detail),
      );
    }
    const counts = SWEEP_SEGMENTS[part.size];
    return taperedTube(
      new CatmullRomCurve3(part.path.map(vector)),
      (along) =>
        part.rootRadius +
        (part.tipRadius - part.rootRadius) * Math.pow(along, part.taperPower),
      segments(counts.path * detail),
      segments(counts.radial * detail),
    );
  }

  /**
   * The whole body, grouped into the fewest surfaces that can be finished
   * together: one per (target group, material). Parts that share both are welded
   * and carved as ONE surface, which is what keeps the noise field running
   * across a face without a seam and what keeps the count of meshes down.
   *
   * The two sides of the trunk and the head end up in the same group, because
   * both are authored in rig space and neither moves independently.
   */
  interface SurfaceGroup {
    readonly target: PartTarget;
    readonly material: ReturnType<typeof lambert>;
    readonly skin: SkinFinish;
    readonly parts: BufferGeometry[];
  }
  const groups = new Map<string, SurfaceGroup>();
  const addTo = (
    key: string,
    target: PartTarget,
    material: ReturnType<typeof lambert>,
    skin: SkinFinish,
    geometry: BufferGeometry,
  ): void => {
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { target, material, skin, parts: [geometry] });
    } else {
      group.parts.push(geometry);
    }
  };

  for (const part of body.parts) {
    const target = targetOf(part);
    addTo(
      `${target}|${part.surface}`,
      target,
      materials[part.surface],
      skinFor(part.surface),
      geometryOf(part, 1, 1),
    );
    if (part.shells === null) continue;
    const { layers, length } = part.shells;
    const color = part.surface === 'saddle' && spec.saddle !== 0 ? spec.saddle : spec.coat;
    for (let layer = 1; layer <= layers; layer++) {
      addTo(
        `${target}|shell${layer}|${color}`,
        target,
        shellMaterialFor(color, layer, layers),
        shellSkin,
        geometryOf(part, 1 + (length * layer) / layers, SHELL_DETAIL_FRACTION),
      );
    }
  }

  // ── Assembly ───────────────────────────────────────────────────────────────
  //
  // AUTHORED ONCE, DRAWN AS ONE SURFACE PER MATERIAL. The rig below is the one
  // this builder always made — see the diagram in this file's header — and it is
  // handed to bakeRig, which bakes it into one skinned geometry per material
  // class. Every Group named here survives as a BONE, so `animate` drives the
  // same handles it always did.
  const authored = (() => {
    const root = new Group();
    // The caller owns `root` (position + yaw). Everything animated hangs off
    // `rig`, so the gait cannot fight the placement maths.
    const rig = new Group();
    root.add(rig);

    // THE LEGS HANG OFF `rig`, NOT off `upper`: the lean must never reach them,
    // or a planted foot would be rolled into the ground every stride.
    const legJoints: Group[] = [];
    const ankles: Group[] = [];
    for (const side of SIDES) {
      const joint = new Group();
      joint.position.set(
        body.joints.leg.forward,
        body.joints.leg.height,
        side * body.joints.leg.lateral,
      );
      const ankle = new Group();
      ankle.position.set(
        body.joints.ankle.forward,
        body.joints.ankle.height,
        side * body.joints.ankle.lateral,
      );
      joint.add(ankle);
      rig.add(joint);
      legJoints.push(joint);
      ankles.push(ankle);
    }

    const upper = new Group();
    rig.add(upper);
    // The head's joint sits at the RIG's origin, not at the neck: its parts are
    // authored in rig space so one noise field runs from hip to brow, and a yaw
    // about the vertical axis through the body is what a head carried between
    // the shoulders actually scans on.
    const head = new Group();
    upper.add(head);

    const armJoints: Group[] = [];
    for (const side of SIDES) {
      const joint = new Group();
      joint.position.set(
        body.joints.arm.forward,
        body.joints.arm.height,
        side * body.joints.arm.lateral,
      );
      upper.add(joint);
      armJoints.push(joint);
    }

    const targets: Readonly<Record<PartTarget, Group>> = {
      upper,
      head,
      legLeft: legJoints[0]!,
      legRight: legJoints[1]!,
      ankleLeft: ankles[0]!,
      ankleRight: ankles[1]!,
      armLeft: armJoints[0]!,
      armRight: armJoints[1]!,
    };
    for (const group of groups.values()) {
      targets[group.target].add(new Mesh(organicSurface(group.parts, group.skin), group.material));
    }

    return { root, rig, upper, head, legJoints, ankles, armJoints };
  })();

  const blueprint = workshop.keepRig(bakeRig(authored.root));
  const rigJoint = blueprint.jointIndex(authored.rig);
  const upperJoint = blueprint.jointIndex(authored.upper);
  const headJoint = blueprint.jointIndex(authored.head);
  const legJointIndices = authored.legJoints.map((joint) => blueprint.jointIndex(joint));
  const ankleJointIndices = authored.ankles.map((joint) => blueprint.jointIndex(joint));
  const armJointIndices = authored.armJoints.map((joint) => blueprint.jointIndex(joint));

  return function createYeti(): MonsterModel {
    const instance = instantiateRig(blueprint);
    const rig = instance.joints[rigJoint]!;
    const upper = instance.joints[upperJoint]!;
    const head = instance.joints[headJoint]!;
    const legJoints = legJointIndices.map((index) => instance.joints[index]!);
    const ankles = ankleJointIndices.map((index) => instance.joints[index]!);
    const armJoints = armJointIndices.map((index) => instance.joints[index]!);

    return {
      root: instance.root,
      animate(seconds, phase) {
        // ONE WAVE DRIVES THE WHOLE GAIT, at the rate this variant's stride and
        // the server's speed between them fix (metrics.ambleHz). Everything
        // below is a phase of it, so nothing can drift out of step.
        const wave = seconds * metrics.ambleHz * TWO_PI + phase;
        const stride = Math.sin(wave);

        // LEGS in antiphase, ARMS opposite the leg on their own side: that is
        // what makes it a walk rather than a hop.
        SIDES.forEach((side, index) => {
          const swing = stride * side;
          legJoints[index]!.rotation.z = swing * metrics.legSwingRadians;
          // The ankle counter-rotates by exactly the stride, so the sole stays
          // parallel to the ground it is standing on. Without it the toe digs in
          // at one end of every step.
          ankles[index]!.rotation.z = -swing * metrics.legSwingRadians;
          armJoints[index]!.rotation.z = -swing * metrics.armSwingRadians;
        });

        // LEAN: one roll per gait cycle, a quarter cycle behind the legs, so he
        // is leaning over the foot that is planted. On `upper` only — see the
        // note at YETI_LEAN_RADIANS for why it may not touch the legs.
        upper.rotation.x = Math.cos(wave) * YETI_LEAN_RADIANS;

        // BOB: twice per cycle (once per step), and it only ever LIFTS —
        // (1 - cos)/2 is zero at its lowest, so his feet never sink into the
        // ground the client just placed them on.
        rig.position.y = YETI_BOB_CELLS * ((1 - Math.cos(wave * 2)) / 2);

        // THE HEAD SCANS on its own unrelated clock, so the two motions never
        // lock into a pattern a player can feel repeating.
        head.rotation.y =
          Math.sin(seconds * YETI_HEAD_SCAN_HZ * TWO_PI + phase) * YETI_HEAD_SCAN_RADIANS;
      },
    };
  };
}
