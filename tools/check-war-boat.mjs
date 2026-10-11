import { readFile } from 'node:fs/promises';
import { parseRigAsset } from '../client/src/render/rigAsset.ts';

const scope = globalThis;
if (scope.self === undefined) scope.self = globalThis;
if (scope.document === undefined) {
  scope.document = {
    createElementNS: () => {
      const listeners = new Map();
      const image = {
        width: 256,
        height: 256,
        addEventListener(type, listener) {
          listeners.set(type, [...(listeners.get(type) ?? []), () => listener.call(image)]);
        },
        removeEventListener(type, listener) {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((kept) => kept !== listener),
          );
        },
        set src(_url) {
          queueMicrotask(() => {
            for (const listener of listeners.get('load') ?? []) listener();
          });
        },
      };
      return image;
    },
  };
}

const url = new URL('../plugins/boats/client/assets/war-boat.glb', import.meta.url);
const buffer = await readFile(url);
const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const asset = await parseRigAsset(bytes, 'war-boat.glb');
asset.scene.updateMatrixWorld(true);

console.log('nodes:');
asset.scene.traverse((child) => {
  const kind = child.isMesh === true ? 'mesh' : child.type === 'Object3D' ? 'empty' : child.type;
  console.log(`  ${child.name || '(unnamed root)'} [${kind}]`);
});

console.log('anchors:');
for (const name of ['waterline', 'deck_top', 'fire_top']) {
  const at = asset.anchor(name);
  console.log(`  ${name} = (${at.x.toFixed(3)}, ${at.y.toFixed(3)}, ${at.z.toFixed(3)})`);
}

console.log('meshes:');
let totalTris = 0;
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
asset.scene.traverse((child) => {
  if (child.isMesh !== true) return;
  const geometry = child.geometry;
  const tris = geometry.index !== null ? geometry.index.count / 3 : geometry.position.count / 3;
  totalTris += tris;
  const material = child.material;
  const map = material.map ?? null;
  const uv = geometry.getAttribute('uv') !== undefined;
  const mapInfo = map === null ? 'flat' : `mapped colorSpace=${map.colorSpace} aniso=${map.anisotropy}`;
  console.log(`  ${child.name}: ${tris} tris, uv=${uv ? 'yes' : 'no'}, ${mapInfo}`);
  const position = geometry.getAttribute('position');
  const e = child.matrixWorld.elements;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const world = [
      (e[0] * x + e[4] * y + e[8] * z + e[12]) / w,
      (e[1] * x + e[5] * y + e[9] * z + e[13]) / w,
      (e[2] * x + e[6] * y + e[10] * z + e[14]) / w,
    ];
    for (let axis = 0; axis < 3; axis++) {
      if (world[axis] < min[axis]) min[axis] = world[axis];
      if (world[axis] > max[axis]) max[axis] = world[axis];
    }
  }
});
console.log(`total: ${totalTris} tris`);

const view = new DataView(bytes);
const jsonLength = view.getUint32(12, true);
const gltf = JSON.parse(Buffer.from(bytes, 20, jsonLength).toString('utf-8'));
for (const [index, image] of (gltf.images ?? []).entries()) {
  const viewDef = gltf.bufferViews[image.bufferView];
  const binStart = 12 + 8 + jsonLength + 8 + (gltf.buffers[0].byteOffset ?? 0);
  const start = binStart + viewDef.byteOffset;
  const w = view.getUint32(start + 16, false);
  const h = view.getUint32(start + 20, false);
  console.log(`image ${index}: PNG ${w}x${h}, ${viewDef.byteLength} bytes`);
}

const sizeX = max[0] - min[0];
const sizeZ = max[2] - min[2];
const tolerance = 0.02;
const fits = sizeX <= 1 + tolerance && sizeZ <= 1 + tolerance;
console.log(
  `fit: x=${sizeX.toFixed(3)} z=${sizeZ.toFixed(3)} against 1 cell + ${tolerance} -> ${fits ? 'OK' : 'BREACH'}`,
);
const waterline = asset.anchor('waterline');
const deckTop = asset.anchor('deck_top');
const fireTop = asset.anchor('fire_top');
console.log(`derived: BOAT_WATERLINE_LIFT=${(-waterline.y).toFixed(3)}`);
console.log(
  `derived: BOAT_FIRE_COLUMN={ bottomY: ${deckTop.y.toFixed(3)}, height: ${(fireTop.y - deckTop.y).toFixed(3)} }`,
);
if (!fits) process.exitCode = 1;
asset.dispose();
