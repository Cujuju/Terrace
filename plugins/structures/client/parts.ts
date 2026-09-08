import {
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Color,
  type Material,
} from 'three';
import {
  mapIdentitySignature,
  uvAttributeName,
  uvChannelsUsed,
} from '../../../client/src/render/materialMaps.ts';

export interface StructurePart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly localMatrices: Matrix4[];
}

export const Y_AXIS = new Vector3(0, 1, 0);
export const X_AXIS = new Vector3(1, 0, 0);

export const FULL_TURN_RADIANS = Math.PI * 2;

export function lambert(
  color: number,
  options: { emissive?: number; emissiveIntensity?: number } = {},
): MeshLambertMaterial {
  return new MeshLambertMaterial({
    color,
    flatShading: true,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1,
  });
}

export function at(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}

export function pose(
  x: number,
  y: number,
  z: number,
  yaw = 0,
  scale: Vector3 = new Vector3(1, 1, 1),
): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromAxisAngle(Y_AXIS, yaw),
    scale,
  );
}

export function composed(
  position: Vector3,
  rotation: Quaternion,
  scale: Vector3,
): Matrix4 {
  return new Matrix4().compose(position, rotation, scale);
}

export function ringMatrices(
  count: number,
  radius: number,
  y: number,
  faceOutward: boolean,
  tiltX = 0,
  startAngleRadians = 0,
): Matrix4[] {
  const matrices: Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const angle = startAngleRadians + (FULL_TURN_RADIANS * i) / count;
    const matrix = pose(Math.sin(angle) * radius, y, Math.cos(angle) * radius, faceOutward ? angle : 0);
    if (tiltX !== 0) matrix.multiply(new Matrix4().makeRotationX(tiltX));
    matrices.push(matrix);
  }
  return matrices;
}

const COLOR_COMPONENTS = 3;

const SURFACE_MERGE_MINIMUM_PARTS = 2;

export function canShareOneSurface(material: Material): material is MeshLambertMaterial {
  if (!(material instanceof MeshLambertMaterial)) return false;
  if (uvChannelsUsed(material).size > 0) return false;
  if (material.emissive.getHex() !== 0x000000) return false;
  if (material.transparent || material.opacity < 1) return false;
  if (!material.flatShading) return false;
  if (material.side !== FrontSide) return false;
  return true;
}

function materialSignature(material: Material): string {
  const lambertLike = material as MeshLambertMaterial;
  return [
    material.type,
    lambertLike.color?.getHex() ?? -1,
    lambertLike.emissive?.getHex() ?? -1,
    lambertLike.emissiveIntensity ?? 1,
    lambertLike.flatShading === true ? 1 : 0,
    material.transparent === true ? 1 : 0,
    material.opacity,
    material.side,
    mapIdentitySignature(material),
  ].join('|');
}

const UV_COMPONENTS = 2;

interface MergeGroupData {
  positions: number[];
  normals: number[];
  colors?: number[];
  uvs?: Map<string, number[]>;
}

function uvArraysFor(material: Material): Map<string, number[]> | undefined {
  const channels = uvChannelsUsed(material);
  if (channels.size === 0) return undefined;
  const uvs = new Map<string, number[]>();
  for (const channel of channels) uvs.set(uvAttributeName(channel), []);
  return uvs;
}

function bakeInto(
  target: MergeGroupData,
  geometry: BufferGeometry,
  local: Matrix4,
  color?: Color,
): void {
  const baked = (geometry.index === null ? geometry.clone() : geometry.toNonIndexed());
  baked.applyMatrix4(local);
  const position = baked.getAttribute('position');
  const normal = baked.getAttribute('normal');
  const uvSources: Array<{ target: number[]; source: BufferAttribute }> = [];
  for (const [attribute, values] of target.uvs ?? []) {
    const source = baked.getAttribute(attribute) as BufferAttribute | undefined;
    if (source === undefined) {
      baked.dispose();
      throw new Error(
        `mergeParts: a part whose material samples uv channel "${attribute}" carries no ` +
          `such attribute — it cannot share a merged surface`,
      );
    }
    uvSources.push({ target: values, source });
  }
  for (let i = 0; i < position.count; i++) {
    target.positions.push(position.getX(i), position.getY(i), position.getZ(i));
    if (normal !== undefined) target.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    if (target.colors !== undefined && color !== undefined) {
      target.colors.push(color.r, color.g, color.b);
    }
    for (const { target: values, source } of uvSources) {
      values.push(source.getX(i), source.getY(i));
    }
  }
  baked.dispose();
}

function geometryOf(group: MergeGroupData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(group.positions), 3));
  if (group.normals.length === group.positions.length) {
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(group.normals), 3));
  } else {
    geometry.computeVertexNormals();
  }
  if (group.colors !== undefined) {
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(group.colors), COLOR_COMPONENTS));
  }
  for (const [attribute, values] of group.uvs ?? []) {
    geometry.setAttribute(attribute, new BufferAttribute(new Float32Array(values), UV_COMPONENTS));
  }
  return geometry;
}

export function mergeSharedSurface(parts: readonly StructurePart[]): StructurePart[] {
  const { surface, rest } = collapseSharedSurface(parts);
  return surface === null ? [...parts] : [surface, ...rest];
}

function collapseSharedSurface(
  parts: readonly StructurePart[],
): { surface: StructurePart | null; rest: readonly StructurePart[] } {
  const shareable: { part: StructurePart; material: MeshLambertMaterial }[] = [];
  for (const part of parts) {
    if (canShareOneSurface(part.material)) shareable.push({ part, material: part.material });
  }
  if (shareable.length < SURFACE_MERGE_MINIMUM_PARTS) return { surface: null, rest: parts };

  const surface: { positions: number[]; normals: number[]; colors: number[] } =
    { positions: [], normals: [], colors: [] };
  const spentGeometries = new Set<BufferGeometry>();
  const spentMaterials = new Set<Material>();
  for (const { part, material } of shareable) {
    for (const local of part.localMatrices) bakeInto(surface, part.geometry, local, material.color);
    spentGeometries.add(part.geometry);
    spentMaterials.add(material);
  }
  for (const geometry of spentGeometries) geometry.dispose();
  for (const material of spentMaterials) material.dispose();
  return {
    surface: {
      geometry: geometryOf(surface),
      material: new MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      localMatrices: [new Matrix4()],
    },
    rest: parts.filter((part) => !canShareOneSurface(part.material)),
  };
}

export function mergeParts(parts: readonly StructurePart[]): StructurePart[] {
  const { surface, rest } = collapseSharedSurface(parts);
  const spentGeometries = new Set<BufferGeometry>();
  const spentMaterials = new Set<Material>();
  const merged: StructurePart[] = [];
  if (surface !== null) merged.push(surface);

  const groups = new Map<string, MergeGroupData & { material: Material }>();
  for (const part of rest) {
    const signature = materialSignature(part.material);
    let group = groups.get(signature);
    if (group === undefined) {
      group = {
        material: part.material,
        positions: [],
        normals: [],
        uvs: uvArraysFor(part.material),
      };
      groups.set(signature, group);
    } else if (group.material !== part.material) {
      spentMaterials.add(part.material);
    }
    for (const local of part.localMatrices) bakeInto(group, part.geometry, local);
    spentGeometries.add(part.geometry);
  }

  for (const group of groups.values()) {
    merged.push({ geometry: geometryOf(group), material: group.material, localMatrices: [new Matrix4()] });
  }

  for (const geometry of spentGeometries) geometry.dispose();
  for (const material of spentMaterials) {
    if (!merged.some((part) => part.material === material)) material.dispose();
  }
  return merged;
}

function forEachVertex(parts: readonly StructurePart[], visit: (vertex: Vector3) => void): void {
  const vertex = new Vector3();
  for (const part of parts) {
    const position = part.geometry.getAttribute('position');
    if (position === undefined) continue;
    for (const local of part.localMatrices) {
      for (let i = 0; i < position.count; i++) {
        visit(vertex.fromBufferAttribute(position as BufferAttribute, i).applyMatrix4(local));
      }
    }
  }
}

export function partsRadialReach(parts: readonly StructurePart[]): number {
  let reach = 0;
  forEachVertex(parts, (vertex) => {
    reach = Math.max(reach, Math.hypot(vertex.x, vertex.z));
  });
  return reach;
}

export function fitToRadius(parts: readonly StructurePart[], maxRadius: number): StructurePart[] {
  const reach = partsRadialReach(parts);
  if (reach <= maxRadius || reach === 0) return parts.map((part) => part);
  const FIT_SAFETY_MARGIN = 0.999;
  const target = maxRadius * FIT_SAFETY_MARGIN;
  const shrink = new Matrix4().makeScale(target / reach, target / reach, target / reach);
  return parts.map((part) => ({
    geometry: part.geometry,
    material: part.material,
    localMatrices: part.localMatrices.map((local) => new Matrix4().multiplyMatrices(shrink, local)),
  }));
}

export function partsStandingHeight(parts: readonly StructurePart[]): number {
  let height = 0;
  forEachVertex(parts, (vertex) => {
    height = Math.max(height, vertex.y);
  });
  return height;
}

export function partsReach(parts: readonly StructurePart[]): number {
  let reach = 0;
  forEachVertex(parts, (vertex) => {
    reach = Math.max(reach, Math.abs(vertex.x), Math.abs(vertex.z));
  });
  return reach;
}
