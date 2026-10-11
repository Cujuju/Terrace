import {
  Bone,
  BufferAttribute,
  Color,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Vector2,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  mapIdentitySignature,
  texturesOf,
  uvAttributeName,
  uvChannelsUsed,
} from './materialMaps.ts';

const SKIN_INFLUENCES = 4;

const MATRIX_ELEMENTS = 16;

const COLOR_COMPONENTS = 3;

const RIGID_BIND_WEIGHT = 1;

function materialSignature(material: Material): string {
  const shaded = material as Material & {
    flatShading?: boolean;
    emissive?: Color;
    wireframe?: boolean;
  };
  return [
    material.type,
    material.transparent ? 't' : '-',
    material.opacity,
    material.side,
    material.blending,
    material.depthWrite ? 'dw' : '-',
    material.depthTest ? 'dt' : '-',
    shaded.flatShading === true ? 'flat' : 'smooth',
    shaded.wireframe === true ? 'wire' : '-',
    mapIdentitySignature(material),
    shadingScalarSignature(material),
    shaded.emissive === undefined ? 'noem' : shaded.emissive.getHexString(),
    material.customProgramCacheKey(),
  ].join('|');
}

const SHADING_SCALAR_FIELDS = [
  'roughness',
  'metalness',
  'aoMapIntensity',
  'lightMapIntensity',
  'emissiveIntensity',
  'displacementScale',
  'displacementBias',
] as const;

function shadingScalarSignature(material: Material): string {
  type ScalarField = (typeof SHADING_SCALAR_FIELDS)[number];
  const scalars = material as Material & Partial<Record<ScalarField, number>>;
  const parts = SHADING_SCALAR_FIELDS.map((field) => {
    const value = scalars[field];
    return value === undefined ? '-' : String(value);
  });
  const normalScale = (material as Material & { normalScale?: Vector2 }).normalScale;
  parts.push(normalScale === undefined ? '-' : `${normalScale.x}:${normalScale.y}`);
  return parts.join(',');
}

interface BakedSurface {
  geometry: BufferGeometry;
  material: Material;
}

interface BoneDescriptor {
  parent: number;
  position: Vector3;
  quaternion: { x: number; y: number; z: number; w: number };
  scale: Vector3;
}

export interface RigBlueprint {
  jointIndex(node: Object3D): number;
  readonly jointCount: number;
  readonly surfaceCount: number;
  dispose(): void;
  readonly surfaces: readonly BakedSurface[];
  readonly bones: readonly BoneDescriptor[];
  readonly boneInverses: readonly Matrix4[];
  readonly bounds: Sphere;
}

export interface RigInstance {
  readonly root: Group;
  readonly joints: readonly Bone[];
  readonly meshes: readonly SkinnedMesh[];
  dispose(): void;
}

export function bakeRig(authoredRoot: Object3D): RigBlueprint {
  if (authoredRoot.parent !== null) {
    throw new Error('bakeRig: the authored root must be unparented');
  }
  authoredRoot.updateMatrixWorld(true);

  const nodes: Object3D[] = [];
  const bones: BoneDescriptor[] = [];
  const indexOf = new Map<Object3D, number>();
  const collect = (node: Object3D, parent: number): void => {
    const index = nodes.length;
    nodes.push(node);
    indexOf.set(node, index);
    bones.push({
      parent,
      position: node.position.clone(),
      quaternion: {
        x: node.quaternion.x,
        y: node.quaternion.y,
        z: node.quaternion.z,
        w: node.quaternion.w,
      },
      scale: node.scale.clone(),
    });
    for (const child of node.children) collect(child, index);
  };
  collect(authoredRoot, -1);

  const boneInverses = nodes.map((node) => node.matrixWorld.clone().invert());

  const grouped = new Map<string, { material: Material; pieces: BufferGeometry[] }>();
  let boundingRadius = 0;
  for (const node of nodes) {
    if (!isDrawableMesh(node)) continue;
    const material = node.material;
    const joint = indexOf.get(node)!;

    const piece = node.geometry.clone();
    const skinned = asSkinnedMesh(node);
    let reach: number;
    if (skinned === null) {
      piece.applyMatrix4(node.matrixWorld);
      bindRigidly(piece, joint);
      reach = poseInvariantReach(node);
    } else {
      reach = bakeSkinnedPiece(piece, skinned, indexOf);
    }
    paintVertexColor(piece, material);
    stripUnbakeableAttributes(piece, material);

    const signature = `${materialSignature(material)}|${piece.getIndex() === null ? 'flat' : 'indexed'}`;
    const group = grouped.get(signature);
    if (group === undefined) grouped.set(signature, { material, pieces: [piece] });
    else group.pieces.push(piece);

    boundingRadius = Math.max(boundingRadius, reach);
  }

  const surfaces: BakedSurface[] = [];
  for (const { material, pieces } of grouped.values()) {
    const geometry = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces, false);
    if (geometry === null) {
      throw new Error('bakeRig: could not merge parts that share a material signature');
    }
    for (const piece of pieces) {
      if (piece !== geometry) piece.dispose();
    }
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), boundingRadius);
    surfaces.push({ geometry, material: vertexColoured(material) });
  }

  const bounds = new Sphere(new Vector3(0, 0, 0), boundingRadius);
  let disposed = false;

  return {
    jointIndex(node: Object3D): number {
      const index = indexOf.get(node);
      if (index === undefined) throw new Error('bakeRig: node was not part of the baked rig');
      return index;
    },
    jointCount: nodes.length,
    surfaceCount: surfaces.length,
    surfaces,
    bones,
    boneInverses,
    bounds,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const maps = new Set<Texture>();
      for (const surface of surfaces) {
        surface.geometry.dispose();
        for (const texture of texturesOf(surface.material)) maps.add(texture);
        surface.material.dispose();
      }
      for (const map of maps) map.dispose();
    },
  };
}

export function instantiateRig(blueprint: RigBlueprint): RigInstance {
  const root = new Group();
  const joints: Bone[] = [];

  for (const descriptor of blueprint.bones) {
    const bone = new Bone();
    bone.position.copy(descriptor.position);
    bone.quaternion.set(
      descriptor.quaternion.x,
      descriptor.quaternion.y,
      descriptor.quaternion.z,
      descriptor.quaternion.w,
    );
    bone.scale.copy(descriptor.scale);
    joints.push(bone);
    if (descriptor.parent < 0) root.add(bone);
    else joints[descriptor.parent]!.add(bone);
  }

  const skeleton = new Skeleton(joints, blueprint.boneInverses.map((matrix) => matrix.clone()));

  const meshes: SkinnedMesh[] = [];
  for (const surface of blueprint.surfaces) {
    const mesh = new SkinnedMesh(surface.geometry, surface.material);
    root.add(mesh);
    mesh.bind(skeleton, new Matrix4());
    meshes.push(mesh);
  }

  let disposed = false;

  return {
    root,
    joints,
    meshes,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      skeleton.dispose();
    },
  };
}

function isDrawableMesh(node: Object3D): node is Mesh & { material: Material } {
  if (!(node as Mesh).isMesh) return false;
  const material = (node as Mesh).material;
  if (Array.isArray(material)) {
    throw new Error('bakeRig: a multi-material part cannot be baked — split it into parts');
  }
  return true;
}

function paintVertexColor(geometry: BufferGeometry, material: Material): void {
  const source = (material as Material & { color?: Color }).color;
  const colour = source ?? new Color(0xffffff);
  const count = geometry.getAttribute('position').count;
  const shade = geometry.getAttribute('color');
  const colors = new Float32Array(count * COLOR_COMPONENTS);
  for (let v = 0; v < count; v++) {
    colors[v * COLOR_COMPONENTS] = colour.r * (shade === undefined ? 1 : shade.getX(v));
    colors[v * COLOR_COMPONENTS + 1] = colour.g * (shade === undefined ? 1 : shade.getY(v));
    colors[v * COLOR_COMPONENTS + 2] = colour.b * (shade === undefined ? 1 : shade.getZ(v));
  }
  geometry.setAttribute('color', new BufferAttribute(colors, COLOR_COMPONENTS));
}

function bindRigidly(geometry: BufferGeometry, joint: number): void {
  const count = geometry.getAttribute('position').count;
  const indices = new Uint16Array(count * SKIN_INFLUENCES);
  const weights = new Float32Array(count * SKIN_INFLUENCES);
  for (let v = 0; v < count; v++) {
    indices[v * SKIN_INFLUENCES] = joint;
    weights[v * SKIN_INFLUENCES] = RIGID_BIND_WEIGHT;
  }
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, SKIN_INFLUENCES));
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, SKIN_INFLUENCES));
}

function asSkinnedMesh(node: Object3D): SkinnedMesh | null {
  return (node as Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh === true
    ? (node as SkinnedMesh)
    : null;
}

const SKIN_WEIGHT_SUM_TOLERANCE = 1e-3;

function bakeSkinnedPiece(
  piece: BufferGeometry,
  mesh: SkinnedMesh,
  indexOf: ReadonlyMap<Object3D, number>,
): number {
  const skeleton = mesh.skeleton;
  const bones = skeleton.bones;

  const remap = new Uint16Array(bones.length);
  const boneOffsets: Matrix4[] = [];
  const boneReach: number[] = [];
  const bonePositions: Vector3[] = [];
  for (let b = 0; b < bones.length; b++) {
    const bone = bones[b]!;
    const index = indexOf.get(bone);
    if (index === undefined) {
      throw new Error(
        `bakeRig: skinned mesh "${mesh.name || '(unnamed)'}" is weighted to bone ` +
          `"${bone.name || '(unnamed)'}", which is not part of the baked tree`,
      );
    }
    remap[b] = index;
    boneOffsets.push(new Matrix4().multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[b]!));
    boneReach.push(chainReach(bone).reach);
    bonePositions.push(new Vector3().setFromMatrixPosition(bone.matrixWorld));
  }

  const pre = mesh.bindMatrix;
  const post = new Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);

  const positions = piece.getAttribute('position');
  const normals = piece.getAttribute('normal');
  const sourceIndex = piece.getAttribute('skinIndex');
  const sourceWeight = piece.getAttribute('skinWeight');
  if (sourceIndex === undefined || sourceWeight === undefined) {
    throw new Error(
      `bakeRig: skinned mesh "${mesh.name || '(unnamed)'}" carries no skinIndex/skinWeight`,
    );
  }

  const count = positions.count;
  const bakedIndices = new Uint16Array(count * SKIN_INFLUENCES);
  const bakedWeights = new Float32Array(count * SKIN_INFLUENCES);
  const blended = new Matrix4();
  const normalMatrix = new Matrix3();
  const vertex = new Vector3();
  const weights = new Float32Array(SKIN_INFLUENCES);
  let reach = 0;

  for (let v = 0; v < count; v++) {
    let sum = 0;
    for (let i = 0; i < SKIN_INFLUENCES; i++) {
      const weight = sourceWeight.getComponent(v, i);
      weights[i] = weight;
      sum += weight;
    }
    if (sum <= 0) {
      weights[0] = RIGID_BIND_WEIGHT;
      sum = RIGID_BIND_WEIGHT;
    }
    if (Math.abs(sum - 1) > SKIN_WEIGHT_SUM_TOLERANCE) {
      for (let i = 0; i < SKIN_INFLUENCES; i++) weights[i]! /= sum;
    }

    blended.elements.fill(0);
    for (let i = 0; i < SKIN_INFLUENCES; i++) {
      const weight = weights[i]!;
      const bone = sourceIndex.getComponent(v, i);
      bakedIndices[v * SKIN_INFLUENCES + i] = remap[bone]!;
      bakedWeights[v * SKIN_INFLUENCES + i] = weight;
      if (weight === 0) continue;
      const offset = boneOffsets[bone]!.elements;
      for (let e = 0; e < MATRIX_ELEMENTS; e++) blended.elements[e]! += offset[e]! * weight;
    }
    blended.premultiply(post).multiply(pre);

    vertex.fromBufferAttribute(positions, v).applyMatrix4(blended);
    positions.setXYZ(v, vertex.x, vertex.y, vertex.z);
    if (normals !== undefined) {
      normalMatrix.getNormalMatrix(blended);
      vertex.fromBufferAttribute(normals, v).applyMatrix3(normalMatrix).normalize();
      normals.setXYZ(v, vertex.x, vertex.y, vertex.z);
    }

    vertex.fromBufferAttribute(positions, v);
    for (let i = 0; i < SKIN_INFLUENCES; i++) {
      if (weights[i] === 0) continue;
      const bone = sourceIndex.getComponent(v, i);
      const candidate = boneReach[bone]! + vertex.distanceTo(bonePositions[bone]!);
      if (candidate > reach) reach = candidate;
    }
  }

  positions.needsUpdate = true;
  if (normals !== undefined) normals.needsUpdate = true;
  piece.setAttribute('skinIndex', new BufferAttribute(bakedIndices, SKIN_INFLUENCES));
  piece.setAttribute('skinWeight', new BufferAttribute(bakedWeights, SKIN_INFLUENCES));
  return reach;
}

const BAKEABLE_UV_CHANNELS = [0, 1, 2, 3] as const;

function stripUnbakeableAttributes(geometry: BufferGeometry, material: Material): void {
  const sampled = uvChannelsUsed(material);
  for (const channel of sampled) {
    const attribute = uvAttributeName(channel);
    if (geometry.getAttribute(attribute) === undefined) {
      throw new Error(
        `bakeRig: a part's material samples uv channel ${channel} but the part carries no ` +
          `${attribute} attribute — a merge cannot invent coordinates, and drawing it ` +
          `unmapped would paint it one flat texel`,
      );
    }
  }
  for (const channel of BAKEABLE_UV_CHANNELS) {
    if (sampled.has(channel)) continue;
    const attribute = uvAttributeName(channel);
    if (geometry.getAttribute(attribute) !== undefined) geometry.deleteAttribute(attribute);
  }
  if (geometry.getAttribute('tangent') !== undefined) geometry.deleteAttribute('tangent');
  geometry.morphAttributes = {};
}

function vertexColoured(material: Material): Material {
  const clone = material.clone();
  clone.customProgramCacheKey = material.customProgramCacheKey;
  clone.vertexColors = true;
  const tinted = clone as Material & { color?: Color };
  if (tinted.color !== undefined) tinted.color = new Color(0xffffff);
  return clone;
}

function chainReach(node: Object3D): { reach: number; scale: number } {
  const chain: Object3D[] = [];
  for (let link: Object3D | null = node; link !== null; link = link.parent) chain.unshift(link);
  let reach = 0;
  let scale = 1;
  for (const link of chain) {
    reach += link.position.length() * scale;
    scale *= Math.max(link.scale.x, link.scale.y, link.scale.z);
  }
  return { reach, scale };
}

function poseInvariantReach(mesh: Mesh): number {
  const { reach, scale } = chainReach(mesh);
  const positions = mesh.geometry.getAttribute('position');
  let furthest = 0;
  for (let v = 0; v < positions.count; v++) {
    const x = positions.getX(v);
    const y = positions.getY(v);
    const z = positions.getZ(v);
    const distance = Math.sqrt(x * x + y * y + z * z);
    if (distance > furthest) furthest = distance;
  }
  return reach + furthest * scale;
}
