import {
  BufferGeometry,
  CatmullRomCurve3,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  SphereGeometry,
  Texture,
  Vector3,
  type Material,
  type MeshLambertMaterialParameters,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshLambertNodeMaterial, type Node } from 'three/webgpu';
import {
  abs,
  max,
  normalGeometry,
  normalize,
  positionGeometry,
  pow,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { compose, discard } from '../../../client/src/render/materialSlots.ts';
import type { MoverGait } from '../../../client/src/plugins/kit/moverGait.ts';
import type { RigBlueprint } from '../../../client/src/render/rigSkin.ts';

export const MONSTER_MODEL_DETAIL = 4;

export const WELD_TOLERANCE = 1e-3;

export const TWO_PI = Math.PI * 2;
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const NOISE_SEED = 0.6180339887;
const NOISE_OCTAVES = 3;
const NOISE_LACUNARITY = 2.17;
const NOISE_GAIN = 0.5;
const NOISE_AXIS_RATIO_Y = 1.31;
const NOISE_AXIS_RATIO_Z = 0.83;

export const NOISE_CHANNEL_WRINKLE = 0;
export const NOISE_CHANNEL_SHADE = 1;
export const NOISE_CHANNEL_TENTACLE = 2;

export function organicNoise(x: number, y: number, z: number, channel: number): number {
  const seed = NOISE_SEED + channel * GOLDEN_ANGLE;
  let value = 0;
  let amplitude = 1;
  let weight = 0;
  let frequency = 1;
  for (let octave = 0; octave < NOISE_OCTAVES; octave++) {
    const phase = seed * (octave + 1);
    value +=
      amplitude *
      Math.sin(frequency * x + phase) *
      Math.sin(frequency * y * NOISE_AXIS_RATIO_Y + phase * 2) *
      Math.sin(frequency * z * NOISE_AXIS_RATIO_Z + phase * 3);
    weight += amplitude;
    amplitude *= NOISE_GAIN;
    frequency *= NOISE_LACUNARITY;
  }
  return value / weight;
}

export function positionsOnly(geometry: BufferGeometry): BufferGeometry {
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  return geometry;
}

export function carveWrinkles(geometry: BufferGeometry, depth: number, frequency: number): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const bite =
      depth * (0.5 + 0.5 * organicNoise(x * frequency, y * frequency, z * frequency, NOISE_CHANNEL_WRINKLE));
    position.setXYZ(
      index,
      x - normal.getX(index) * bite,
      y - normal.getY(index) * bite,
      z - normal.getZ(index) * bite,
    );
  }
  position.needsUpdate = true;
}

export function applyShadeVariation(
  geometry: BufferGeometry,
  variation: number,
  frequency: number,
): void {
  const position = geometry.getAttribute('position');
  const shades = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const shade =
      1 +
      variation *
        organicNoise(
          position.getX(index) * frequency,
          position.getY(index) * frequency,
          position.getZ(index) * frequency,
          NOISE_CHANNEL_SHADE,
        );
    shades[index * 3] = shade;
    shades[index * 3 + 1] = shade;
    shades[index * 3 + 2] = shade;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(shades, 3));
}

export const FUR_TEXTURE_SIZE = 128;

const FUR_STRAND_COUNT = 26;
const FUR_LOCK_COUNT = 7;

const FUR_WARP_WAVES = [
  { across: 7, along: 2, amplitude: 0.012, phase: 0.7 },
  { across: 13, along: 5, amplitude: 0.005, phase: 2.9 },
] as const;

const FUR_PARTING_DEPTH = 0.3;
const FUR_PARTING_SHARPNESS = 2.6;
const FUR_LOCK_PARTING_DEPTH = 0.07;
const FUR_LOCK_PARTING_SHARPNESS = 3;

const FUR_BREAK_SPREAD = 0.45;
const FUR_BREAK_ALONG = 3;
const FUR_BREAK_ACROSS = 11;

const FUR_TONE_SPREAD = 0.05;
const FUR_TONE_COUNT = 9;

const FUR_SHADE_FLOOR = 0.6;

const FUR_TEXEL_BYTES = 4;
const FUR_CHANNEL_MAX = 255;

const FUR_BLEND_SHARPNESS = 4;

export function furShadeTexture(): DataTexture {
  const data = new Uint8Array(FUR_TEXTURE_SIZE * FUR_TEXTURE_SIZE * FUR_TEXEL_BYTES);
  for (let row = 0; row < FUR_TEXTURE_SIZE; row++) {
    const along = row / FUR_TEXTURE_SIZE;
    for (let column = 0; column < FUR_TEXTURE_SIZE; column++) {
      const across = column / FUR_TEXTURE_SIZE;

      let wander = across;
      for (const wave of FUR_WARP_WAVES) {
        wander +=
          wave.amplitude *
          Math.cos(TWO_PI * (wave.across * across + wave.along * along) + wave.phase);
      }

      const parted = 0.5 - 0.5 * Math.cos(TWO_PI * FUR_STRAND_COUNT * wander);
      const lockParted = 0.5 - 0.5 * Math.cos(TWO_PI * FUR_LOCK_COUNT * wander);

      const broken =
        1 -
        FUR_BREAK_SPREAD *
          (0.5 - 0.5 * Math.cos(TWO_PI * (FUR_BREAK_ALONG * along + FUR_BREAK_ACROSS * across)));

      const tone = 1 + FUR_TONE_SPREAD * Math.cos(TWO_PI * FUR_TONE_COUNT * wander);

      const shade =
        tone *
        (1 -
          FUR_PARTING_DEPTH * Math.pow(parted, FUR_PARTING_SHARPNESS) * broken -
          FUR_LOCK_PARTING_DEPTH * Math.pow(lockParted, FUR_LOCK_PARTING_SHARPNESS));
      const byte = Math.round(Math.min(1, Math.max(FUR_SHADE_FLOOR, shade)) * FUR_CHANNEL_MAX);
      const texel = (row * FUR_TEXTURE_SIZE + column) * FUR_TEXEL_BYTES;
      data[texel] = byte;
      data[texel + 1] = byte;
      data[texel + 2] = byte;
      data[texel + 3] = FUR_CHANNEL_MAX;
    }
  }
  const texture = new DataTexture(data, FUR_TEXTURE_SIZE, FUR_TEXTURE_SIZE, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const FUR_AXIS_WEIGHT_FLOOR = 1e-5;

// Object-space triplanar: the fur texture projected along each axis, blended by the normal's facing.
function triplanarFurSample(furMap: Texture, furFrequency: Node<'float'>): Node<'float'> {
  const furAxisRaw = pow(abs(normalize(normalGeometry)), vec3(FUR_BLEND_SHARPNESS));
  const furAxis = furAxisRaw.div(
    max(furAxisRaw.x.add(furAxisRaw.y).add(furAxisRaw.z), FUR_AXIS_WEIGHT_FLOOR),
  );
  const furAt = positionGeometry.mul(furFrequency);
  return texture(furMap, vec2(furAt.z, furAt.y))
    .r.mul(furAxis.x)
    .add(texture(furMap, vec2(furAt.x, furAt.z)).r.mul(furAxis.y))
    .add(texture(furMap, vec2(furAt.x, furAt.y)).r.mul(furAxis.z));
}

// bakeRig merges parts whose materials share a program key, which NodeMaterial hashes from node
// identity; fur of one frequency therefore reuses one node, as it once reused one program key.
interface FurNodeCache {
  readonly furColors: Map<string, Node<'vec3'>>;
  readonly shellConditions: Map<string, Node<'bool'>>;
}

function applyFurShader(
  material: MeshLambertNodeMaterial,
  texture: Texture,
  frequency: number,
  { furColors }: FurNodeCache,
): void {
  compose(material, 'color', (previous) => {
    const key = `${previous.id}|${frequency}`;
    let furColor = furColors.get(key);
    if (furColor === undefined) {
      furColor = previous.mul(triplanarFurSample(texture, uniform(frequency)));
      furColors.set(key, furColor);
    }
    return furColor;
  });
}

const FUR_STRAND_SHARPNESS = 2.2;
const FUR_STRAND_LENGTH_SPREAD = 0.55;
const FUR_STRAND_LENGTH_ALONG = 5;
const FUR_STRAND_LENGTH_ACROSS = 3;

export function furStrandAlphaTexture(): DataTexture {
  const data = new Uint8Array(FUR_TEXTURE_SIZE * FUR_TEXTURE_SIZE * FUR_TEXEL_BYTES);
  for (let row = 0; row < FUR_TEXTURE_SIZE; row++) {
    const along = row / FUR_TEXTURE_SIZE;
    for (let column = 0; column < FUR_TEXTURE_SIZE; column++) {
      const across = column / FUR_TEXTURE_SIZE;
      let wander = across;
      for (const wave of FUR_WARP_WAVES) {
        wander +=
          wave.amplitude *
          Math.cos(TWO_PI * (wave.across * across + wave.along * along) + wave.phase);
      }
      const core = 0.5 + 0.5 * Math.cos(TWO_PI * FUR_STRAND_COUNT * wander);
      const length =
        1 -
        FUR_STRAND_LENGTH_SPREAD *
          (0.5 -
            0.5 *
              Math.cos(
                TWO_PI * (FUR_STRAND_LENGTH_ALONG * along + FUR_STRAND_LENGTH_ACROSS * across),
              ));
      const strength = Math.pow(core, FUR_STRAND_SHARPNESS) * length;
      const byte = Math.round(Math.min(1, Math.max(0, strength)) * FUR_CHANNEL_MAX);
      const texel = (row * FUR_TEXTURE_SIZE + column) * FUR_TEXEL_BYTES;
      data[texel] = byte;
      data[texel + 1] = byte;
      data[texel + 2] = byte;
      data[texel + 3] = FUR_CHANNEL_MAX;
    }
  }
  const texture = new DataTexture(data, FUR_TEXTURE_SIZE, FUR_TEXTURE_SIZE, RGBAFormat);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const SHELL_ALPHA_THRESHOLD_BASE = 0.16;
const SHELL_ALPHA_THRESHOLD_RANGE = 0.52;

function applyShellShader(
  material: MeshLambertNodeMaterial,
  texture: Texture,
  frequency: number,
  threshold: number,
  { shellConditions }: FurNodeCache,
): void {
  const key = `${frequency}|${threshold}`;
  let condition = shellConditions.get(key);
  if (condition === undefined) {
    condition = triplanarFurSample(texture, uniform(frequency)).lessThan(threshold);
    shellConditions.set(key, condition);
  }
  discard(material, condition);
}

export function ellipsoid(
  length: number,
  height: number,
  width: number,
  segments: number,
  rings: number,
  center?: Vector3,
): BufferGeometry {
  const geometry = new SphereGeometry(0.5, segments, rings);
  geometry.scale(length, height, width);
  if (center !== undefined) geometry.translate(center.x, center.y, center.z);
  return positionsOnly(geometry);
}

export const ARC_CONTROL_POINTS = 5;

export function curlArc(
  length: number,
  turnRadians: number,
  drift: number,
  minTurnRadians: number,
): CatmullRomCurve3 {
  const turn = Math.max(minTurnRadians, turnRadians);
  const radius = length / turn;
  const points: Vector3[] = [];
  for (let step = 0; step <= ARC_CONTROL_POINTS; step++) {
    const along = step / ARC_CONTROL_POINTS;
    const angle = along * turn;
    points.push(
      new Vector3(
        -radius * (1 - Math.cos(angle)),
        -radius * Math.sin(angle),
        drift * Math.sin(Math.PI * along),
      ),
    );
  }
  return new CatmullRomCurve3(points);
}

export function taperedTube(
  curve: CatmullRomCurve3,
  radiusAt: (along: number) => number,
  pathSegments: number,
  radialSegments: number,
): BufferGeometry {
  const frames = curve.computeFrenetFrames(pathSegments, false);
  const positions: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();

  for (let ring = 0; ring <= pathSegments; ring++) {
    const along = ring / pathSegments;
    curve.getPointAt(along, point);
    const normal = frames.normals[ring]!;
    const binormal = frames.binormals[ring]!;
    const radius = radiusAt(along);
    for (let side = 0; side < radialSegments; side++) {
      const angle = (side / radialSegments) * TWO_PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(
        point.x + radius * (cos * normal.x + sin * binormal.x),
        point.y + radius * (cos * normal.y + sin * binormal.y),
        point.z + radius * (cos * normal.z + sin * binormal.z),
      );
    }
  }

  for (let ring = 0; ring < pathSegments; ring++) {
    for (let side = 0; side < radialSegments; side++) {
      const here = ring * radialSegments + side;
      const next = ring * radialSegments + ((side + 1) % radialSegments);
      indices.push(here, next, next + radialSegments);
      indices.push(here, next + radialSegments, here + radialSegments);
    }
  }

  const tipIndex = positions.length / 3;
  curve.getPointAt(1, point);
  positions.push(point.x, point.y, point.z);
  const lastRing = pathSegments * radialSegments;
  for (let side = 0; side < radialSegments; side++) {
    indices.push(lastRing + side, lastRing + ((side + 1) % radialSegments), tipIndex);
  }

  const rootIndex = positions.length / 3;
  curve.getPointAt(0, point);
  positions.push(point.x, point.y, point.z);
  for (let side = 0; side < radialSegments; side++) {
    indices.push(((side + 1) % radialSegments), side, rootIndex);
  }

  const tube = new BufferGeometry();
  tube.setAttribute('position', new Float32BufferAttribute(positions, 3));
  tube.setIndex(indices);
  return tube;
}

export function membranePanel(
  left: CatmullRomCurve3,
  right: CatmullRomCurve3,
  hub: Vector3,
  sagDirection: Vector3,
  scallop: number,
  sag: number,
  spanSegments: number,
  ridgeSegments: number,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const leftPoint = new Vector3();
  const rightPoint = new Vector3();
  const vertex = new Vector3();

  for (let spanStep = 0; spanStep <= spanSegments; spanStep++) {
    const span = spanStep / spanSegments;
    const slack = Math.sin(Math.PI * span);
    for (let ridgeStep = 0; ridgeStep <= ridgeSegments; ridgeStep++) {
      const along = ridgeStep / ridgeSegments;
      left.getPointAt(along, leftPoint);
      right.getPointAt(along, rightPoint);
      vertex.copy(leftPoint).lerp(rightPoint, span);
      vertex.sub(hub).multiplyScalar(1 - scallop * slack).add(hub);
      vertex.addScaledVector(sagDirection, sag * slack * along);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }

  const stride = ridgeSegments + 1;
  for (let spanStep = 0; spanStep < spanSegments; spanStep++) {
    for (let ridgeStep = 0; ridgeStep < ridgeSegments; ridgeStep++) {
      const corner = spanStep * stride + ridgeStep;
      indices.push(corner, corner + 1, corner + stride + 1);
      indices.push(corner, corner + stride + 1, corner + stride);
    }
  }

  const panel = new BufferGeometry();
  panel.setAttribute('position', new Float32BufferAttribute(positions, 3));
  panel.setIndex(indices);
  return panel;
}

export interface MonsterModel {
  readonly root: Group;
  animate(seconds: number, phase: number, gait?: MoverGait): void;
  dispose(): void;
}

export interface SkinFinish {
  readonly wrinkleDepth: number;
  readonly wrinkleFrequency: number;
  readonly shadeVariation: number;
  readonly shadeFrequency: number;
}

export interface LambertOptions {
  readonly emissive?: number;
  readonly doubleSided?: boolean;
  readonly shaded?: boolean;
  readonly furFrequency?: number;
}

export interface ModelWorkshop {
  segments(base: number): number;
  keepGeometry<T extends BufferGeometry>(geometry: T): T;
  keepMaterial<T extends Material>(material: T): T;
  keepRig<T extends RigBlueprint>(blueprint: T): T;
  lambert(color: number, options?: LambertOptions): MeshLambertNodeMaterial;
  shellMaterial(
    color: number,
    layer: number,
    layers: number,
    furFrequency: number,
  ): MeshLambertNodeMaterial;
  organicSurface(parts: BufferGeometry[], skin: SkinFinish): BufferGeometry;
  dispose(): void;
}

export function createWorkshop(): ModelWorkshop {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const rigs: RigBlueprint[] = [];
  let furTexture: DataTexture | undefined;
  let strandTexture: DataTexture | undefined;
  const furNodes: FurNodeCache = { furColors: new Map(), shellConditions: new Map() };

  function keepGeometry<T extends BufferGeometry>(geometry: T): T {
    geometries.push(geometry);
    return geometry;
  }

  function keepMaterial<T extends Material>(material: T): T {
    materials.push(material);
    return material;
  }

  function keepRig<T extends RigBlueprint>(blueprint: T): T {
    rigs.push(blueprint);
    return blueprint;
  }

  return {
    segments(base: number): number {
      return Math.max(3, Math.round(base * MONSTER_MODEL_DETAIL));
    },

    keepGeometry,
    keepMaterial,
    keepRig,

    lambert(color: number, options: LambertOptions = {}): MeshLambertNodeMaterial {
      const parameters: MeshLambertMaterialParameters = {
        color,
        flatShading: false,
        vertexColors: options.shaded !== false,
      };
      if (options.emissive !== undefined) parameters.emissive = options.emissive;
      if (options.doubleSided === true) parameters.side = DoubleSide;
      const material = new MeshLambertNodeMaterial(parameters);
      if (options.furFrequency !== undefined) {
        if (furTexture === undefined) furTexture = furShadeTexture();
        applyFurShader(material, furTexture, options.furFrequency, furNodes);
      }
      return keepMaterial(material);
    },

    shellMaterial(
      color: number,
      layer: number,
      layers: number,
      furFrequency: number,
    ): MeshLambertNodeMaterial {
      if (strandTexture === undefined) strandTexture = furStrandAlphaTexture();
      const material = new MeshLambertNodeMaterial({
        color,
        flatShading: false,
        vertexColors: true,
      });
      applyShellShader(
        material,
        strandTexture,
        furFrequency,
        SHELL_ALPHA_THRESHOLD_BASE + (layer / layers) * SHELL_ALPHA_THRESHOLD_RANGE,
        furNodes,
      );
      return keepMaterial(material);
    },

    organicSurface(parts: BufferGeometry[], skin: SkinFinish): BufferGeometry {
      const merged = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      const welded = mergeVertices(merged, WELD_TOLERANCE);
      merged.dispose();
      welded.computeVertexNormals();
      if (skin.wrinkleDepth > 0) {
        carveWrinkles(welded, skin.wrinkleDepth, skin.wrinkleFrequency);
        welded.computeVertexNormals();
      }
      applyShadeVariation(welded, skin.shadeVariation, skin.shadeFrequency);
      return keepGeometry(welded);
    },

    dispose(): void {
      for (const rig of rigs) rig.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      furTexture?.dispose();
      furTexture = undefined;
      strandTexture?.dispose();
      strandTexture = undefined;
      furNodes.furColors.clear();
      furNodes.shellConditions.clear();
      rigs.length = 0;
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
