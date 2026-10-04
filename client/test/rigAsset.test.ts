import { describe, expect, it } from 'vitest';
import { BoxGeometry, SRGBColorSpace, Mesh, Vector3, type Texture } from 'three';
import {
  assertAssetFits,
  parseRigAsset,
  ASSET_FIT_TOLERANCE_WORLD_UNITS,
  RIG_TEXTURE_ANISOTROPY,
  type RigAsset,
} from '../src/render/rigAsset.ts';

function stubImageLoading(): void {
  const scope = globalThis as unknown as { document?: unknown; self?: unknown };
  if (scope.self === undefined) scope.self = globalThis;
  if (scope.document !== undefined) return;
  scope.document = {
    createElementNS: (): unknown => {
      const listeners = new Map<string, Array<() => void>>();
      const image = {
        width: 1,
        height: 1,
        addEventListener(type: string, listener: (this: unknown) => void): void {
          listeners.set(type, [...(listeners.get(type) ?? []), () => listener.call(image)]);
        },
        removeEventListener(type: string, listener: (this: unknown) => void): void {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((kept) => kept !== listener),
          );
        },
        set src(_url: string) {
          queueMicrotask(() => {
            for (const listener of listeners.get('load') ?? []) listener();
          });
        },
      };
      return image;
    },
  };
}

stubImageLoading();

const PIXEL_PNG =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Plain typed arrays: node's Buffer typings no longer satisfy Uint8Array under this TS lib.
function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function texturedTriangle(withUv: boolean): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const bytes = concatBytes([bytesOf(positions), bytesOf(uvs)]);
  const gltf = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ name: 'hull', mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: withUv ? { POSITION: 0, TEXCOORD_0: 1 } : { POSITION: 0 },
            material: 0,
          },
        ],
      },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: PIXEL_PNG }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength },
    ],
    buffers: [{ byteLength: bytes.byteLength }],
  };
  return packGlb(utf8(JSON.stringify(gltf)), bytes);
}

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;
const GLB_CHUNK_ALIGNMENT = 4;
const GLB_JSON_PAD = 0x20;
const GLB_BIN_PAD = 0x00;

function packGlb(json: Uint8Array, bin: Uint8Array): ArrayBuffer {
  const pad = (chunk: Uint8Array, filler: number): Uint8Array => {
    const short = (GLB_CHUNK_ALIGNMENT - (chunk.byteLength % GLB_CHUNK_ALIGNMENT)) % GLB_CHUNK_ALIGNMENT;
    return short === 0 ? chunk : concatBytes([chunk, new Uint8Array(short).fill(filler)]);
  };
  const jsonChunk = pad(json, GLB_JSON_PAD);
  const binChunk = pad(bin, GLB_BIN_PAD);
  const header = new Uint8Array(12);
  const chunkHeader = (length: number, type: number): Uint8Array => {
    const head = new Uint8Array(8);
    const view = new DataView(head.buffer);
    view.setUint32(0, length, true);
    view.setUint32(4, type, true);
    return head;
  };
  const body = concatBytes([
    chunkHeader(jsonChunk.byteLength, GLB_CHUNK_JSON),
    jsonChunk,
    chunkHeader(binChunk.byteLength, GLB_CHUNK_BIN),
    binChunk,
  ]);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, GLB_MAGIC, true);
  headerView.setUint32(4, GLB_VERSION, true);
  headerView.setUint32(8, header.byteLength + body.byteLength, true);
  return concatBytes([header, body]).buffer;
}

function skinnedTriangle(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const joints = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const bytes = concatBytes([bytesOf(positions), bytesOf(joints), bytesOf(weights)]);
  const jointsOffset = positions.byteLength;
  const weightsOffset = jointsOffset + joints.byteLength;
  const gltf = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
    nodes: [{ name: 'hull', mesh: 0, skin: 0 }, { name: 'joint' }],
    skins: [{ joints: [1] }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, material: 0 }] },
    ],
    materials: [{}],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: jointsOffset, byteLength: joints.byteLength },
      { buffer: 0, byteOffset: weightsOffset, byteLength: weights.byteLength },
    ],
    buffers: [{ byteLength: bytes.byteLength }],
  };
  return packGlb(utf8(JSON.stringify(gltf)), bytes);
}

function assetOfSize(size: Vector3): RigAsset {
  const scene = new Mesh(new BoxGeometry(size.x, size.y, size.z));
  return {
    scene,
    node: () => scene,
    anchor: () => new Vector3(),
    dispose: () => scene.geometry.dispose(),
  };
}

describe('rigAsset', () => {
  it('rejects a mesh drawn under a mapped material with no uv', async () => {
    await expect(parseRigAsset(texturedTriangle(false), 'unwrapped.glb')).rejects.toThrow(
      /"unwrapped\.glb".*no uv attribute/s,
    );
  });

  it('gives every loaded colour texture sRGB and the rig anisotropy', async () => {
    const asset = await parseRigAsset(texturedTriangle(true), 'wrapped.glb');
    let map: Texture | null = null;
    asset.scene.traverse((child) => {
      if (child instanceof Mesh) map = (child.material as { map: Texture }).map;
    });
    expect(map).not.toBeNull();
    expect(map!.colorSpace).toBe(SRGBColorSpace);
    expect(map!.anisotropy).toBe(RIG_TEXTURE_ANISOTROPY);
    asset.dispose();
  });

  it('accepts an armature and hands the skinned mesh through', async () => {
    const asset = await parseRigAsset(skinnedTriangle(), 'rigged.glb');
    let skinned = 0;
    asset.scene.traverse((child) => {
      if ((child as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) skinned++;
    });
    expect(skinned).toBe(1);
    asset.dispose();
  });
});

describe('assertAssetFits', () => {
  it('passes a model exactly one tolerance over its footprint', () => {
    const over = 1 + ASSET_FIT_TOLERANCE_WORLD_UNITS;
    expect(() =>
      assertAssetFits(assetOfSize(new Vector3(over, 3, over)), { x: 1, z: 1 }),
    ).not.toThrow();
  });

  it('rejects a model past the tolerance, naming the axis and the number', () => {
    const past = 1 + ASSET_FIT_TOLERANCE_WORLD_UNITS * 2;
    expect(() => assertAssetFits(assetOfSize(new Vector3(past, 1, 1)), { x: 1, z: 1 })).toThrow(
      /x 1\.040 > 1/,
    );
  });

  it('budgets height only when the caller asks for one', () => {
    const tall = assetOfSize(new Vector3(1, 4, 1));
    expect(() => assertAssetFits(tall, { x: 1, z: 1 })).not.toThrow();
    expect(() => assertAssetFits(tall, { x: 1, z: 1, y: 2 })).toThrow(/y 4\.000 > 2/);
  });
});
