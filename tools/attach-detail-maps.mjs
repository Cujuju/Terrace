// attach-detail-maps.mjs — point every lit material of a .glb at one baked
// detail map set (tools/blender/bake_detail.py), leaving factors and geometry alone.
//
// All lit materials share the SAME three texture objects, so parts that differ
// only in colour still merge into one draw (client/src/render/rigSkin.ts keys
// merges on texture identity). Unlit materials are left untextured.
//
//   node tools/attach-detail-maps.mjs <in.glb> <maps-dir> <stem> <out.glb>
//   reads <maps-dir>/<stem>-{detail,normal,roughness}.png

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const ALIGN = 4;

const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
// The atlas keeps a gutter inside 0..1, so clamping never shows; repeat could
// bleed the opposite edge into a border island at low mips.
const CLAMP_TO_EDGE = 33071;

function readGlb(path) {
  const bytes = readFileSync(path);
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${path}: not a GLB`);
  const jsonLength = bytes.readUInt32LE(GLB_HEADER_BYTES);
  const jsonStart = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  const json = JSON.parse(bytes.subarray(jsonStart, jsonStart + jsonLength).toString('utf8'));
  const binHeader = jsonStart + jsonLength;
  const binLength = bytes.readUInt32LE(binHeader);
  const bin = bytes.subarray(binHeader + CHUNK_HEADER_BYTES, binHeader + CHUNK_HEADER_BYTES + binLength);
  return { json, bin };
}

function padded(buffer, fill) {
  const extra = (ALIGN - (buffer.length % ALIGN)) % ALIGN;
  return extra === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(extra, fill)]);
}

function writeGlb(path, json, bin) {
  const jsonChunk = padded(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = padded(bin, 0);
  const total = GLB_HEADER_BYTES + 2 * CHUNK_HEADER_BYTES + jsonChunk.length + binChunk.length;
  const header = Buffer.alloc(GLB_HEADER_BYTES);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(total, 8);
  const chunkHeader = (length, type) => {
    const h = Buffer.alloc(CHUNK_HEADER_BYTES);
    h.writeUInt32LE(length, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  writeFileSync(path, Buffer.concat([
    header, chunkHeader(jsonChunk.length, CHUNK_JSON), jsonChunk,
    chunkHeader(binChunk.length, CHUNK_BIN), binChunk,
  ]));
}

const [inPath, mapsDir, stem, outPath] = process.argv.slice(2);
if (outPath === undefined) {
  throw new Error('usage: attach-detail-maps.mjs <in.glb> <maps-dir> <stem> <out.glb>');
}

const { json, bin } = readGlb(inPath);
if ((json.images ?? []).length > 0 || (json.textures ?? []).length > 0) {
  throw new Error(`${inPath}: already carries textures — attach expects an untextured build`);
}

const pieces = [padded(Buffer.from(bin), 0)];
let offset = pieces[0].length;
json.bufferViews ??= [];
json.images = [];
json.samplers = [{ magFilter: LINEAR, minFilter: LINEAR_MIPMAP_LINEAR, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE }];
json.textures = [];
const textureOf = {};
for (const map of ['detail', 'normal', 'roughness']) {
  const png = padded(readFileSync(join(mapsDir, `${stem}-${map}.png`)), 0);
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: png.length });
  json.images.push({ name: `${stem}-${map}`, mimeType: 'image/png', bufferView: json.bufferViews.length - 1 });
  json.textures.push({ sampler: 0, source: json.images.length - 1, name: `${stem}-${map}` });
  textureOf[map] = json.textures.length - 1;
  pieces.push(png);
  offset += png.length;
}

let lit = 0;
for (const material of json.materials ?? []) {
  if (material.extensions?.KHR_materials_unlit !== undefined) continue;
  material.pbrMetallicRoughness ??= {};
  material.pbrMetallicRoughness.baseColorTexture = { index: textureOf.detail };
  material.pbrMetallicRoughness.metallicRoughnessTexture = { index: textureOf.roughness };
  material.normalTexture = { index: textureOf.normal };
  lit++;
}

const newBin = Buffer.concat(pieces);
json.buffers[0].byteLength = newBin.length;
writeGlb(outPath, json, newBin);
console.log(`${outPath}: ${lit} lit material(s) share ${json.textures.length} maps`);
