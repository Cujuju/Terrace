// Minimal dependency-free PNG codec: enough to read Chrome's screenshots and
// write the diff image. 8-bit RGB or RGBA, non-interlaced only.
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_RGBA = 4;
const BIT_DEPTH_8 = 8;
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;
const [FILTER_NONE, FILTER_SUB, FILTER_UP, FILTER_AVERAGE, FILTER_PAETH] = [0, 1, 2, 3, 4];

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (bytes) => {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

export function encodePng(width, height, rgba) {
  const stride = width * CHANNELS_RGBA;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = FILTER_NONE;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = BIT_DEPTH_8;
  header[9] = COLOR_TYPE_RGBA;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const paeth = (a, b, c) => {
  const [pa, pb, pc] = [Math.abs(b - c), Math.abs(a - c), Math.abs(a + b - 2 * c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      [width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)];
      channels = data[9] === COLOR_TYPE_RGB ? 3 : data[9] === COLOR_TYPE_RGBA ? CHANNELS_RGBA : 0;
      if (data[8] !== BIT_DEPTH_8 || channels === 0 || data[12] !== 0) {
        throw new Error(`PNG depth ${data[8]} / colour ${data[9]} / interlace ${data[12]} unsupported`);
      }
    } else if (type === 'IDAT') parts.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? lines[dst + i - channels] : 0;
      const b = y > 0 ? lines[dst - stride + i] : 0;
      const c = i >= channels && y > 0 ? lines[dst - stride + i - channels] : 0;
      if (filter > FILTER_PAETH) throw new Error(`PNG filter ${filter} unsupported`);
      const add = filter === FILTER_SUB ? a : filter === FILTER_UP ? b
        : filter === FILTER_AVERAGE ? (a + b) >> 1 : filter === FILTER_PAETH ? paeth(a, b, c) : 0;
      lines[dst + i] = (x + add) & 0xff;
    }
  }
  if (channels === CHANNELS_RGBA) return { width, height, rgba: new Uint8Array(lines) };
  const rgba = new Uint8Array(width * height * CHANNELS_RGBA);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = lines[p * 3];
    rgba[p * 4 + 1] = lines[p * 3 + 1];
    rgba[p * 4 + 2] = lines[p * 3 + 2];
    rgba[p * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
