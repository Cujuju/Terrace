import { bakeRig, instantiateRig } from '../../../client/src/render/rigSkin.ts';
import { applyMoverBodyTilt } from '../../../client/src/plugins/kit/moverBodyTilt.ts';
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
  YETI_CLIMB_ARM_HIGH_RADIANS,
  YETI_CLIMB_ARM_LOW_RADIANS,
  YETI_CLIMB_LEG_HIGH_RADIANS,
  YETI_CLIMB_LEG_LOW_RADIANS,
  YETI_CLIMB_PULL_CELLS,
  YETI_CLIMB_REACH_HZ,
  YETI_EYE_COLOR,
  YETI_BREATH_CELLS,
  YETI_BREATH_HZ,
  YETI_SIT_ARM_RADIANS,
  YETI_SIT_LEG_RADIANS,
  YETI_FALL_ARM_RADIANS,
  YETI_FALL_FLAIL_HZ,
  YETI_FALL_FLAIL_RADIANS,
  YETI_FALL_LEG_SPREAD_RADIANS,
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

const MASS_SEGMENTS: Readonly<Record<YetiPartSize, { segments: number; rings: number }>> = {
  trunk: { segments: 12, rings: 9 },
  head: { segments: 15, rings: 11 },
  feature: { segments: 8, rings: 6 },
  limb: { segments: 8, rings: 7 },
  joint: { segments: 6, rings: 5 },
  digit: { segments: 6, rings: 5 },
  horn: { segments: 8, rings: 6 },
};

const SWEEP_SEGMENTS: Readonly<Record<YetiPartSize, { path: number; radial: number }>> = {
  trunk: { path: 6, radial: 10 },
  head: { path: 6, radial: 10 },
  feature: { path: 4, radial: 8 },
  limb: { path: 5, radial: 9 },
  joint: { path: 4, radial: 8 },
  digit: { path: 2, radial: 4 },
  horn: { path: 10, radial: 8 },
};

const SHELL_DETAIL_FRACTION = 0.5;

const SIDES = [1, -1] as const;

function yetiSkin(wrinkleDepth: number): SkinFinish {
  return {
    wrinkleDepth,
    wrinkleFrequency: YETI_WRINKLE_FREQUENCY,
    shadeVariation: YETI_SHADE_VARIATION,
    shadeFrequency: YETI_SHADE_FREQUENCY,
  };
}

const FURRED_SURFACES: ReadonlySet<YetiSurface> = new Set<YetiSurface>(['coat', 'saddle']);

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

type PartTarget = 'upper' | 'head' | 'legLeft' | 'legRight' | 'armLeft' | 'armRight' | 'ankleLeft' | 'ankleRight';

function targetOf(part: YetiPart): PartTarget {
  const left = part.side >= 0;
  if (part.joint === 'leg') return left ? 'legLeft' : 'legRight';
  if (part.joint === 'ankle') return left ? 'ankleLeft' : 'ankleRight';
  if (part.joint === 'arm') return left ? 'armLeft' : 'armRight';
  return part.joint;
}

function vector(at: YetiPoint): Vector3 {
  return new Vector3(at.forward, at.height, at.lateral);
}

function buildVariant(workshop: ModelWorkshop, variant: YetiVariant): () => MonsterModel {
  const { segments, lambert, shellMaterial, organicSurface } = workshop;
  const spec = YETI_VARIANT_SPECS[variant];
  const metrics = YETI_VARIANT_METRICS[variant];
  const body = yetiWorldParts(variant);

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
    glint: lambert(YETI_GLINT_COLOR),
    eye: lambert(YETI_EYE_COLOR, { emissive: YETI_EYE_EMISSIVE }),
  };

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

  const furSkin = yetiSkin(YETI_FUR_WRINKLE_DEPTH * spec.shag);
  const bareSkin = yetiSkin(YETI_SKIN_WRINKLE_DEPTH);
  const smoothSkin = yetiSkin(0);
  const shellSkin = yetiSkin(0);

  function skinFor(surface: YetiSurface): SkinFinish {
    if (FURRED_SURFACES.has(surface)) return furSkin;
    if (surface === 'hide' || surface === 'face') return bareSkin;
    return smoothSkin;
  }

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

  const authored = (() => {
    const root = new Group();
    const rig = new Group();
    root.add(rig);

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
  const rootJoint = blueprint.jointIndex(authored.root);
  const rigJoint = blueprint.jointIndex(authored.rig);
  const upperJoint = blueprint.jointIndex(authored.upper);
  const headJoint = blueprint.jointIndex(authored.head);
  const legJointIndices = authored.legJoints.map((joint) => blueprint.jointIndex(joint));
  const ankleJointIndices = authored.ankles.map((joint) => blueprint.jointIndex(joint));
  const armJointIndices = authored.armJoints.map((joint) => blueprint.jointIndex(joint));

  return function createYeti(): MonsterModel {
    const instance = instantiateRig(blueprint);
    const rigRoot = instance.joints[rootJoint]!;
    const rig = instance.joints[rigJoint]!;
    const upper = instance.joints[upperJoint]!;
    const head = instance.joints[headJoint]!;
    const legJoints = legJointIndices.map((index) => instance.joints[index]!);
    const ankles = ankleJointIndices.map((index) => instance.joints[index]!);
    const armJoints = armJointIndices.map((index) => instance.joints[index]!);

    return {
      root: instance.root,
      animate(seconds, phase, gait = 'walk') {
        applyMoverBodyTilt(rigRoot, gait, seconds, phase);

        if (gait === 'stand' || gait === 'sit') {
          const sitting = gait === 'sit';
          const legSwing = sitting ? YETI_SIT_LEG_RADIANS : 0;
          const legLength = legJoints[0]!.position.y;
          const drop = sitting ? legLength * (1 - Math.cos(legSwing)) * rig.scale.y : 0;
          SIDES.forEach((_side, index) => {
            legJoints[index]!.rotation.z = legSwing;
            ankles[index]!.rotation.z = -legSwing;
            armJoints[index]!.rotation.z = sitting ? YETI_SIT_ARM_RADIANS : 0;
          });
          upper.rotation.x = 0;
          const breath = (1 - Math.cos(seconds * YETI_BREATH_HZ * TWO_PI + phase)) / 2;
          rig.position.y = -drop + breath * YETI_BREATH_CELLS;
          head.rotation.y =
            Math.sin(seconds * YETI_HEAD_SCAN_HZ * TWO_PI + phase) * YETI_HEAD_SCAN_RADIANS;
          return;
        }
        if (gait !== 'walk') {
          const falling = gait === 'fall';
          const hz = falling ? YETI_FALL_FLAIL_HZ : YETI_CLIMB_REACH_HZ;
          const reach = Math.sin(seconds * hz * TWO_PI + phase);
          const armMid = (YETI_CLIMB_ARM_HIGH_RADIANS + YETI_CLIMB_ARM_LOW_RADIANS) / 2;
          const armSpan = (YETI_CLIMB_ARM_HIGH_RADIANS - YETI_CLIMB_ARM_LOW_RADIANS) / 2;
          const legMid = (YETI_CLIMB_LEG_HIGH_RADIANS + YETI_CLIMB_LEG_LOW_RADIANS) / 2;
          const legSpan = (YETI_CLIMB_LEG_HIGH_RADIANS - YETI_CLIMB_LEG_LOW_RADIANS) / 2;
          SIDES.forEach((side, index) => {
            const swing = reach * side;
            armJoints[index]!.rotation.z = falling
              ? YETI_FALL_ARM_RADIANS + swing * YETI_FALL_FLAIL_RADIANS
              : armMid + swing * armSpan;
            legJoints[index]!.rotation.z = falling
              ? side * YETI_FALL_LEG_SPREAD_RADIANS + swing * YETI_FALL_FLAIL_RADIANS
              : legMid - swing * legSpan;
            ankles[index]!.rotation.z = 0;
          });
          upper.rotation.x = 0;
          rig.position.y = falling ? 0 : Math.abs(reach) * YETI_CLIMB_PULL_CELLS;
          head.rotation.y = 0;
          return;
        }
        const wave = seconds * metrics.ambleHz * TWO_PI + phase;
        const stride = Math.sin(wave);

        SIDES.forEach((side, index) => {
          const swing = stride * side;
          legJoints[index]!.rotation.z = swing * metrics.legSwingRadians;
          ankles[index]!.rotation.z = -swing * metrics.legSwingRadians;
          armJoints[index]!.rotation.z = -swing * metrics.armSwingRadians;
        });

        upper.rotation.x = Math.cos(wave) * YETI_LEAN_RADIANS;

        rig.position.y = YETI_BOB_CELLS * ((1 - Math.cos(wave * 2)) / 2);

        head.rotation.y =
          Math.sin(seconds * YETI_HEAD_SCAN_HZ * TWO_PI + phase) * YETI_HEAD_SCAN_RADIANS;
      },
      dispose(): void {
        instance.dispose();
      },
    };
  };
}
