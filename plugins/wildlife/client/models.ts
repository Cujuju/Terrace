import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  type Bone,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { bakeRig, type RigBlueprint } from '../../../client/src/render/rigSkin.ts';
import { createRigHerd, type RigHerd } from '../../../client/src/render/rigHerd.ts';
import {
  MOVER_GAITS,
  moverGaitIndex,
  type MoverGait,
} from '../../../client/src/plugins/kit/moverGait.ts';
import { applyMoverBodyTilt } from '../../../client/src/plugins/kit/moverBodyTilt.ts';
import { WHALE_SPECIES, type WhaleSpecies } from './whaleSpecies.ts';
import { buildHumpback } from './species/humpback.ts';
import { buildBlueWhale } from './species/blueWhale.ts';
import { buildSpermWhale } from './species/spermWhale.ts';
import { type WildlifeSizeClass, type WildlifeSpecies } from '../protocol.ts';
import { modelScaleFor } from './modelScale.ts';
import type { SpeciesModelBuilder, SpeciesModelPool } from './species/speciesModel.ts';
import { buildFish } from './species/fish.ts';
import { buildGrazer } from './species/grazer.ts';
import { buildWolf } from './species/wolf.ts';
import { buildIbex } from './species/ibex.ts';
import { buildBison } from './species/bison.ts';
import { buildRay } from './species/ray.ts';
import { buildShark } from './species/shark.ts';
import { buildEel } from './species/eel.ts';
import { buildAngelfish } from './species/angelfish.ts';
import { buildDeepsea } from './species/deepsea.ts';

const SPHERE_SEGMENTS = 6;
const SPHERE_RINGS = 4;
const CONE_SEGMENTS = 4;

const BIRD_COLOR = 0x2e3646;

export const BIRD_ENVELOPE = {
  crownY: 0.09,
  bellyY: -0.09,
} as const;

const BIRD_WING_FLAP_HZ = 5.5;

const BIRD_WING_FLAP_RADIANS = 0.7;
const BIRD_BODY_BOB = 0.04;
const BIRD_WING_LENGTH = 0.62;
const BIRD_WING_ROOT_OFFSET = BIRD_WING_LENGTH / 2;

const TWO_PI = Math.PI * 2;

const POSE_SLOTS_PER_HERD = 32;

interface SpeciesDrawable {
  readonly herd: RigHerd;
  animate(seconds: number, phase: number, gait: MoverGait): void;
}

export interface WildlifeModels {
  readonly objects: readonly Object3D[];
  beginFrame(seconds: number): void;
  draw(
    species: WildlifeSpecies,
    sizeClass: WildlifeSizeClass,
    variantSeed: number,
    phase: number,
    gait: MoverGait,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ): void;
  endFrame(): void;
  dispose(): void;
}

export function createWildlifeModels(instanceCapacity: number): WildlifeModels {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function lambert(color: number, options: { flatShading?: boolean } = {}): MeshLambertMaterial {
    const material = new MeshLambertMaterial({ color, flatShading: options.flatShading ?? true });
    materials.push(material);
    return material;
  }

  function unlit(color: number): MeshBasicMaterial {
    const material = new MeshBasicMaterial({ color });
    materials.push(material);
    return material;
  }

  function ellipsoid(length: number, height: number, width: number): SphereGeometry {
    const geometry = new SphereGeometry(0.5, SPHERE_SEGMENTS, SPHERE_RINGS);
    geometry.scale(length, height, width);
    return keepGeometry(geometry);
  }

  const birdMaterial = lambert(BIRD_COLOR);
  const birdBody = ellipsoid(0.6, BIRD_ENVELOPE.crownY - BIRD_ENVELOPE.bellyY, 0.18);
  const birdWing = keepGeometry(new BoxGeometry(0.32, 0.03, BIRD_WING_LENGTH));
  const birdTail = keepGeometry(new ConeGeometry(0.13, 0.26, CONE_SEGMENTS));
  birdTail.rotateZ(Math.PI / 2);

  function part(
    geometry: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
  ): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    return mesh;
  }

  function rigged(): { root: Group; rig: Group } {
    const root = new Group();
    const rig = new Group();
    root.add(rig);
    return { root, rig };
  }

  interface SpeciesRig {
    readonly blueprint: RigBlueprint;
    readonly jointIndices: Readonly<Record<string, number>>;
    readonly rootJoint: number;
  }

  const speciesRigs: SpeciesRig[] = [];

  function bakeSpecies(root: Object3D, joints: Readonly<Record<string, Object3D>>): SpeciesRig {
    const blueprint = bakeRig(root);
    const jointIndices: Record<string, number> = {};
    for (const [name, node] of Object.entries(joints)) {
      jointIndices[name] = blueprint.jointIndex(node);
    }
    const rig: SpeciesRig = { blueprint, jointIndices, rootJoint: blueprint.jointIndex(root) };
    speciesRigs.push(rig);
    return rig;
  }

  const herds: RigHerd[] = [];

  function herdFor(
    rig: SpeciesRig,
    posesByGait: boolean = false,
  ): { herd: RigHerd; joints: Readonly<Record<string, Bone>>; rigRoot: Bone } {
    const herd = createRigHerd(rig.blueprint, {
      capacity: instanceCapacity,
      poseSlots: POSE_SLOTS_PER_HERD,
      poseVariants: posesByGait ? MOVER_GAITS.length : 1,
    });
    herds.push(herd);
    const joints: Record<string, Bone> = {};
    for (const [name, index] of Object.entries(rig.jointIndices)) {
      joints[name] = herd.joints[index]!;
    }
    return { herd, joints, rigRoot: herd.joints[rig.rootJoint]! };
  }

  function drawInto(
    drawable: SpeciesDrawable,
    seconds: number,
    phase: number,
    gait: MoverGait,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
  ): void {
    const herd = drawable.herd;
    const slot = herd.poseSlotOf(phase, moverGaitIndex(gait));
    if (herd.needsPose(slot)) {
      drawable.animate(seconds, herd.poseSlotPhase(slot), gait);
      herd.capturePose(slot);
    }
    herd.place(slot, x, y, z, yaw, scale);
  }

  const speciesPool: SpeciesModelPool = { keepGeometry, lambert, unlit, part, rigged };

  function speciesDrawable(build: SpeciesModelBuilder): SpeciesDrawable {
    const authored = build(speciesPool);
    const posesByGait = authored.posesByGait === true;
    const { herd, joints, rigRoot } = herdFor(
      bakeSpecies(authored.root, authored.joints),
      posesByGait,
    );
    return {
      herd,
      animate(seconds, phase, gait) {
        authored.animate(joints, seconds, phase, gait);
        applyMoverBodyTilt(rigRoot, gait, seconds, phase);
      },
    };
  }

  const birdRig = (() => {
    const { root, rig } = rigged();
    rig.add(part(birdBody, birdMaterial, 0, 0, 0));
    rig.add(part(birdTail, birdMaterial, -0.38, 0, 0));

    function wing(sign: number): Group {
      const pivot = new Group();
      pivot.add(part(birdWing, birdMaterial, 0, 0, sign * BIRD_WING_ROOT_OFFSET));
      rig.add(pivot);
      return pivot;
    }
    const leftWing = wing(1);
    const rightWing = wing(-1);
    return bakeSpecies(root, { rig, leftWing, rightWing });
  })();

  const fishDrawable = speciesDrawable(buildFish);
  const grazerDrawable = speciesDrawable(buildGrazer);
  const wolfDrawable = speciesDrawable(buildWolf);
  const ibexDrawable = speciesDrawable(buildIbex);
  const bisonDrawable = speciesDrawable(buildBison);
  const rayDrawable = speciesDrawable(buildRay);
  const sharkDrawable = speciesDrawable(buildShark);
  const eelDrawable = speciesDrawable(buildEel);
  const angelfishDrawable = speciesDrawable(buildAngelfish);

  const whaleBuilders: Readonly<Record<WhaleSpecies, SpeciesModelBuilder>> = {
    humpback: buildHumpback,
    blue: buildBlueWhale,
    sperm: buildSpermWhale,
  };
  const whaleDrawables: readonly SpeciesDrawable[] = WHALE_SPECIES.map(
    (body): SpeciesDrawable => speciesDrawable(whaleBuilders[body]),
  );

  const deepseaDrawable = speciesDrawable(buildDeepsea);

  const birdDrawable = ((): SpeciesDrawable => {
    const { herd, joints } = herdFor(birdRig);
    const rig = joints.rig!;
    const leftWing = joints.leftWing!;
    const rightWing = joints.rightWing!;
    return {
      herd,
      animate(seconds, phase) {
        const swing = Math.sin(seconds * BIRD_WING_FLAP_HZ * TWO_PI + phase);
        leftWing.rotation.x = -swing * BIRD_WING_FLAP_RADIANS;
        rightWing.rotation.x = swing * BIRD_WING_FLAP_RADIANS;
        rig.position.y = swing * BIRD_BODY_BOB;
      },
    };
  })();

  function drawableOf(species: WildlifeSpecies, variantSeed: number): SpeciesDrawable {
    switch (species) {
      case 'fish':
        return fishDrawable;
      case 'whale':
        return whaleDrawables[Math.abs(Math.trunc(variantSeed)) % whaleDrawables.length]!;
      case 'deepsea':
        return deepseaDrawable;
      case 'grazer':
        return grazerDrawable;
      case 'wolf':
        return wolfDrawable;
      case 'ibex':
        return ibexDrawable;
      case 'bison':
        return bisonDrawable;
      case 'ray':
        return rayDrawable;
      case 'shark':
        return sharkDrawable;
      case 'eel':
        return eelDrawable;
      case 'angelfish':
        return angelfishDrawable;
      case 'bird':
        return birdDrawable;
    }
  }

  const objects: Object3D[] = [];
  for (const herd of herds) objects.push(...herd.meshes);

  let animationSeconds = 0;

  return {
    objects,
    beginFrame(seconds) {
      animationSeconds = seconds;
      for (const herd of herds) herd.beginFrame();
    },
    draw(species, sizeClass, variantSeed, phase, gait, x, y, z, yaw) {
      drawInto(
        drawableOf(species, variantSeed),
        animationSeconds,
        phase,
        gait,
        x,
        y,
        z,
        yaw,
        modelScaleFor(species, sizeClass),
      );
    },
    endFrame() {
      for (const herd of herds) herd.endFrame();
    },
    dispose() {
      for (const herd of herds) herd.dispose();
      herds.length = 0;
      objects.length = 0;
      for (const rig of speciesRigs) rig.blueprint.dispose();
      speciesRigs.length = 0;
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
