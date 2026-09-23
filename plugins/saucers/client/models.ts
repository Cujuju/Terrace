import {
  Box3,
  BufferGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type ColorRepresentation,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute } from 'three/tsl';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import type { RigAsset } from '../../../client/src/render/rigAsset.ts';
import { compose } from '../../../client/src/render/materialSlots.ts';
import {
  CELL_WORLD_SIZE,
  MAX_SAUCERS_PER_ENCOUNTER,
  SAUCER_DIAMETER_CELLS,
  SAUCER_MUZZLE_DROP_FRACTION,
  SAUCER_VARIANT_COUNT,
} from '../protocol.ts';
import { factionColour } from './factions.ts';

export { SAUCER_DIAMETER_CELLS };

export const SAUCER_DIAMETER_WORLD_UNITS = SAUCER_DIAMETER_CELLS * CELL_WORLD_SIZE;

const AUTHORED_UNIT_SCALE = CELL_WORLD_SIZE;

const AUTHORED_FIT_TOLERANCE_FRACTION = 0.05;

const SAUCER_MESHES_MAX = 8;

const FALLBACK_SAUCER_MESHES = 4;

export let SAUCER_MODEL_DRAW_OBJECTS: number = SAUCER_MESHES_MAX;

const HULL_NODE = 'hull';
const RING_NODE = 'ring';
const DOME_NODE = 'dome';
const LIGHTS_NODE = 'lights';
const MUZZLE_NODE = 'muzzle';
const TOP_NODE = 'top';

const ASSET_FILENAMES: readonly string[] = ['saucer-a.glb', 'saucer-b.glb', 'saucer-c.glb'];

export interface SaucerModel {
  readonly root: Object3D;
  readonly ring: Object3D | null;
  readonly ringGlow: MeshStandardMaterial | null;
  readonly lights: MeshStandardMaterial | null;
  readonly lightsBaseEmissive: number;
  readonly muzzle: Object3D;
  dispose(): void;
}

export interface SaucerModels {
  create(variant: number): SaucerModel;
  dispose(): void;
}

let installed: readonly RigAsset[] | null = null;

export async function preloadSaucerModels(
  ctx: Pick<ClientPluginCtx, 'loadRigAsset'>,
): Promise<void> {
  const found: Record<string, () => Promise<unknown>> = import.meta.glob('./assets/*.glb', {
    query: '?url',
    import: 'default',
    eager: false,
  });

  const loaders: (() => Promise<unknown>)[] = [];
  for (const filename of ASSET_FILENAMES) {
    const loader = found[`./assets/${filename}`];
    if (loader === undefined) return;
    loaders.push(loader);
  }

  const assets: RigAsset[] = [];
  try {
    for (const loader of loaders) {
      const url = await loader();
      if (typeof url !== 'string') throw new Error(`asset loader returned ${typeof url}, not a URL`);
      assets.push(await ctx.loadRigAsset(url, 'sky-environment'));
    }
    const rejected = measureInstalled(assets);
    if (rejected !== null) {
      console.error(`[saucers] ${rejected} — drawing primitives instead`);
      for (const asset of assets) asset.dispose();
      return;
    }
    installed = assets;
  } catch (error) {
    console.error('[saucers] could not load an authored hull — drawing primitives instead', error);
    for (const asset of assets) asset.dispose();
    installed = null;
  }
}

function measureInstalled(assets: readonly RigAsset[]): string | null {
  const limit = SAUCER_DIAMETER_CELLS * (1 + AUTHORED_FIT_TOLERANCE_FRACTION);
  let meshes = 0;
  for (const asset of assets) {
    const size = new Box3().setFromObject(asset.scene).getSize(new Vector3());
    if (size.x > limit || size.z > limit) {
      return (
        `an authored hull measures ${size.x.toFixed(2)} x ${size.z.toFixed(2)} authored units ` +
        `against a ${SAUCER_DIAMETER_CELLS}-cell budget`
      );
    }
    let count = 0;
    asset.scene.traverse((child) => {
      if ((child as Partial<Mesh>).isMesh === true) count++;
    });
    if (count > meshes) meshes = count;
  }
  if (meshes > SAUCER_MESHES_MAX) {
    return `an authored hull holds ${meshes} meshes against a ceiling of ${SAUCER_MESHES_MAX}`;
  }
  SAUCER_MODEL_DRAW_OBJECTS = meshes > 0 ? meshes : SAUCER_MESHES_MAX;
  return null;
}

export function clearSaucerAssets(): void {
  installed = null;
  SAUCER_MODEL_DRAW_OBJECTS = SAUCER_MESHES_MAX;
}

const HULL_FLATTEN = 0.22;
const DOME_RADIUS_FRACTION = 0.4;
const RING_TUBE_FRACTION = 0.06;
const RING_LIGHTS_RADIUS_FRACTION = 0.72;
const RING_LIGHTS_TUBE_FRACTION = 0.035;

const FALLBACK_RADIAL_SEGMENTS = 20;
const FALLBACK_HEIGHT_SEGMENTS = 10;
const FALLBACK_TORUS_SEGMENTS = 24;
const FALLBACK_TUBE_SEGMENTS = 8;

const FALLBACK_HULL_COLOURS: readonly ColorRepresentation[] = [0x9aa4b2, 0xb0a08a, 0x8f9a86];

export const SAUCER_LIGHTS_BASE_EMISSIVE = 1.2;

interface FallbackWorkshop {
  readonly hull: BufferGeometry;
  readonly dome: BufferGeometry;
  readonly ring: BufferGeometry;
  readonly lights: BufferGeometry;
  dispose(): void;
}

function createFallbackWorkshop(): FallbackWorkshop {
  const radius = SAUCER_DIAMETER_WORLD_UNITS / 2;
  const hull = new SphereGeometry(radius, FALLBACK_RADIAL_SEGMENTS, FALLBACK_HEIGHT_SEGMENTS);
  hull.scale(1, HULL_FLATTEN, 1);
  hull.translate(0, radius * HULL_FLATTEN, 0);

  const domeRadius = radius * DOME_RADIUS_FRACTION;
  const dome = new SphereGeometry(
    domeRadius,
    FALLBACK_RADIAL_SEGMENTS,
    FALLBACK_HEIGHT_SEGMENTS,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  dome.translate(0, radius * HULL_FLATTEN * 2, 0);

  const ring = new TorusGeometry(
    radius,
    radius * RING_TUBE_FRACTION,
    FALLBACK_TUBE_SEGMENTS,
    FALLBACK_TORUS_SEGMENTS,
  );
  ring.rotateX(Math.PI / 2);
  ring.translate(0, radius * HULL_FLATTEN, 0);

  const lights = new TorusGeometry(
    radius * RING_LIGHTS_RADIUS_FRACTION,
    radius * RING_LIGHTS_TUBE_FRACTION,
    FALLBACK_TUBE_SEGMENTS,
    FALLBACK_TORUS_SEGMENTS,
  );
  lights.rotateX(Math.PI / 2);
  lights.translate(0, radius * HULL_FLATTEN * 0.6, 0);

  return {
    hull,
    dome,
    ring,
    lights,
    dispose() {
      hull.dispose();
      dome.dispose();
      ring.dispose();
      lights.dispose();
    },
  };
}

function cloneStandardMaterial(node: Object3D): MeshStandardMaterial | null {
  const mesh = node as Partial<Mesh> & Object3D;
  if (mesh.isMesh !== true) return null;
  const material = (node as Mesh).material;
  if (Array.isArray(material) || !(material instanceof MeshStandardMaterial)) return null;
  const own = material.clone();
  (node as Mesh).material = own;
  return own;
}

function buildFallbackSaucer(workshop: FallbackWorkshop, variant: number): SaucerModel {
  const radius = SAUCER_DIAMETER_WORLD_UNITS / 2;
  const hullColour = FALLBACK_HULL_COLOURS[variant] ?? FALLBACK_HULL_COLOURS[0]!;
  const lightColour = factionColour(variant);

  const hullMaterial = new MeshStandardMaterial({ color: hullColour, roughness: 0.35, metalness: 0.6 });
  const domeMaterial = new MeshStandardMaterial({
    color: lightColour,
    roughness: 0.1,
    metalness: 0.1,
    emissive: lightColour,
    emissiveIntensity: 0.25,
  });
  const ringMaterial = new MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.8 });
  const lightsMaterial = new MeshStandardMaterial({
    color: 0x111111,
    emissive: lightColour,
    emissiveIntensity: SAUCER_LIGHTS_BASE_EMISSIVE,
  });
  const materials: readonly Material[] = [hullMaterial, domeMaterial, ringMaterial, lightsMaterial];

  const root = new Group();
  root.name = `saucers:body:${variant}`;

  const hull = new Mesh(workshop.hull, hullMaterial);
  hull.name = HULL_NODE;
  const dome = new Mesh(workshop.dome, domeMaterial);
  dome.name = DOME_NODE;
  const ring = new Mesh(workshop.ring, ringMaterial);
  ring.name = RING_NODE;
  const lights = new Mesh(workshop.lights, lightsMaterial);
  lights.name = LIGHTS_NODE;

  const muzzle = new Object3D();
  muzzle.name = MUZZLE_NODE;
  muzzle.position.set(0, -radius * SAUCER_MUZZLE_DROP_FRACTION, 0);
  const top = new Object3D();
  top.name = TOP_NODE;
  top.position.set(0, radius * HULL_FLATTEN * 2 + radius * DOME_RADIUS_FRACTION, 0);

  root.add(hull, dome, ring, lights, muzzle, top);

  return {
    root,
    ring,
    ringGlow: null,
    lights: lightsMaterial,
    lightsBaseEmissive: SAUCER_LIGHTS_BASE_EMISSIVE,
    muzzle,
    dispose() {
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}

function buildAuthoredSaucer(asset: RigAsset, variant: number): SaucerModel {
  const root = asset.scene.clone(true);
  root.name = `saucers:body:${variant}`;
  root.scale.setScalar(AUTHORED_UNIT_SCALE);

  const ring = root.getObjectByName(RING_NODE) ?? null;
  const ringGlow = ring === null ? null : cloneStandardMaterial(ring);
  const muzzleNode = root.getObjectByName(MUZZLE_NODE);
  const muzzle = muzzleNode ?? root;

  const lightsNode = root.getObjectByName(LIGHTS_NODE);
  const lights = lightsNode === undefined ? null : cloneStandardMaterial(lightsNode);

  return {
    root,
    ring,
    ringGlow,
    lights,
    lightsBaseEmissive: lights === null ? SAUCER_LIGHTS_BASE_EMISSIVE : lights.emissiveIntensity,
    muzzle,
    dispose() {
      lights?.dispose();
      ringGlow?.dispose();
      root.clear();
    },
  };
}

export function createSaucerModels(): SaucerModels {
  const assets = installed;
  if (assets !== null && assets.length === SAUCER_VARIANT_COUNT) {
    return {
      create(variant: number): SaucerModel {
        const index = variant >= 0 && variant < assets.length ? variant : 0;
        return buildAuthoredSaucer(assets[index]!, index);
      },
      dispose(): void {
      },
    };
  }

  const workshop = createFallbackWorkshop();
  SAUCER_MODEL_DRAW_OBJECTS = FALLBACK_SAUCER_MESHES;
  return {
    create(variant: number): SaucerModel {
      const index = variant >= 0 && variant < SAUCER_VARIANT_COUNT ? variant : 0;
      return buildFallbackSaucer(workshop, index);
    },
    dispose(): void {
      workshop.dispose();
    },
  };
}

export interface SaucerFleet {
  begin(): void;
  place(variant: number, x: number, y: number, z: number, yaw: number, roll: number, ringSpin: number, ringGlow: number): void;
  finish(lightsFlash: number): void;
  dispose(): void;
}

interface FleetPart {
  readonly source: Mesh;
  readonly batch: InstancedMesh;
  readonly glow: InstancedBufferAttribute | null;
}

interface FleetVariant {
  readonly template: SaucerModel;
  readonly parts: readonly FleetPart[];
  count: number;
}

const INSTANCE_GLOW_ATTRIBUTE = 'instanceGlow';

function glowingCopy(source: MeshStandardMaterial): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    name: source.name,
    color: source.color,
    map: source.map,
    roughness: source.roughness,
    roughnessMap: source.roughnessMap,
    metalness: source.metalness,
    metalnessMap: source.metalnessMap,
    normalMap: source.normalMap,
    emissive: source.emissive,
    emissiveMap: source.emissiveMap,
    emissiveIntensity: source.emissiveIntensity,
    envMap: source.envMap,
    envMapIntensity: source.envMapIntensity,
    side: source.side,
    transparent: source.transparent,
    opacity: source.opacity,
  });
  compose(material, 'emissive', (previous) =>
    previous.mul(attribute<'float'>(INSTANCE_GLOW_ATTRIBUTE, 'float')),
  );
  return material;
}

function batchPart(source: Mesh, variant: number, template: SaucerModel): FleetPart {
  const glowing = template.ringGlow !== null && source.material === template.ringGlow;
  const geometry = glowing ? source.geometry.clone() : source.geometry;
  let glow: InstancedBufferAttribute | null = null;
  let material = source.material as Material;
  if (glowing) {
    glow = new InstancedBufferAttribute(new Float32Array(MAX_SAUCERS_PER_ENCOUNTER).fill(1), 1);
    geometry.setAttribute(INSTANCE_GLOW_ATTRIBUTE, glow);
    material = glowingCopy(template.ringGlow!);
  }
  const batch = new InstancedMesh(geometry, material, MAX_SAUCERS_PER_ENCOUNTER);
  batch.name = `saucers:fleet:${variant}:${source.name}`;
  batch.count = 0;
  batch.visible = false;
  batch.frustumCulled = false;
  batch.matrixAutoUpdate = false;
  return { source, batch, glow };
}

// One instanced mesh per variant per part: the template is posed at each saucer and its parts' world matrices become instances.
export function createSaucerFleet(bank: SaucerModels, parent: Group): SaucerFleet {
  const variants: FleetVariant[] = [];
  for (let variant = 0; variant < SAUCER_VARIANT_COUNT; variant++) {
    const template = bank.create(variant);
    template.root.rotation.order = 'YXZ';
    const parts: FleetPart[] = [];
    template.root.traverse((node) => {
      if ((node as Partial<Mesh>).isMesh !== true) return;
      const part = batchPart(node as Mesh, variant, template);
      parent.add(part.batch);
      parts.push(part);
    });
    variants.push({ template, parts, count: 0 });
  }

  return {
    begin(): void {
      for (const entry of variants) entry.count = 0;
    },
    place(variant, x, y, z, yaw, roll, ringSpin, ringGlow): void {
      const entry = variants[variant] ?? variants[0]!;
      if (entry.count >= MAX_SAUCERS_PER_ENCOUNTER) return;
      const { template } = entry;
      template.root.position.set(x, y, z);
      template.root.rotation.set(roll, yaw, 0);
      if (template.ring !== null) template.ring.rotation.y = ringSpin;
      template.root.updateMatrixWorld(true);
      const index = entry.count++;
      for (const part of entry.parts) {
        part.batch.setMatrixAt(index, part.source.matrixWorld);
        part.glow?.setX(index, ringGlow);
      }
    },
    finish(lightsFlash): void {
      for (const entry of variants) {
        const { template, count } = entry;
        if (template.lights !== null) template.lights.emissiveIntensity = template.lightsBaseEmissive * lightsFlash;
        for (const part of entry.parts) {
          part.batch.count = count;
          part.batch.visible = count > 0;
          if (count === 0) continue;
          part.batch.instanceMatrix.needsUpdate = true;
          if (part.glow !== null) part.glow.needsUpdate = true;
        }
      }
    },
    dispose(): void {
      for (const entry of variants) {
        for (const part of entry.parts) {
          part.batch.removeFromParent();
          part.batch.dispose();
          if (part.glow !== null) {
            (part.batch.material as Material).dispose();
            part.batch.geometry.dispose();
          }
        }
        entry.template.dispose();
      }
      variants.length = 0;
    },
  };
}

export function disposeSaucerAssets(): void {
  if (installed === null) return;
  for (const asset of installed) asset.dispose();
  clearSaucerAssets();
}
